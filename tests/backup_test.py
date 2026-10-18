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

OPS = Path(__file__).resolve().parents[1] / 'ops'
sys.path.insert(0, str(OPS))
spec = importlib.util.spec_from_file_location('backup', OPS / 'backup.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
BotData, BackupError = module.BotData, module.BackupError
LIBRARY = {'version': 2, 'guilds': {'1' * 18: {'settings': {}}}, 'favorites': {}, 'favoriteOverflow': {}}


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


def rows(path):
    with contextlib.closing(sqlite3.connect(path)) as db:
        return db.execute('SELECT track FROM plays ORDER BY id').fetchall()


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data, self.backups = self.root / 'data', self.root / 'backups'
        self.data.mkdir()
        (self.data / 'library.json').write_text(json.dumps(LIBRARY))
        # The running bot: WAL mode, nothing checkpointed into the main file yet.
        self.live = sqlite3.connect(self.data / 'stats.sqlite', isolation_level=None)
        self.live.execute('PRAGMA journal_mode = WAL')
        self.live.execute('PRAGMA wal_autocheckpoint = 0')
        self.live.execute('CREATE TABLE plays (id INTEGER PRIMARY KEY, track TEXT)')
        self.live.executemany('INSERT INTO plays (track) VALUES (?)', [('song-%d' % i,) for i in range(50)])
        self.now = 1_792_000_000
        self.docker = Docker(self.data)
        self.store = BotData(self.backups, runner=self.docker, clock=self.tick)

    def tearDown(self):
        self.live.close()
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
        self.assertEqual(sorted(p.name for p in copy.parent.iterdir()),
                         ['.backup-manifest.json', 'library.json', 'stats.sqlite'])
        # The bot keeps writing to its database afterwards.
        self.live.execute("INSERT INTO plays (track) VALUES ('after')")
        self.assertEqual(self.live.execute('SELECT count(*) FROM plays').fetchone(), (51,))

    def test_restore_drill_recovers_library_and_stats_and_keeps_damaged_state(self):
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(self.store.verify(name).keys(), {'library.json', 'stats.sqlite'})
        # Damage: newer rows only in the WAL and a library the bot would refuse.
        self.live.executemany('INSERT INTO plays (track) VALUES (?)', [('later',)] * 5)
        (self.data / 'library.json').write_text('{"version": 9')
        stale = (self.data / 'stats.sqlite-wal').read_bytes()
        self.live.close()
        (self.data / 'stats.sqlite-wal').write_bytes(stale)
        self.docker.running = True
        with self.assertRaisesRegex(BackupError, 'backup_restore_requires_stopped_bot'):
            self.store.restore(name, self.data)
        self.docker.running = False

        result = self.store.restore(name, self.data)

        self.assertEqual(json.loads((self.data / 'library.json').read_text()), LIBRARY)
        self.assertEqual(rows(self.data / 'stats.sqlite'), [('song-%d' % i,) for i in range(50)])
        self.assertFalse((self.data / 'stats.sqlite-wal').exists())
        retained = self.backups / result['pre_restore']
        self.assertEqual((retained / 'library.json').read_text(), '{"version": 9')
        self.assertEqual((retained / 'stats.sqlite-wal').read_bytes(), stale)

    def test_invalid_library_fails_without_rotating_out_good_backups(self):
        kept = [self.store.create(self.data, keep=2)['backup'] for _ in range(2)]
        (self.data / 'library.json').write_text('{"version": 2, "guilds": [}')
        with self.assertRaisesRegex(BackupError, 'backup_library_invalid'):
            self.store.create(self.data, keep=2)
        self.assertEqual(self.store.backups(), kept)
        self.assertEqual([p.name for p in self.backups.iterdir() if p.name.startswith('.partial')], [])

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

    def test_corrupt_stats_database_is_not_kept(self):
        self.live.close()
        for suffix in ('-wal', '-shm'):
            (self.data / ('stats.sqlite' + suffix)).unlink(missing_ok=True)
        (self.data / 'stats.sqlite').write_bytes(b'not a database' * 100)
        with self.assertRaisesRegex(BackupError, 'backup_stats_'):
            self.store.create(self.data, keep=14)
        self.assertEqual(self.store.backups(), [])

    def test_backup_of_stopped_bot_and_library_only_volume(self):
        self.live.close()
        self.assertFalse((self.data / 'stats.sqlite-wal').exists())
        name = self.store.create(self.data, keep=14)['backup']
        self.assertEqual(len(rows(self.backups / name / 'stats.sqlite')), 50)
        (self.data / 'stats.sqlite').unlink()
        for leftover in self.data.glob('stats.sqlite-*'):
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
