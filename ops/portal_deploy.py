#!/usr/bin/env python3
"""Release prebuilt, CI-verified portal images without recreating audio services.

The operator verifies CI for the exact SHA before invoking this private driver.
The source archive and both image labels must identify that SHA. All output is
limited to public status codes. No environment values or command output is logged.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time

from deploy import Deployer, DeploymentError, IMAGE, LOCK, SHA, read, run, write

VOLUME = re.compile(r'^[a-z0-9][a-z0-9_.-]{0,127}$')
GUILD = re.compile(r'^\d{17,20}$')
AUDIO = ('warp', 'yt-cipher', 'lavalink')
# The 5-minute recovery check (vybertron-recovery.service, TimeoutStartSec=15min)
# and the nightly backup hold the same maintenance lock for a short while.
LOCK_TIMEOUT, LOCK_POLL = 900, 5
# Deploy unpacks each release's source into releases/<sha>. After a verified
# release, keep this many of the newest (the running one plus the previous ones
# a manual rollback or re-release might use) and anything a container still uses.
KEEP_RELEASES = 3
REVISION_LABEL = 'org.opencontainers.image.revision'
COMPOSE_LABELS = ('com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files')
CONTAINER_ID = re.compile(r'^[a-f0-9]{64}$')
# Exactly the name _prune_releases gives a release while removing it.
TOMBSTONE = re.compile(r'^\.pruning-[a-f0-9]{40}-\d{1,20}$')


class PruneSkipped(Exception):
    """What is in use can't be established exactly, so nothing is removed."""


