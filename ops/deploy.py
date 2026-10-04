#!/usr/bin/env python3
"""Deploy an exact CI-tested commit, preserving audio images and rollback state.

The caller supplies a full commit SHA from a successful main-branch CI run.
No token, environment dump, signed media URL, or subprocess output is logged.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

SHA = re.compile(r'^[a-f0-9]{40}$')
IMAGE = re.compile(r'^sha256:[a-f0-9]{64}$')
SERVICES = ['warp', 'yt-cipher', 'lavalink', 'bot']
LOCK = '/run/lock/vybertron-maintenance.lock'


class DeploymentError(Exception):
    """Only public error codes are emitted."""


def run(args, *, data=None, timeout=60, cwd=None):
    try:
        result = subprocess.run(args, input=data, capture_output=True, text=True,
                                timeout=timeout, cwd=cwd, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise DeploymentError('deployment_command_unavailable') from None
    if result.returncode:
        raise DeploymentError('deployment_command_failed')
    return result.stdout.strip()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as output:
            output.write(value)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read(path):
    if not path.exists():
        return {}
    try:
        if path.stat().st_size > 1024 * 1024:
            raise ValueError()
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, OSError):
        raise DeploymentError('deployment_journal_unavailable') from None


class Deployer:
    def __init__(self, repo, directory, runner=run, probe=None, sleep=time.sleep):
        self.repo, self.directory, self.runner = repo.resolve(), directory.resolve(), runner
        self.probe_hook, self.sleep = probe, sleep
        self.journal_path = self.directory / 'deployment.json'
        self.image_path = self.directory / 'deployment-images.json'

    def command(self, args, **kwargs):
        return self.runner(args, cwd=self.repo, **kwargs)

    def save(self, journal):
        write(self.journal_path, json.dumps(journal, indent=2) + '\n')

    def compose(self, args, images):
        write(self.image_path, json.dumps({'services': {name: {'image': value} for name, value in images.items()}}))
        return self.command(['docker', 'compose', '-f', str(self.repo / 'docker-compose.yml'),
                             '-f', str(self.image_path), *args], timeout=900 if args[0] == 'build' else 240)

    def images(self):
        values = {name: self.command(['docker', 'inspect', '--format', '{{.Image}}', 'vybertron-' + name])
                  for name in SERVICES}
        if not all(IMAGE.fullmatch(value) for value in values.values()):
            raise DeploymentError('invalid_deployed_images')
        return values

    def maintenance(self, action):
        script = "const r=await fetch('http://127.0.0.1:'+(Number(process.env.VYBERTRON_HEALTH_PORT)||3000)+'/maintenance/" + action + "',{method:'POST',signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()));"
        try:
            value = json.loads(self.command(['docker', 'exec', '-i', 'vybertron-bot', 'node', '--input-type=module'], data=script, timeout=10))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, DeploymentError):
            raise DeploymentError('deployment_idle_check_unavailable') from None

    def begin(self):
        for _ in range(10):
            status = self.maintenance('begin')
            if status.get('busy') is True:
                self.maintenance('end')
                raise DeploymentError('deployment_waiting_for_idle')
            if status.get('active') is True and status.get('busy') is False and status.get('inFlight') == 0:
                return
            self.sleep(1)
        with contextlib.suppress(DeploymentError):
            self.maintenance('end')
        raise DeploymentError('deployment_waiting_for_requests')

    def restore_pin(self):
        self.command(['python3', 'ops/recovery.py', 'restore-pin'], timeout=30)

    def probe(self, full):
        if self.probe_hook:
            return self.probe_hook(full)
        try:
            spec = importlib.util.spec_from_file_location('vybertron_deploy_probe', self.repo / 'ops/recovery.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            backend = module.Backend(self.repo, self.directory, {})
            result = backend.probe(backend.current(), full=full, installed=True)
            if result.get('ok') is not True or len(result.get('tracks', [])) != 2:
                raise DeploymentError('deployment_audio_probe_failed')
            for track in result['tracks']:
                if track.get('ok') is not True or track.get('frames', 0) < 250:
                    raise DeploymentError('deployment_audio_probe_failed')
                if full and (track.get('ended') != 'FINISHED' or track.get('positionMs', 0) < track.get('durationMs', 0) - 2000):
                    raise DeploymentError('deployment_audio_probe_incomplete')
        except DeploymentError:
            raise
        except Exception:
            raise DeploymentError('deployment_audio_probe_unavailable') from None

    def register_commands(self, images):
        # Uses the exact release image. No running gateway/voice connection is
        # needed for command registration, and failures stop the release.
        self.compose(['run', '--rm', '--no-deps', '--pull', 'never', 'bot', 'node', 'deploy-commands.js'], images)

    def start_audio(self, images, namespace=True):
        if namespace:
            self.compose(['stop', '-t', '30', 'bot', 'lavalink', 'yt-cipher'], images)
            self.compose(['up', '-d', '--no-build', '--pull', 'never', '--force-recreate', '--wait',
                          '--wait-timeout', '150', 'warp', 'yt-cipher', 'lavalink'], images)
        else:
            self.compose(['stop', '-t', '30', 'bot'], images)
            self.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate',
                          '--wait', '--wait-timeout', '120', 'lavalink'], images)

    def start_bot(self, images):
        self.compose(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', '--force-recreate',
                      '--wait', '--wait-timeout', '120', 'bot'], images)

    def rollback(self, journal=None):
        journal = journal or read(self.journal_path)
        if not journal or journal.get('phase') in ['complete', 'rolled_back']:
            return 'nothing_to_rollback'
        if journal.get('rollback_attempts', 0) >= 2:
            raise DeploymentError('deployment_rollback_requires_attention')
        images, old = journal.get('previous_images', {}), journal.get('previous_sha', '')
        backup = self.directory / str(journal.get('config_backup', ''))
        if (not SHA.fullmatch(old) or set(images) != set(SERVICES)
                or not all(isinstance(value, str) and IMAGE.fullmatch(value) for value in images.values())
                or backup.resolve().parent != self.directory or not backup.name.startswith('deployment-config-')):
            raise DeploymentError('invalid_deployment_rollback')
        # If a new bot is already online, confirm it has no active/paused/queued
        # session before restoring an older version. Unavailable containers are
        # already down and can be recovered from the durable journal.
        services_changed = journal.get('services_changed', True)
        if services_changed:
            running = self.command(['docker', 'inspect', '--format', '{{.State.Running}}', 'vybertron-bot'])
            if running not in ['true', 'false']:
                raise DeploymentError('deployment_rollback_bot_state_unknown')
            if running == 'true':
                self.begin()
        journal['rollback_attempts'] = journal.get('rollback_attempts', 0) + 1
        journal['phase'] = 'rolling_back'
        self.save(journal)
        try:
            self.command(['git', 'reset', '--hard', old])
            write(self.repo / 'lavalink/application.yml', backup.read_bytes().decode('utf-8'))
            # Config is read by the unprivileged Lavalink user.
            os.chmod(self.repo / 'lavalink/application.yml', 0o644)
            recovery_state = read(self.directory / 'state.json')
            if journal.get('previous_runtime_override'):
                recovery_state['override'] = journal['previous_runtime_override']
            else:
                recovery_state.pop('override', None)
            write(self.directory / 'state.json', json.dumps(recovery_state, indent=2) + '\n')
            if not services_changed:
                # A failed/slow build may outlive the maintenance lease. Restore
                # files only: the previous bot/audio are still serving music.
                journal['phase'] = 'rolled_back'
                self.save(journal)
                with contextlib.suppress(DeploymentError):
                    self.maintenance('end')
                return 'rolled_back'
            self.start_audio(images)
            self.probe(False)
            if journal.get('commands_attempted'):
                self.register_commands(images)
            self.start_bot(images)
            if self.images() != images:
                raise DeploymentError('deployment_rollback_image_mismatch')
            journal['phase'] = 'rolled_back'
            self.save(journal)
            with contextlib.suppress(DeploymentError):
                self.maintenance('end')
            return 'rolled_back'
        except Exception:
            journal['phase'] = 'rollback_failed'
            self.save(journal)
            raise DeploymentError('deployment_rollback_failed') from None

    def deploy(self, target):
        if not isinstance(target, str) or not SHA.fullmatch(target):
            raise DeploymentError('invalid_deployment_sha')
        existing = read(self.journal_path)
        if existing and existing.get('phase') not in ['complete', 'rolled_back']:
            raise DeploymentError('incomplete_deployment_requires_rollback')
        self.command(['git', 'fetch', '--no-tags', 'origin', 'main'])
        self.command(['git', 'cat-file', '-e', target + '^{commit}'])
        self.command(['git', 'merge-base', '--is-ancestor', target, 'origin/main'])
        previous = self.command(['git', 'rev-parse', 'HEAD'])
        if not SHA.fullmatch(previous):
            raise DeploymentError('invalid_current_commit')
        if previous != target:
            try:
                self.command(['git', 'merge-base', '--is-ancestor', target, previous])
            except DeploymentError:
                pass
            else:
                return 'skipped_older_ci_run'
        dirty = self.command(['git', 'diff', '--name-only', 'HEAD']).splitlines()
        if any(name != 'lavalink/application.yml' for name in dirty):
            raise DeploymentError('deployment_local_changes_require_attention')
        self.restore_pin()
        self.begin()
        journal = None
        try:
            images = self.images()
            original = (self.repo / 'lavalink/application.yml').read_bytes().decode('utf-8')
            backup = 'deployment-config-' + previous + '.yml'
            write(self.directory / backup, original)
            journal = {'phase': 'prepared', 'target_sha': target, 'previous_sha': previous,
                       'previous_images': images, 'config_backup': backup,
                       'prepared_at': time.time(), 'commands_attempted': False,
                       'services_changed': False,
                       'previous_runtime_override': read(self.directory / 'state.json').get('override')}
            self.save(journal)  # Durable before changing Git or running services.
            self.command(['git', 'reset', '--hard', target])
            self.restore_pin()
            release = 'vybertron-bot:sha-' + target
            self.command(['docker', 'build', '--label', 'org.opencontainers.image.revision=' + target,
                          '-t', release, '.'], timeout=900)
            release_id = self.command(['docker', 'image', 'inspect', '--format', '{{.Id}}', release])
            if not IMAGE.fullmatch(release_id):
                raise DeploymentError('invalid_release_image')
            selected = {**images, 'bot': release_id}
            self.compose(['config', '--quiet'], selected)
            changed = self.command(['git', 'diff', '--name-only', previous, target, '--',
                                    'warp/', 'docker-compose.yml']).splitlines()
            audio_changed = hashlib.sha256(original.encode()).digest() != hashlib.sha256((self.repo / 'lavalink/application.yml').read_bytes()).digest()
            # Building can consume the full maintenance lease. Reacquire and
            # recheck idle immediately before any running service is changed.
            self.begin()
            journal['phase'] = 'releasing'
            journal['services_changed'] = True
            self.save(journal)
            if changed:
                self.start_audio(selected)
            elif audio_changed:
                self.start_audio(selected, namespace=False)
            else:
                self.compose(['stop', '-t', '30', 'bot'], selected)
            self.probe(True)
            journal['commands_attempted'] = True
            self.save(journal)
            self.register_commands(selected)
            journal['phase'] = 'starting_bot'
            self.save(journal)
            self.start_bot(selected)
            journal['phase'] = 'bot_started'
            self.save(journal)
            if self.images() != selected or self.command(['git', 'rev-parse', 'HEAD']) != target:
                raise DeploymentError('deployment_release_identity_mismatch')
            journal.update(phase='complete', released_at=time.time(), bot_image=release_id)
            self.save(journal)
            with contextlib.suppress(DeploymentError):
                self.maintenance('end')
            return 'deployed'
        except Exception:
            if journal:
                self.rollback(journal)
                raise DeploymentError('deployment_failed_previous_release_restored') from None
            raise
        finally:
            with contextlib.suppress(DeploymentError):
                self.maintenance('end')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy', 'rollback'])
    parser.add_argument('sha', nargs='?')
    parser.add_argument('--repo', type=Path, default=Path.cwd())
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/vybertron-recovery'))
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(args.state_dir, 0o700)
    import fcntl  # VPS only. The policy is importable for tests on other hosts.
    with open(LOCK, 'a') as lock:
        deadline = time.monotonic() + 600
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    print(json.dumps({'status': 'failed', 'error': 'deployment_lock_timeout'}))
                    raise SystemExit(1) from None
                time.sleep(1)
        deployer = Deployer(args.repo, args.state_dir)
        try:
            status = deployer.deploy(args.sha) if args.action == 'deploy' else deployer.rollback()
            print(json.dumps({'status': status, 'sha': args.sha}))
        except DeploymentError as error:
            print(json.dumps({'status': 'failed', 'error': str(error)}))
            raise SystemExit(1) from None
        except Exception:
            print(json.dumps({'status': 'failed', 'error': 'deployment_unexpected_failure'}))
            raise SystemExit(1) from None


if __name__ == '__main__':
    main()
