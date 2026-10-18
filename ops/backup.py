#!/usr/bin/env python3
"""Back up and restore the bot's music data (`bot-data`) while the bot runs.

The SQLite stores (play statistics and listening state) are copied with SQLite's
online backup API, never as raw files of a live WAL database. The bot replaces
library.json and operator-alerts.json atomically, so plain copies are consistent. Each backup is verified before it is kept and before it is restored.
Output is limited to status codes, backup names and counts; file contents,
paths inside the volume and environment values are never logged.
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time

from deploy import DeploymentError, LOCK, read, run, write

LIBRARY, MANIFEST = 'library.json', '.backup-manifest.json'
# Every durable file the bot keeps in bot-data (src/utils, src/operator-alerts.js).
DATABASES = ('stats.sqlite', 'listening-state.sqlite')
COPIED = (LIBRARY, 'operator-alerts.json', 'library.json.pre-listening-state.bak')
LEGACY = re.compile(r'^library\.json\.v1\.[0-9a-f-]{36}\.bak$')
NAME = re.compile(r'^bot-data-\d{8}T\d{6}Z$')
VOLUME = re.compile(r'^[a-z0-9][a-z0-9_.-]{0,127}$')
SIDECARS = ('-wal', '-shm', '-journal')
MAX_BYTES = 64 * 1024 * 1024
SNAPSHOT_ATTEMPTS = 3
LIBRARY_BYTES = 5 * 1024 * 1024


class BackupError(Exception):
    """Only public error codes are emitted."""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sync(path):
    with open(path, 'r+b') as handle:  # Windows cannot fsync a read-only handle.
        os.fsync(handle.fileno())


def is_root():
    return hasattr(os, 'geteuid') and os.geteuid() == 0


def connect_ro(path, timeout=5):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=timeout)


def check_library(path):
    try:
        if path.stat().st_size > LIBRARY_BYTES:
            raise ValueError()
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise BackupError('backup_library_invalid') from None
    if not library_shape(value):
        raise BackupError('backup_library_invalid')


def library_shape(value):
    """The document and server structure the bot requires (src/utils/library.js
    validateDocument). Field-level rules stay with the bot, which only ever writes
    documents that pass them."""
    if not isinstance(value, dict) or type(value.get('version')) is not int or value['version'] not in (1, 2):
        return False
    legacy, guilds = value['version'] == 1, value.get('guilds')
    lists = lambda item: isinstance(item, dict) and all(isinstance(v, list) for v in item.values())  # noqa: E731
    if not isinstance(guilds, dict) or (not legacy and not (lists(value.get('favorites')) and
                                                            lists(value.get('favoriteOverflow')))):
        return False
    for guild in guilds.values():
        if not isinstance(guild, dict) or not isinstance(guild.get('settings'), dict) or not isinstance(guild.get('mixes'), dict):
            return False
        if legacy and not lists(guild.get('favorites')):
            return False
        if not legacy and not (isinstance(guild.get('history'), list) and isinstance(guild.get('activity'), list)
                               and 'favorites' not in guild):
            return False
    return True


def durable(name):
    return name in DATABASES or name in COPIED or bool(LEGACY.fullmatch(name))


def check_database(path):
    try:
        with contextlib.closing(connect_ro(path)) as db:
            result = db.execute('PRAGMA integrity_check').fetchall()
    except sqlite3.Error:
        raise BackupError('backup_database_invalid') from None
    if result != [('ok',)]:
        raise BackupError('backup_database_invalid')


def copy_database(source, target):
    """Consistent snapshot of a live WAL database, including uncheckpointed pages."""
    try:
        # As root, SQLite gives any sidecar it creates the database file's owner
        # and mode, so the bot can still open the live database afterwards.
        with contextlib.closing(connect_ro(source, timeout=30)) as live, \
                contextlib.closing(sqlite3.connect(target)) as copy:
            live.backup(copy)
            # A self-contained single file: no -wal/-shm beside the backup.
            copy.execute('PRAGMA journal_mode = DELETE')
    except sqlite3.Error:
        raise BackupError('backup_database_copy_failed') from None


class BotData:
    def __init__(self, backup_dir, runner=run, clock=time.time):
        self.backup_dir, self.runner, self.clock = backup_dir.resolve(), runner, clock

    def command(self, args):
        try:
            return self.runner(args)
        except DeploymentError:
            raise BackupError('backup_docker_unavailable') from None

    def volume_path(self, volume):
        if not VOLUME.fullmatch(volume or ''):
            raise BackupError('backup_invalid_volume')
        try:
            info = json.loads(self.command(['docker', 'volume', 'inspect', volume]))
            path = Path(info[0]['Mountpoint'])
        except (ValueError, LookupError, TypeError):
            raise BackupError('backup_volume_unavailable') from None
        if len(info) != 1:
            raise BackupError('backup_volume_unavailable')
        return path

    def bot_running(self):
        names = self.command(['docker', 'ps', '--filter', 'name=^/vybertron-bot$', '--format', '{{.Names}}'])
        return bool(names.strip())

    def stamp(self):
        return datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')

    def prepare(self):
        self.backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.backup_dir.chmod(0o700)

    @staticmethod
    def sources(data):
        if not data.is_dir() or data.is_symlink():
            raise BackupError('backup_data_unavailable')
        names = [p.name for p in data.iterdir() if durable(p.name)]
        if any((data / name).is_symlink() or not (data / name).is_file() for name in names):
            raise BackupError('backup_unsafe_data_volume')
        if not {LIBRARY, *DATABASES} & set(names):
            raise BackupError('backup_no_data')
        return sorted(names)

    def create(self, data, keep):
        data = data.resolve()
        self.prepare()
        name = 'bot-data-' + self.stamp()
        final, partial = self.backup_dir / name, self.backup_dir / ('.partial-' + name)
        if final.exists():
            raise BackupError('backup_already_exists')
        # An interrupted earlier run never becomes a backup or counts toward retention.
        for stale in self.backup_dir.glob('.partial-bot-data-*'):
            if stale.is_dir() and not stale.is_symlink():
                shutil.rmtree(stale)
        for _ in range(SNAPSHOT_ATTEMPTS):
            names = self.sources(data)
            partial.mkdir(mode=0o700)
            try:
                files = self.snapshot(data, partial, names)
                if files is None:
                    shutil.rmtree(partial)
                    continue
                total = sum(item['size'] for item in files.values())
                if total > MAX_BYTES:
                    raise BackupError('backup_too_large')
                write(partial / MANIFEST, json.dumps({'version': 1, 'file_count': len(files),
                                                      'total_bytes': total, 'files': files}))
                os.rename(partial, final)
                break
            except BaseException:
                shutil.rmtree(partial, ignore_errors=True)
                raise
        else:
            raise BackupError('backup_source_changed')
        return {'backup': name, 'files': len(files), 'bytes': total, 'removed': self.prune(keep)}

    @staticmethod
    def snapshot(data, partial, names):
        """Copies one consistent generation, or returns None if the library changed.

        library.json goes first. Its listening-state mirror must not be older than
        the store's mirror digests, or the bot adopts the stale mirror on restart
        and replaces the backed-up checkpoint (src/utils/listening-state.js adopt).
        The bot renames library.json before it records new digests, so a library
        that is unchanged after the databases are copied is never the older side.
        """
        files = {}
        for entry in sorted(names, key=lambda n: n != LIBRARY):
            source, target = data / entry, partial / entry
            stat = source.stat()
            if entry in DATABASES:
                copy_database(source, target)
                check_database(target)
            else:
                shutil.copyfile(source, target)
                if entry == LIBRARY:
                    check_library(target)
            target.chmod(0o600)
            sync(target)
            files[entry] = {'uid': stat.st_uid, 'gid': stat.st_gid, 'mode': stat.st_mode & 0o777,
                            'size': target.stat().st_size, 'hash': digest(target)}
        if LIBRARY in files:
            try:
                if digest(data / LIBRARY) != files[LIBRARY]['hash']:
                    return None
            except FileNotFoundError:
                return None
        return files

    def backups(self):
        if not self.backup_dir.is_dir():
            return []
        return sorted(p.name for p in self.backup_dir.iterdir()
                      if NAME.fullmatch(p.name) and p.is_dir() and not p.is_symlink())

    def prune(self, keep):
        # Only runs after a verified backup, so a failing source never rotates out good copies.
        removed = self.backups()[:-keep]
        for name in removed:
            shutil.rmtree(self.backup_dir / name)
        return len(removed)

    def verify(self, name):
        backup = self.backup_dir / (name or '')
        if not NAME.fullmatch(name or '') or not backup.is_dir() or backup.is_symlink():
            raise BackupError('backup_unavailable')
        marker = backup / MANIFEST
        if not marker.is_file() or marker.is_symlink():
            raise BackupError('backup_manifest_unavailable')
        try:
            envelope = read(marker)
        except DeploymentError:
            raise BackupError('backup_manifest_invalid') from None
        files = envelope.get('files')
        if (set(envelope) != {'version', 'file_count', 'total_bytes', 'files'} or envelope['version'] != 1 or
                not isinstance(files, dict) or envelope['file_count'] != len(files) or
                not all(durable(n) for n in files) or
                type(envelope['total_bytes']) is not int or not 0 <= envelope['total_bytes'] <= MAX_BYTES):
            raise BackupError('backup_manifest_invalid')
        present = {p.name for p in backup.iterdir() if p.name != MANIFEST}
        if present != set(files) or any((backup / n).is_symlink() or not (backup / n).is_file() for n in present):
            raise BackupError('backup_incomplete')
        for entry, meta in files.items():
            if (not isinstance(meta, dict) or set(meta) != {'uid', 'gid', 'mode', 'size', 'hash'} or
                    any(type(meta[k]) is not int or meta[k] < 0 for k in ('uid', 'gid', 'mode', 'size')) or
                    meta['mode'] > 0o777 or not isinstance(meta['hash'], str) or
                    not re.fullmatch(r'[a-f0-9]{64}', meta['hash'])):
                raise BackupError('backup_manifest_invalid')
            path = backup / entry
            if path.stat().st_size != meta['size'] or digest(path) != meta['hash']:
                raise BackupError('backup_hash_mismatch')
        if sum(meta['size'] for meta in files.values()) != envelope['total_bytes']:
            raise BackupError('backup_manifest_invalid')
        if LIBRARY in files:
            check_library(backup / LIBRARY)
        for entry in DATABASES:
            if entry in files:
                check_database(backup / entry)
        return files

    def restore(self, name, data):
        files = self.verify(name)
        if self.bot_running():
            raise BackupError('backup_restore_requires_stopped_bot')
        data = data.resolve()
        if not data.is_dir() or data.is_symlink():
            raise BackupError('backup_data_unavailable')
        current = [p for p in data.iterdir()]
        if any(p.is_symlink() or not p.is_file() for p in current):
            raise BackupError('backup_unsafe_data_volume')
        # Keep everything currently in the volume, including WAL sidecars, before changing it.
        self.prepare()
        kept = 'pre-restore-' + self.stamp()
        retained = self.backup_dir / kept
        if retained.exists():
            raise BackupError('backup_already_exists')
        retained.mkdir(mode=0o700)
        for path in current:
            shutil.copy2(path, retained / path.name)
            (retained / path.name).chmod(0o600)
        backup = self.backup_dir / name
        # Stage every replacement durably first: a failure here (e.g. a full disk)
        # leaves the volume, including any WAL with committed rows, untouched.
        staged = []
        try:
            for entry, meta in files.items():
                fd, temporary = tempfile.mkstemp(dir=data)
                staged.append((temporary, entry))
                with os.fdopen(fd, 'wb') as output:
                    output.write((backup / entry).read_bytes())
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(temporary, meta['mode'])
                if is_root():
                    os.chown(temporary, meta['uid'], meta['gid'])
        except BaseException:
            for temporary, _ in staged:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(temporary)
            raise
        # The volume returns to the backup's moment: durable files it didn't have
        # yet go (they're retained above), so the bot rebuilds listening state
        # from library.json as after a rollback. A stale WAL from a replaced or
        # removed database would corrupt the restored one, so sidecars go too.
        for path in current:
            if durable(path.name) and path.name not in files:
                path.unlink()
        for entry in DATABASES:
            for suffix in SIDECARS:
                with contextlib.suppress(FileNotFoundError):
                    (data / (entry + suffix)).unlink()
        for temporary, entry in staged:
            os.replace(temporary, data / entry)
        if any(digest(data / entry) != meta['hash'] for entry, meta in files.items()):
            raise BackupError('backup_restore_hash_mismatch')
        return {'restored': name, 'files': len(files), 'pre_restore': kept}


@contextlib.contextmanager
def maintenance_lock(timeout):
    import fcntl  # VPS only; unit tests import this module on Windows.
    with open(LOCK, 'a') as lock:
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise BackupError('backup_maintenance_lock_busy') from None
                time.sleep(5)
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'list', 'verify', 'restore'])
    parser.add_argument('--name', help='backup to verify or restore, e.g. bot-data-20261017T043000Z')
    parser.add_argument('--backup-dir', type=Path, default=Path('/var/lib/vybertron-backups'))
    parser.add_argument('--volume', default='vybertron_bot-data')
    parser.add_argument('--data-dir', type=Path, help='use this directory instead of the Docker volume')
    parser.add_argument('--keep', type=int, default=14, choices=range(1, 366), metavar='1-365')
    parser.add_argument('--lock-timeout', type=int, default=1800)
    args = parser.parse_args()
    os.umask(0o077)
    store = BotData(args.backup_dir)
    try:
        if args.action == 'list':
            result = {'backups': store.backups()}
        elif args.action == 'verify':
            result = {'verified': args.name, 'files': len(store.verify(args.name))}
        else:
            with maintenance_lock(args.lock_timeout):
                data = args.data_dir or store.volume_path(args.volume)
                result = (store.create(data, args.keep) if args.action == 'backup'
                          else store.restore(args.name, data))
        print(json.dumps({'status': 'ok', **result}))
    except BackupError as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        raise SystemExit(1) from None
    except Exception:
        print(json.dumps({'status': 'failed', 'error': 'backup_unexpected_failure'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