class PortalDeployer(Deployer):
    def __init__(self, repo, directory, *, env_file, portal_env, runner=run, sleep=time.sleep):
        super().__init__(repo, directory, runner=runner, sleep=sleep)
        self.env_file, self.portal_env = env_file.resolve(), portal_env.resolve()
        self.journal_path = self.directory / 'portal-deployment.json'
        self.image_path = self.directory / 'portal-images.json'

    def save(self, journal):
        super().save(journal)
        # The existing recovery timer also recognizes this durable transaction.
        write(self.directory / 'deployment.json', json.dumps({
            'kind': 'portal', 'phase': journal['phase'],
            'target_sha': journal.get('target_sha'),
            'driver': 'portal-driver.py',
        }) + '\n')

    def compose(self, args, images, *, data=None):
        write(self.image_path, json.dumps({'services': {
            name: {'image': value} for name, value in images.items() if value
        }}))
        return self.command(['docker', 'compose', '--project-name', 'vybertron',
            '--env-file', str(self.env_file), '--env-file', str(self.portal_env),
            '-f', str(self.repo / 'docker-compose.yml'),
            '-f', str(self.repo / 'docker-compose.portal.yml'),
            '-f', str(self.image_path), '--profile', 'portal', *args],
            data=data, timeout=240)

    def inspect(self, name):
        value = json.loads(self.command(['docker', 'inspect', 'vybertron-' + name]))
        if not isinstance(value, list) or len(value) != 1:
            raise DeploymentError('portal_container_inspection_failed')
        return value[0]

    def audio_ids(self):
        return {name: self.inspect(name)['Id'] for name in AUDIO}

    def optional_container(self, name):
        expected = 'vybertron-' + name
        names = self.command(['docker', 'ps', '--all', '--filter',
            'name=^/' + expected + '$', '--format', '{{.Names}}']).splitlines()
        if not names:
            return None
        if names != [expected]:
            raise DeploymentError('portal_container_state_unknown')
        return self.inspect(name)

    def verify_volume_binding(self, volume, images):
        if not VOLUME.fullmatch(volume.get('name', '')):
            raise DeploymentError('portal_invalid_volume')
        info = json.loads(self.command(['docker', 'volume', 'inspect', volume['name']]))
        if len(info) != 1 or str(Path(info[0]['Mountpoint']).resolve()) != volume.get('path'):
            raise DeploymentError('portal_volume_identity_mismatch')
        config = json.loads(self.compose(['config', '--format', 'json'], images))
        mounts = [v for v in config.get('services', {}).get('bot', {}).get('volumes', [])
            if v.get('target') == '/app/data']
        if len(mounts) != 1 or mounts[0].get('type') != 'volume' or mounts[0].get('read_only'):
            raise DeploymentError('portal_bot_volume_not_persistent')
        configured = config.get('volumes', {}).get(mounts[0].get('source'), {}).get('name')
        if configured != volume['name']:
            raise DeploymentError('portal_compose_volume_identity_mismatch')

    def bot_volume(self):
        mounts = [m for m in self.inspect('bot')['Mounts'] if m['Destination'] == '/app/data']
        if len(mounts) != 1 or mounts[0]['Type'] != 'volume' or mounts[0].get('RW') is not True:
            raise DeploymentError('portal_bot_volume_not_persistent')
        mount = mounts[0]
        if not VOLUME.fullmatch(mount.get('Name', '')):
            raise DeploymentError('portal_invalid_volume')
        info = json.loads(self.command(['docker', 'volume', 'inspect', mount['Name']]))[0]
        if Path(info['Mountpoint']).resolve() != Path(mount['Source']).resolve():
            raise DeploymentError('portal_volume_identity_mismatch')
        return {'name': mount['Name'], 'path': str(Path(mount['Source']).resolve())}

    def verify_image(self, name, target):
        info = json.loads(self.command(['docker', 'image', 'inspect', name]))[0]
        if not IMAGE.fullmatch(info.get('Id', '')) or (
            info.get('Config', {}).get('Labels') or {}).get('org.opencontainers.image.revision') != target:
            raise DeploymentError('portal_prebuilt_image_identity_mismatch')
        return info['Id']

    def verify_inputs(self, target, guild_id):
        if not isinstance(target, str) or not SHA.fullmatch(target) or not GUILD.fullmatch(guild_id or ''):
            raise DeploymentError('portal_invalid_release_inputs')
        for path in (self.env_file, self.portal_env):
            if not path.is_file() or (os.name == 'posix' and path.stat().st_mode & 0o077):
                raise DeploymentError('portal_secret_file_requires_private_permissions')
        marker = read(self.repo / '.portal-release.json')
        if marker.get('revision') != target:
            raise DeploymentError('portal_source_identity_mismatch')
        old = read(self.directory / 'deployment.json')
        own = read(self.journal_path)
        if ((old and old.get('phase') not in ['complete', 'rolled_back']) or
            (own and own.get('phase') not in ['complete', 'rolled_back'])):
            raise DeploymentError('incomplete_deployment_requires_rollback')
        return {name: self.verify_image('vybertron-' + name + ':sha-' + target, target)
                for name in ('bot', 'portal')}

    @staticmethod
    def command_route(guild_id=None):
        # Global commands when no guild is given; GUILD guards the interpolated ID.
        if guild_id is not None and not GUILD.fullmatch(guild_id):
            raise DeploymentError('portal_invalid_release_inputs')
        return "'https://discord.com/api/v10/applications/'+process.env.CLIENT_ID+'" + ('/guilds/' + guild_id if guild_id else '') + "/commands'"

    def commands(self, guild_id=None):
        script = "const r=await fetch(" + self.command_route(guild_id) + ",{headers:{Authorization:'Bot '+process.env.DISCORD_BOT_TOKEN},signal:AbortSignal.timeout(10000)});if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()));"
        body = json.loads(self.command(['docker', 'exec', '-i', 'vybertron-bot',
            'node', '--input-type=module'], data=script, timeout=20))
        if not isinstance(body, list) or len(body) > 100:
            raise DeploymentError('portal_command_catalog_unavailable')
        keys = {'type', 'name', 'description', 'name_localizations', 'description_localizations',
                'options', 'default_member_permissions', 'dm_permission', 'nsfw'}
        return [{k: v for k, v in command.items() if k in keys} for command in body]

    def snapshot_data(self, volume, name):
        source, target = Path(volume['path']), self.directory / name
        if target.resolve().parent != self.directory or target.exists():
            raise DeploymentError('portal_invalid_backup_target')
        entries = list(source.rglob('*'))
        if len(entries) > 4096 or any(p.is_symlink() for p in entries):
            raise DeploymentError('portal_unsafe_data_volume')
        if sum(p.stat().st_size for p in entries if p.is_file()) > 64 * 1024 * 1024:
            raise DeploymentError('portal_data_backup_too_large')
        shutil.copytree(source, target)
        manifest = {}
        for path in target.rglob('*'):
            path.chmod(0o700 if path.is_dir() else 0o600)
            if path.is_file():
                relative = str(path.relative_to(target))
                original = source / relative
                stat = original.stat()
                manifest[relative] = {'uid': stat.st_uid, 'gid': stat.st_gid,
                    'mode': stat.st_mode & 0o777,
                    'size': stat.st_size, 'hash': hashlib.sha256(path.read_bytes()).hexdigest()}
        target.chmod(0o700)
        write(target / '.backup-manifest.json', json.dumps({'version': 1,
            'file_count': len(manifest), 'total_bytes': sum(m['size'] for m in manifest.values()),
            'files': manifest}))
        return name

    def restore_data(self, volume, name, expected_manifest_hash=None):
        backup = self.directory / name
        if backup.resolve().parent != self.directory or not backup.is_dir() or backup.is_symlink() or not name.startswith('portal-data-'):
            raise DeploymentError('portal_data_backup_unavailable')
        marker = backup / '.backup-manifest.json'
        if not marker.is_file() or marker.is_symlink():
            raise DeploymentError('portal_data_backup_manifest_unavailable')
        if expected_manifest_hash and hashlib.sha256(marker.read_bytes()).hexdigest() != expected_manifest_hash:
            raise DeploymentError('portal_data_backup_manifest_changed')
        envelope = read(marker)
        manifest = envelope.get('files')
        if (set(envelope) != {'version', 'file_count', 'total_bytes', 'files'} or
            envelope.get('version') != 1 or not isinstance(manifest, dict) or
            type(envelope.get('file_count')) is not int or envelope['file_count'] != len(manifest) or
            len(manifest) > 4096 or type(envelope.get('total_bytes')) is not int or
            not 0 <= envelope['total_bytes'] <= 64 * 1024 * 1024):
            raise DeploymentError('portal_data_backup_manifest_invalid')
        entries = list(backup.rglob('*'))
        if any(p.is_symlink() for p in entries) or {str(p.relative_to(backup)) for p in entries if p.is_file() and p != marker} != set(manifest):
            raise DeploymentError('portal_data_backup_incomplete')
        destination = Path(volume['path']).resolve()
        verified = []
        for relative, metadata in manifest.items():
            if (not isinstance(metadata, dict) or set(metadata) != {'uid', 'gid', 'mode', 'size', 'hash'} or
                any(type(metadata.get(key)) is not int or metadata[key] < 0 for key in ('uid', 'gid', 'mode', 'size')) or
                metadata['mode'] > 0o777 or metadata['size'] > 64 * 1024 * 1024 or
                not isinstance(metadata['hash'], str) or not re.fullmatch(r'[a-f0-9]{64}', metadata['hash'])):
                raise DeploymentError('portal_data_backup_manifest_invalid')
            source, target = (backup / relative).resolve(), (destination / relative).resolve()
            if Path(relative).is_absolute() or '..' in Path(relative).parts or backup.resolve() not in source.parents or destination not in target.parents:
                raise DeploymentError('portal_data_backup_path_invalid')
            if not source.is_file() or source.stat().st_size != metadata['size'] or hashlib.sha256(source.read_bytes()).hexdigest() != metadata['hash']:
                raise DeploymentError('portal_data_backup_hash_mismatch')
            verified.append((source, target, metadata))
        if sum(item[2]['size'] for item in verified) != envelope['total_bytes']:
            raise DeploymentError('portal_data_backup_manifest_invalid')
        current = list(destination.rglob('*'))
        if (len(current) > 4096 or any(p.is_symlink() for p in current) or
            sum(p.stat().st_size for p in current if p.is_file()) > 64 * 1024 * 1024):
            raise DeploymentError('portal_unsafe_data_volume')
        extras = [p for p in current if p.is_file() and str(p.relative_to(destination)) not in manifest]
        # Validate the whole backup before replacing even one music-data file.
        for source, target, metadata in verified:
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as output:
                    output.write(source.read_bytes()); output.flush(); os.fsync(output.fileno())
                os.chmod(temporary, metadata['mode'])
                if hasattr(os, 'chown'):
                    os.chown(temporary, metadata['uid'], metadata['gid'])
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        if any(hashlib.sha256(target.read_bytes()).hexdigest() != metadata['hash'] for _, target, metadata in verified):
            raise DeploymentError('portal_data_restore_hash_mismatch')
        # Original absence matters too: the old bot cannot open a newly created
        # v2 library. Quarantine candidate-only files privately, never delete them.
        # The caller already retained the entire newer volume before restoration.
        quarantine_name = None
        if extras:
            quarantine_name = 'portal-rollback-extras-' + str(time.time_ns())
            quarantine = self.directory / quarantine_name
            if quarantine.resolve().parent != self.directory or quarantine.exists():
                raise DeploymentError('portal_invalid_backup_target')
            quarantine.mkdir(mode=0o700)
            for source in extras:
                if source.is_symlink() or destination not in source.resolve().parents:
                    raise DeploymentError('portal_data_backup_path_invalid')
                target = quarantine / source.relative_to(destination)
                if quarantine.resolve() not in target.resolve().parents:
                    raise DeploymentError('portal_data_backup_path_invalid')
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                shutil.move(str(source), str(target)); target.chmod(0o600)
        if {str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()} != set(manifest):
            raise DeploymentError('portal_data_restore_inventory_mismatch')
        return quarantine_name

    def put_commands(self, body, images, guild_id=None):
        script = "const commands=" + json.dumps(body) + ";const r=await fetch(" + self.command_route(guild_id) + ",{method:'PUT',headers:{Authorization:'Bot '+process.env.DISCORD_BOT_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(commands),signal:AbortSignal.timeout(15000)});if(!r.ok)process.exit(1);"
        self.compose(['run', '-T', '--rm', '--no-deps', '--pull', 'never', 'bot',
            'node', '--input-type=module'], images, data=script)

    def restore_commands(self, journal):
        # Version-1 backups hold only the guild catalog; version 2 adds global.
        backup = read(self.directory / journal['commands_backup'])
        guild_body, global_body = backup.get('commands'), backup.get('global')
        if not isinstance(guild_body, list) or ('global' in backup and not isinstance(global_body, list)):
            raise DeploymentError('portal_command_backup_unavailable')
        if isinstance(global_body, list):
            self.put_commands(global_body, journal['previous_images'])
        self.put_commands(guild_body, journal['previous_images'], journal['guild_id'])

    def verify_running(self, selected, journal):
        if self.audio_ids() != journal['audio_ids'] or self.bot_volume() != journal['volume']:
            raise DeploymentError('portal_audio_or_volume_identity_changed')
        for name in ('bot', 'portal'):
            if self.inspect(name)['Image'] != selected[name]:
                raise DeploymentError('portal_running_image_identity_mismatch')
        script = "const r=await fetch(process.env.PORTAL_BOT_URL+'/health',{headers:{Authorization:'Bearer '+process.env.PORTAL_BRIDGE_TOKEN},signal:AbortSignal.timeout(5000)});const b=await r.json();if(!r.ok||b.ready!==true)process.exit(1);"
        self.command(['docker', 'exec', '-i', 'vybertron-portal', 'node', '--input-type=module'],
                     data=script, timeout=10)

    def deploy(self, target, guild_id):
        self.prune_result = None
        status = self.release(target, guild_id)
        if status == 'deployed':
            # Only after verify_running passed. Pruning never fails a release.
            self.prune_result = self.prune_releases(self.released_journal)
        return status

    def referenced_paths(self):
        """Every host path any container (running or stopped) uses.

        Raises PruneSkipped unless Docker answered for exactly the listed
        containers with every field the reference check reads.
        """
        try:
            ids = self.command(['docker', 'ps', '--all', '--quiet', '--no-trunc']).split()
            if not all(CONTAINER_ID.fullmatch(value) for value in ids) or len(set(ids)) != len(ids):
                raise PruneSkipped('container_state_unknown')
            containers = json.loads(self.command(['docker', 'inspect', *ids])) if ids else []
        except (DeploymentError, ValueError):
            raise PruneSkipped('container_state_unknown') from None
        if (not isinstance(containers, list) or len(containers) != len(ids)
                or not all(isinstance(item, dict) for item in containers)
                or sorted(str(item.get('Id')) for item in containers) != sorted(ids)):
            raise PruneSkipped('container_state_unknown')
        paths = []
        for container in containers:
            mounts, config = container.get('Mounts'), container.get('Config')
            if not isinstance(mounts, list) or not isinstance(config, dict) or 'Labels' not in config:
                raise PruneSkipped('container_state_unknown')
            for mount in mounts:
                source = mount.get('Source') if isinstance(mount, dict) else None
                if not isinstance(mount, dict) or not isinstance(mount.get('Type'), str) or not isinstance(source, str):
                    raise PruneSkipped('container_state_unknown')
                if not source and mount['Type'] == 'tmpfs':
                    continue  # A tmpfs has no host path.
                paths.append(source)
            labels = config['Labels']
            if labels is None:
                continue  # Docker reports no labels as null.
            if not isinstance(labels, dict):
                raise PruneSkipped('container_state_unknown')
            for key in COMPOSE_LABELS:
                value = labels.get(key)
                if value is None:
                    continue
                if not isinstance(value, str):
                    raise PruneSkipped('container_state_unknown')
                paths.extend(value.split(','))
        # Every reference must be a usable absolute path; anything else is doubt.
        if not all(value and os.path.isabs(value) and '\0' not in value for value in paths):
            raise PruneSkipped('container_state_unknown')
        return set(paths)

    def image_revision(self, image):
        """The exact revision an image was built from, or PruneSkipped."""
        if not isinstance(image, str) or not IMAGE.fullmatch(image):
            raise PruneSkipped('rollback_revision_unknown')
        try:
            info = json.loads(self.command(['docker', 'image', 'inspect', image]))
        except (DeploymentError, ValueError):
            raise PruneSkipped('rollback_revision_unknown') from None
        if (not isinstance(info, list) or len(info) != 1 or not isinstance(info[0], dict)
                or info[0].get('Id') != image or not isinstance(info[0].get('Config'), dict)
                or not isinstance(info[0]['Config'].get('Labels'), dict)):
            raise PruneSkipped('rollback_revision_unknown')
        revision = info[0]['Config']['Labels'].get(REVISION_LABEL)
        if not isinstance(revision, str) or not SHA.fullmatch(revision):
            raise PruneSkipped('rollback_revision_unknown')
        return revision

    def prune_releases(self, journal, keep=KEEP_RELEASES):
        """Remove old releases/<sha> source directories. Returns a status, never raises.

        Pruning is optional housekeeping: whenever what is in use can't be
        established exactly, it removes nothing and reports why.
        """
        try:
            return self._prune_releases(journal, keep)
        except PruneSkipped as skipped:
            return {'status': 'skipped', 'reason': str(skipped)}
        except Exception as error:
            code = str(error) if isinstance(error, DeploymentError) else type(error).__name__
            return {'status': 'failed', 'error': code}

    def _prune_releases(self, journal, keep):
        root = self.repo.parent
        # Only the Deploy layout (…/releases/<sha>). A manual release from a
        # checkout such as /root/Vybertron has no sibling releases to manage.
        if root.name != 'releases' or not SHA.fullmatch(self.repo.name) or root.is_symlink():
            return {'status': 'skipped', 'reason': 'not_a_release_directory'}
        resolved = root.resolve(strict=True)
        protected = {self.repo.name}
        # The rollback target: the releases whose images ran before this one.
        # The bot always ran; a portal image is absent only on the first
        # portal release. Any other doubt about either revision skips pruning.
        previous = journal.get('previous_images') if isinstance(journal, dict) else None
        if not isinstance(previous, dict) or previous.get('bot') is None:
            raise PruneSkipped('rollback_revision_unknown')
        for name in ('bot', 'portal'):
            if name == 'portal' and previous.get('portal') is None:
                continue
            protected.add(self.image_revision(previous.get(name)))
        roots = {Path(os.path.abspath(root)), resolved}
        referenced = set()
        for value in self.referenced_paths():
            for path in {Path(os.path.abspath(value)), Path(os.path.realpath(value))}:
                for base in roots:
                    if base == path or base.is_relative_to(path):
                        # A mount of releases/ or above reaches every release.
                        raise PruneSkipped('container_mounts_releases_directory')
                    if path.is_relative_to(base):
                        referenced.add(path.relative_to(base).parts[0])
        # The just-verified bot and portal were composed from this directory.
        # If no container says so, the references aren't what this code expects.
        if self.repo.name not in referenced:
            raise PruneSkipped('current_release_not_in_use')
        protected |= referenced
        releases, tombstones = [], []
        for entry in resolved.iterdir():
            # Skip anything Deploy or this pruning did not create: in-progress
            # *.tmp staging, symlinks (which could point outside), plain files.
            if entry.is_symlink() or not entry.is_dir():
                continue
            if TOMBSTONE.fullmatch(entry.name):
                tombstones.append(entry)
                continue
            if not SHA.fullmatch(entry.name):
                continue
            try:
                releases.append((entry.lstat().st_mtime, entry))
            except FileNotFoundError:
                continue
        releases.sort(key=lambda item: (item[0], item[1].name), reverse=True)
        protected.update(entry.name for _, entry in releases[:keep])
        removed, failed = [], []
        for _, entry in releases:
            if entry.name in protected:
                continue
            # Rename first, so an interrupted removal never leaves a partial
            # releases/<sha> that a later Deploy of that SHA would trust.
            target = resolved / ('.pruning-' + entry.name + '-' + str(time.time_ns()))
            try:
                self.remove_inside(resolved, entry, rename_to=target)
                removed.append(entry.name)
            except Exception:
                failed.append(entry.name)
        for entry in tombstones:
            if entry.name in protected:
                continue  # A container still uses this leftover; keep it.
            with contextlib.suppress(Exception):
                self.remove_inside(resolved, entry)
        result = {'status': 'failed' if failed else 'ok', 'kept': sorted(protected & {e.name for _, e in releases}),
                  'removed': sorted(removed)}
        if failed:
            result['error'] = 'portal_prune_remove_failed'
            result['failed'] = sorted(failed)
        return result

    @staticmethod
    def remove_inside(root, entry, rename_to=None):
        if entry.is_symlink() or not entry.is_dir() or entry.resolve(strict=True).parent != root:
            raise DeploymentError('portal_prune_path_outside_releases')
        if rename_to is not None:
            os.rename(entry, rename_to)
            entry = rename_to
        # rmtree removes symlinks inside the tree without following them.
        shutil.rmtree(entry)

    def release(self, target, guild_id):
        candidate = self.verify_inputs(target, guild_id)
        images = self.images()
        portal = self.optional_container('portal')
        images['portal'] = portal['Image'] if portal else None
        if images['portal'] is not None and not IMAGE.fullmatch(images['portal']):
            raise DeploymentError('portal_invalid_previous_image')
        self.compose(['config', '--quiet'], {**images, **candidate})
        self.begin()
        journal = None
        try:
            old_journal = read(self.directory / 'deployment.json')
            if old_journal:
                write(self.directory / ('portal-previous-deployment-' + target + '.json'), json.dumps(old_journal))
            transaction = target + '-' + str(time.time_ns())
            catalog = 'portal-commands-' + transaction + '.json'
            # Back up both catalogs: releases register globally and clear the
            # test guild's legacy guild-scoped copy, so neither shows twice.
            write(self.directory / catalog, json.dumps({'version': 2, 'commands': self.commands(guild_id),
                                                        'global': self.commands()}))
            journal = {'kind': 'portal', 'phase': 'prepared', 'target_sha': target,
                'transaction_id': transaction,
                'repo': str(self.repo), 'guild_id': guild_id, 'previous_images': images,
                'planned_images': candidate,
                'audio_ids': self.audio_ids(), 'volume': self.bot_volume(),
                'commands_backup': catalog, 'services_changed': False,
                'commands_attempted': False, 'data_may_have_changed': False,
                'rollback_attempts': 0, 'prepared_at': time.time()}
            self.save(journal)
            self.begin()  # Fresh lease immediately before any service replacement.
            selected = {**images, **candidate}
            self.verify_volume_binding(journal['volume'], selected)
            journal.update(phase='releasing', services_changed=True); self.save(journal)
            if images['portal']:
                self.compose(['stop', '-t', '15', 'portal'], selected)
            self.compose(['stop', '-t', '30', 'bot'], selected)
            journal['data_backup'] = self.snapshot_data(journal['volume'], 'portal-data-' + transaction)
            journal['data_backup_manifest_sha256'] = hashlib.sha256((self.directory / journal['data_backup'] / '.backup-manifest.json').read_bytes()).hexdigest()
            self.save(journal)
            journal['commands_attempted'] = True; self.save(journal)
            self.compose(['run', '-T', '--rm', '--no-deps', '--pull', 'never',
                'bot', 'node', 'deploy-commands.js', 'global'], selected)
            self.put_commands([], selected, guild_id)
            journal['data_may_have_changed'] = True; self.save(journal)
            self.start_bot(selected)
            self.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                '--force-recreate', '--wait', '--wait-timeout', '90', 'portal'], selected)
            self.verify_running(selected, journal)
            journal.update(phase='complete', released_at=time.time(), released_images=candidate)
            self.save(journal)
            self.released_journal = journal
            return 'deployed'
        except Exception:
            if journal:
                try:
                    self.rollback(journal)
                except DeploymentError as error:
                    # Deploy retries 'deployment_waiting_for_idle' as "nothing changed yet"; a release
                    # that changed services and now waits on a listener to roll back is a failure.
                    if str(error) == 'deployment_waiting_for_idle':
                        raise DeploymentError('portal_failed_rollback_waiting_for_idle') from None
                    raise
                raise DeploymentError('portal_failed_previous_release_restored') from None
            raise
        finally:
            with contextlib.suppress(DeploymentError):
                self.maintenance('end')

    def rollback(self, journal=None):
        journal = journal or read(self.journal_path)
        if not journal or journal.get('phase') == 'rolled_back':
            return 'nothing_to_rollback'
        if journal.get('kind') != 'portal' or journal.get('repo') != str(self.repo):
            raise DeploymentError('portal_invalid_rollback_journal')
        if journal.get('rollback_attempts', 0) >= 2:
            raise DeploymentError('portal_rollback_requires_attention')
        previous = journal['previous_images']
        if not all(IMAGE.fullmatch(previous.get(name, '')) for name in ('bot', *AUDIO)):
            raise DeploymentError('portal_invalid_rollback_images')
        planned = journal.get('planned_images', {})
        if not all(isinstance(planned.get(name), str) and IMAGE.fullmatch(planned[name]) for name in ('bot', 'portal')):
            raise DeploymentError('portal_invalid_rollback_images')
        containers = {name: self.optional_container(name) for name in ('bot', 'portal')}
        if any(container and container.get('Image') not in {previous.get(name), planned[name]}
               for name, container in containers.items()):
            raise DeploymentError('portal_rollback_external_image_changed')
        self.verify_volume_binding(journal['volume'], previous)
        if self.audio_ids() != journal['audio_ids'] or (containers['bot'] and self.bot_volume() != journal['volume']):
            raise DeploymentError('portal_rollback_external_state_changed')
        if journal.get('services_changed'):
            if containers['bot'] and containers['bot']['State']['Running']:
                self.begin()  # A newly active or paused queue prevents rollback.
            journal['rollback_attempts'] += 1; journal['phase'] = 'rolling_back'; self.save(journal)
            try:
                with contextlib.suppress(DeploymentError):
                    self.compose(['stop', '-t', '15', 'portal'], previous)
                if containers['bot']:
                    self.compose(['stop', '-t', '30', 'bot'], previous)
                if journal.get('data_may_have_changed'):
                    name = 'portal-failed-data-' + journal['transaction_id'] + '-' + str(journal['rollback_attempts'])
                    journal['failed_data_backup'] = self.snapshot_data(journal['volume'], name)
                    self.save(journal)
                    digest = journal.get('data_backup_manifest_sha256')
                    if not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest):
                        raise DeploymentError('portal_data_backup_manifest_unavailable')
                    extras = self.restore_data(journal['volume'], journal['data_backup'], digest)
                    if extras:
                        journal.setdefault('quarantined_data', []).append(extras); self.save(journal)
                if journal.get('commands_attempted'):
                    self.restore_commands(journal)
                self.start_bot(previous)
                if previous.get('portal'):
                    self.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never',
                        '--force-recreate', '--wait', '--wait-timeout', '90', 'portal'], previous)
                else:
                    self.compose(['rm', '--stop', '--force', 'portal'], previous)
                if self.audio_ids() != journal['audio_ids'] or self.bot_volume() != journal['volume']:
                    raise DeploymentError('portal_rollback_identity_mismatch')
                if self.inspect('bot')['Image'] != previous['bot'] or (previous.get('portal') and self.inspect('portal')['Image'] != previous['portal']):
                    raise DeploymentError('portal_rollback_image_identity_mismatch')
            except Exception:
                journal['phase'] = 'rollback_failed'; self.save(journal)
                raise DeploymentError('portal_rollback_failed') from None
        journal['phase'] = 'rolled_back'; self.save(journal)
        with contextlib.suppress(DeploymentError):
            self.maintenance('end')
        return 'rolled_back'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy', 'rollback'])
    parser.add_argument('--sha')
    parser.add_argument('--guild-id')
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/vybertron-recovery'))
    parser.add_argument('--env-file', type=Path, default=Path('/root/Vybertron/.env'))
    parser.add_argument('--portal-env', type=Path, default=Path('/var/lib/vybertron-portal/portal.env'))
    parser.add_argument('--lock-timeout', type=float, default=LOCK_TIMEOUT)
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700); args.state_dir.chmod(0o700)
    import fcntl
    with open(LOCK, 'a') as lock:
        # Wait out a recovery check or backup instead of failing the release.
        # Nothing has changed yet, and deploy() re-checks for listeners once it holds the lock.
        deadline = time.monotonic() + args.lock_timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    print(json.dumps({'status': 'failed', 'error': 'portal_maintenance_lock_busy'})); raise SystemExit(1) from None
                time.sleep(LOCK_POLL)
        deployer = PortalDeployer(args.repo, args.state_dir, env_file=args.env_file, portal_env=args.portal_env)
        try:
            status = deployer.deploy(args.sha, args.guild_id) if args.action == 'deploy' else deployer.rollback()
            output = {'status': status, 'sha': args.sha}
            prune = getattr(deployer, 'prune_result', None)
            if prune:
                output['prune'] = prune
            print(json.dumps(output))
        except DeploymentError as error:
            print(json.dumps({'status': 'failed', 'error': str(error)})); raise SystemExit(1) from None
        except Exception:
            print(json.dumps({'status': 'failed', 'error': 'portal_unexpected_failure'})); raise SystemExit(1) from None


if __name__ == '__main__':
    main()
