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
            return 'deployed'
        except Exception:
            if journal:
                self.rollback(journal)
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
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700); args.state_dir.chmod(0o700)
    import fcntl
    with open(LOCK, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'failed', 'error': 'portal_maintenance_lock_busy'})); raise SystemExit(1)
        deployer = PortalDeployer(args.repo, args.state_dir, env_file=args.env_file, portal_env=args.portal_env)
        try:
            status = deployer.deploy(args.sha, args.guild_id) if args.action == 'deploy' else deployer.rollback()
            print(json.dumps({'status': status, 'sha': args.sha}))
        except DeploymentError as error:
            print(json.dumps({'status': 'failed', 'error': str(error)})); raise SystemExit(1) from None
        except Exception:
            print(json.dumps({'status': 'failed', 'error': 'portal_unexpected_failure'})); raise SystemExit(1) from None


if __name__ == '__main__':
    main()
