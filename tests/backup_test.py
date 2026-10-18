import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

OPS = Path(__file__).resolve().parents[1] / 'ops'
sys.path.insert(0, str(OPS))
spec = importlib.util.spec_from_file_location('backup', OPS / 'backup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
BotData, BackupError = module.BotData, module.BackupError
# A document the bot opens (src/utils/library.js validateDocument).
LIBRARY = {'version': 2, 'favorites': {}, 'favoriteOverflow': {}, 'guilds': {'1' * 18: {
    'settings': {'volume': 80, 'fairQueue': False, 'djRoleId': None, 'musicTextChannelId': None},
    'mixes': {}, 'session': None, 'history': [], 'activity': []}}}


class Docker:
    def __init__(self, volume=None):
        self.volume, self.running, self.calls = volume, False, []

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if args[:3] == ['docker', 'volume', 'inspect']:
            return json.dumps([{'Mountpoint': str(self.volume)}])
        if args[:2] == ['docker', 'ps']:
            return 'vybertron-bot' if self.running else ''
        raise AssertionError(args)


def rows(path, table='plays'):
    with contextlib.closing(sqlite3.connect(path)) as db:
        return db.execute('SELECT track FROM %s ORDER BY id' % table).fetchall()


def live_store(path, table, count):
    """A database the running bot holds open: WAL mode, nothing checkpointed yet."""
    db = sqlite3.connect(path, isolation_level=None)
    db.execute('PRAGMA journal_mode = WAL')
    db.execute('PRAGMA wal_autocheckpoint = 0')
    db.execute('CREATE TABLE %s (id INTEGER PRIMARY KEY, track TEXT)' % table)
    db.executemany('INSERT INTO %s (track) VALUES (?)' % table, [('song-%d' % i,) for i in range(count)])
    return db


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data, self.backups = self.root / 'data', self.root / 'backups'
        self.data.mkdir()
        (self.data / 'library.json').write_text(json.dumps(LIBRARY))
        (self.data / 'operator-alerts.json').write_text('{"version":1,"muted":[]}')
        (self.data / 'library.json.pre-listening-state.bak').write_text(json.dumps(LIBRARY))
        self.live = live_store(self.data / 'stats.sqlite', 'plays', 50)
        self.state = live_store(self.data / 'listening-state.sqlite', 'history', 20)
        self.now = 1_792_000_000
        self.docker = Docker(self.data)
        self.store = BotData(self.backups, runner=self.docker, clock=self.tick)

    def tearDown(self):
        self.live.close()
        self.state.close()
        self.temp.cleanup()

    def tick(self):
        self.now += 86400
        return self.now

    def test_live_backup_includes_uncommitted_wal_pages_a_raw_copy_misses(self):
        self.assertGreater((self.data / 'stats.sqlite-wal').stat().st_size, 0)
        result = self.store.create(self.data, keep=14)
        copy = self.backups / result['backup'] / 'stats.sqlite'
        self.assertEqual(len(rows(copy)), 50)
        raw = self.root / 'raw.sqlite'
        shutil.copyfile(self.data / 'stats.sqlite', raw)
        with self.assertRaises(sqlite3.OperationalError):
            rows(raw)
        self.assertEqual(len(rows(copy.parent / 'listening-state.sqlite', 'history')), 20)
        self.assertEqual(sorted(p.name for p in copy.parent.iterdir()),
                         ['.backup-manifest.json', 'library.json', 'library.json.pre-listening-state.bak',
                          'listening-state.sqlite', 'operator-alerts.json', 'stats.sqlite'])
        # The bot keeps writing to its database afterwards.
        self.live.execute("INSERT INTO plays (track) VALUES ('after')")
        self.assertEqual(self.live.execute('SELECT count(*) FROM plays').fetchone(), (51,))

    def test_restore_drill_recovers_library_and_stats_and_keeps_damaged_state(self):
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(self.store.verify(name).keys(), {'library.json', 'stats.sqlite', 'listening-state.sqlite',
                                                          'operator-alerts.json', 'library.json.pre-listening-state.bak'})
        # Damage: newer rows only in the WAL and a library the bot would refuse.
        self.live.executemany('INSERT INTO plays (track) VALUES (?)', [('later',)] * 5)
        self.state.executemany('INSERT INTO history (track) VALUES (?)', [('later',)] * 3)
        (self.data / 'library.json').write_text('{"version": 9')
        stale = (self.data / 'stats.sqlite-wal').read_bytes()
        stale_state = (self.data / 'listening-state.sqlite-wal').read_bytes()
        self.live.close()
        self.state.close()
        (self.data / 'stats.sqlite-wal').write_bytes(stale)
        (self.data / 'listening-state.sqlite-wal').write_bytes(stale_state)
        self.docker.running = True
        with self.assertRaisesRegex(BackupError, 'backup_restore_requires_stopped_bot'):
            self.store.restore(name, self.data)
        self.docker.running = False

        result = self.store.restore(name, self.data)

        self.assertEqual(json.loads((self.data / 'library.json').read_text()), LIBRARY)
        self.assertEqual(rows(self.data / 'stats.sqlite'), [('song-%d' % i,) for i in range(50)])
        self.assertEqual(rows(self.data / 'listening-state.sqlite', 'history'), [('song-%d' % i,) for i in range(20)])
        self.assertFalse((self.data / 'stats.sqlite-wal').exists())
        self.assertFalse((self.data / 'listening-state.sqlite-wal').exists())
        retained = self.backups / result['pre_restore']
        self.assertEqual((retained / 'library.json').read_text(), '{"version": 9')
        self.assertEqual((retained / 'stats.sqlite-wal').read_bytes(), stale)

    def test_restore_removes_durable_files_newer_than_the_backup(self):
        # A backup from before the listening-state store existed (PR #79).
        self.live.close()
        self.state.close()
        moved = self.root / 'later'
        moved.mkdir()
        for path in self.data.glob('listening-state.sqlite*'):
            path.rename(moved / path.name)
        name = self.store.create(self.data, keep=14)['backup']
        for path in moved.iterdir():
            path.rename(self.data / path.name)
        (self.data / 'listening-state.sqlite-wal').write_bytes(b'newer wal')
        (self.data / 'library.json.0f0e.tmp').write_text('unrelated')

        result = self.store.restore(name, self.data)

        self.assertEqual(sorted(p.name for p in self.data.glob('listening-state.sqlite*')), [])
        self.assertTrue((self.data / 'library.json.0f0e.tmp').exists())
        retained = self.backups / result['pre_restore']
        self.assertEqual(len(rows(retained / 'listening-state.sqlite', 'history')), 20)

    def test_library_rewritten_during_the_snapshot_is_copied_again(self):
        # The bot refreshes the library mirror and records new digests in the store
        # while the backup is between library.json and listening-state.sqlite.
        refreshed = {**LIBRARY, 'favorites': {'2' * 18: []}}
        real, changes = module.copy_database, []

        def refresh_once(source, target):
            if source.name == 'listening-state.sqlite' and not changes:
                changes.append(1)
                (self.data / 'library.json').write_text(json.dumps(refreshed))
            return real(source, target)
        with mock.patch.object(module, 'copy_database', refresh_once):
            name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(json.loads((self.backups / name / 'library.json').read_text()), refreshed)

        def always_refresh(source, target):
            (self.data / 'library.json').write_text(json.dumps({**refreshed, 'n': len(changes)}))
            changes.append(1)
            return real(source, target)
        with mock.patch.object(module, 'copy_database', always_refresh), \
                self.assertRaisesRegex(BackupError, 'backup_source_changed'):
            self.store.create(self.data, keep=14)
        self.assertEqual(self.store.backups(), [name])
        self.assertEqual([p.name for p in self.backups.iterdir() if p.name.startswith('.partial')], [])

    def test_failed_restore_leaves_the_volume_and_its_wal_untouched(self):
        name = self.store.create(self.data, keep=14)['backup']
        self.live.executemany('INSERT INTO plays (track) VALUES (?)', [('later',)] * 5)
        (self.data / 'library.json').write_text(json.dumps({**LIBRARY, 'favorites': {'2' * 18: []}}))
        # A bot that crashed before checkpointing: committed rows exist only in the WAL.
        self.state.close()
        crashed = {p.name: p.read_bytes() for p in self.data.iterdir() if p.name != 'stats.sqlite-shm'}
        self.live.close()
        for path in self.data.glob('stats.sqlite*'):
            path.unlink()
        for entry, content in crashed.items():
            (self.data / entry).write_bytes(content)
        before = {p.name: p.read_bytes() for p in self.data.iterdir()}
        real, calls = module.tempfile.mkstemp, []

        def full_disk(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise OSError(28, 'No space left on device')
            return real(*args, **kwargs)
        with mock.patch.object(module.tempfile, 'mkstemp', full_disk), self.assertRaises(OSError):
            self.store.restore(name, self.data)
        self.assertEqual({p.name: p.read_bytes() for p in self.data.iterdir()}, before)
        self.assertEqual(len(rows(self.data / 'stats.sqlite')), 55)

    def test_invalid_library_fails_without_rotating_out_good_backups(self):
        kept = [self.store.create(self.data, keep=2)['backup'] for _ in range(2)]
        (self.data / 'library.json').write_text('{"version": 2, "guilds": [}')
        with self.assertRaisesRegex(BackupError, 'backup_library_invalid'):
            self.store.create(self.data, keep=2)
        self.assertEqual(self.store.backups(), kept)
        self.assertEqual([p.name for p in self.backups.iterdir() if p.name.startswith('.partial')], [])

    def test_library_the_bot_would_refuse_is_not_backed_up(self):
        guild = LIBRARY['guilds']['1' * 18]
        for document in ({'version': 2, 'guilds': {}},
                         {**LIBRARY, 'guilds': {'1' * 18: {**guild, 'history': None}}},
                         {'version': 1, 'guilds': {'1' * 18: {'settings': {}, 'mixes': {}}}}):
            (self.data / 'library.json').write_text(json.dumps(document))
            with self.assertRaisesRegex(BackupError, 'backup_library_invalid'):
                self.store.create(self.data, keep=14)
        (self.data / 'library.json').write_text(json.dumps(
            {'version': 1, 'guilds': {'1' * 18: {'settings': {}, 'mixes': {}, 'favorites': {}}}}))
        self.store.create(self.data, keep=14)

    def test_retention_keeps_only_the_newest_backups(self):
        names = [self.store.create(self.data, keep=2)['backup'] for _ in range(4)]
        self.assertEqual(self.store.backups(), names[-2:])

    def test_tampered_backup_is_rejected_before_touching_the_volume(self):
        name = self.store.create(self.data, keep=14)['backup']
        copy = self.backups / name / 'library.json'
        copy.write_text(copy.read_text().replace('guilds', 'guildz'))
        with self.assertRaisesRegex(BackupError, 'backup_hash_mismatch'):
            self.store.restore(name, self.data)
        self.assertEqual(json.loads((self.data / 'library.json').read_text()), LIBRARY)
        self.assertEqual(self.docker.calls, [])
        with self.assertRaisesRegex(BackupError, 'backup_unavailable'):
            self.store.verify('../data')

    def test_corrupt_database_is_not_kept(self):
        self.state.close()
        for suffix in ('-wal', '-shm'):
            (self.data / ('listening-state.sqlite' + suffix)).unlink(missing_ok=True)
        (self.data / 'listening-state.sqlite').write_bytes(b'not a database' * 100)
        with self.assertRaisesRegex(BackupError, 'backup_database_'):
            self.store.create(self.data, keep=14)
        self.assertEqual(self.store.backups(), [])

    def test_backup_of_stopped_bot_and_library_only_volume(self):
        self.live.close()
        self.state.close()
        self.assertFalse((self.data / 'stats.sqlite-wal').exists())
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(len(rows(self.backups / name / 'stats.sqlite')), 50)
        for leftover in [*self.data.glob('*.sqlite*'), *self.data.glob('*alerts*'), *self.data.glob('*.bak')]:
            leftover.unlink()
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(self.store.verify(name).keys(), {'library.json'})

    def test_volume_is_resolved_through_docker(self):
        self.assertEqual(self.store.volume_path('vybertron_bot-data'), self.data)
        with self.assertRaisesRegex(BackupError, 'backup_invalid_volume'):
            self.store.volume_path('../etc')

    @unittest.skipUnless(os.name == 'posix', 'POSIX permissions')
    def test_backups_are_private(self):
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(self.backups.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.backups / name).stat().st_mode & 0o777, 0o700)
        for path in (self.backups / name).iterdir():
            self.assertEqual(path.stat().st_mode & 0o777, 0o600, path.name)


if __name__ == '__main__':
    unittest.main()
