#!/usr/bin/env python3
"""VPS-only playback checks, bounded recovery, and verified YouTube updates.

Only official releases/main commits with published Maven jars are candidates.
Probes use isolated containers without Discord credentials or voice connections.
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
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parent.parent
STATE_DIR = Path('/var/lib/vybertron-recovery')
LOCK = '/run/lock/vybertron-maintenance.lock'
JDK = 'eclipse-temurin:17-jdk@sha256:36d9a76dc231587873b103c68a789b85d91b41d314dda69730d6bc43a777f2a9'
GITHUB = 'https://api.github.com/repos/lavalink-devs/youtube-source'
MAVEN = 'https://maven.lavalink.dev'
# One broadly available short video plus a complete music track. The original
# incident video intermittently has regional restrictions on WARP's egress.
TRACKS = ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=2SUwOgmvzK4']
VERSION = re.compile(r'^[a-f0-9]{40}$|^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$')
DEPENDENCY = re.compile(r'dev\.lavalink\.youtube:youtube-plugin:([A-Za-z0-9.-]+)')
UPDATE_INTERVAL = 6 * 3600
RECOVERY_COOLDOWN = 30 * 60
RECOVERY_WINDOW = 6 * 3600
MAX_OUTBOX = 32
MAX_ALERTS_PER_RUN = 5


class RecoveryError(Exception):
    """Only public, credential-free error codes are used as messages."""


def command(args, *, data=None, timeout=30, cwd=None):
    try:
        result = subprocess.run(args, input=data, text=True, capture_output=True,
                                timeout=timeout, cwd=cwd, check=False)
    except subprocess.TimeoutExpired:
        raise RecoveryError('command_timeout') from None
    if result.returncode:
        # Docker inspection and Java errors may contain credentials/signed URLs.
        raise RecoveryError('command_failed')
    return result.stdout.strip()


def read_json(path, default=None):
    if not path.exists():
        return default if default is not None else {}
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            raise RecoveryError('state_too_large')
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise RecoveryError('invalid_state')
        return value
    except (ValueError, OSError):
        raise RecoveryError('state_unavailable') from None


def validate_settings(settings):
    if not isinstance(settings, dict) or not isinstance(settings.get('auto_update', False), bool):
        raise RecoveryError('invalid_monitor_settings')
    guild, channel = settings.get('discord_guild_id'), settings.get('discord_channel_id')
    if guild or channel:
        if not all(isinstance(value, str) and re.fullmatch(r'\d{17,20}', value) for value in [guild, channel]):
            raise RecoveryError('invalid_alert_destination')
    return settings


def probe_result(value):
    """Validate decoder evidence and retain only credential-free diagnostics."""
    if (not isinstance(value, dict) or not isinstance(value.get('ok'), bool)
            or not isinstance(value.get('searchOk'), bool)
            or not isinstance(value.get('tracks'), list) or not 1 <= len(value['tracks']) <= 10):
        raise RecoveryError('invalid_probe_response')
    categories = {'audio', 'source', 'credentials', 'unavailable', 'network', 'timeout', 'incomplete', 'probe_environment'}
    endings = {'running', 'FINISHED', 'LOAD_FAILED', 'STOPPED', 'REPLACED', 'CLEANUP'}
    tracks = []
    for track in value['tracks']:
        if (not isinstance(track, dict) or not isinstance(track.get('ok'), bool)
                or track.get('category') not in categories):
            raise RecoveryError('invalid_probe_response')
        clean = {'ok': track['ok'], 'category': track['category']}
        for key in ['frames', 'positionMs', 'durationMs']:
            if key in track:
                if type(track[key]) is not int or not 0 <= track[key] <= 10 ** 12:
                    raise RecoveryError('invalid_probe_response')
                clean[key] = track[key]
        if 'ended' in track:
            if track['ended'] not in endings:
                raise RecoveryError('invalid_probe_response')
            clean['ended'] = track['ended']
        tracks.append(clean)
    if value['ok'] != (value['searchOk'] and all(track['ok'] for track in tracks)):
        raise RecoveryError('invalid_probe_response')
    return {'ok': value['ok'], 'searchOk': value['searchOk'], 'tracks': tracks}


def atomic_write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_json(path, value):
    atomic_write(path, json.dumps(value, indent=2) + '\n')


def trim_probe_cache(cache, active):
    # Each bundle contains the server libraries; bound disk growth after updates.
    root = cache.resolve()
    older = sorted((item for item in cache.iterdir()
                    if re.fullmatch(r'[a-f0-9]{24}', item.name) and item != active
                    and item.is_dir() and not item.is_symlink()),
                   key=lambda item: item.stat().st_mtime, reverse=True)
    for item in older[2:]:
        if item.resolve().parent != root:
            raise RecoveryError('invalid_probe_cache_path')
        shutil.rmtree(item)


def version_of(config):
    matches = DEPENDENCY.findall(config)
    if len(matches) != 1 or not VERSION.fullmatch(matches[0]):
        raise RecoveryError('unsupported_youtube_configuration')
    return matches[0]


def pin_config(config, version):
    if not VERSION.fullmatch(version):
        raise RecoveryError('invalid_plugin_version')
    version_of(config)
    snapshot = bool(re.fullmatch(r'[a-f0-9]{40}', version))
    # Change only the YouTube plugin block, preserving other plugins/settings.
    lines = config.splitlines(keepends=True)
    index = next(i for i, line in enumerate(lines) if DEPENDENCY.search(line))
    lines[index] = DEPENDENCY.sub('dev.lavalink.youtube:youtube-plugin:' + version, lines[index])
    changed = set()
    for i in range(index + 1, len(lines)):
        if re.match(r'\s*- dependency:|\s{2}server:', lines[i]):
            break
        if re.match(r'\s+repository:', lines[i]):
            indent = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
            lines[i] = f'{indent}repository: "{MAVEN}/{"snapshots" if snapshot else "releases"}"\n'
            changed.add('repository')
        elif re.match(r'\s+snapshot:', lines[i]):
            indent = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
            lines[i] = f'{indent}snapshot: {str(snapshot).lower()}\n'
            changed.add('snapshot')
    if changed != {'repository', 'snapshot'}:
        raise RecoveryError('unsupported_youtube_configuration')
    return ''.join(lines)


def public_json(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'Vybertron-Recovery/1.0', 'Accept': 'application/vnd.github+json'})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.loads(response.read(2 * 1024 * 1024))
            if not isinstance(value, dict):
                raise ValueError()
            return value
    except (urllib.error.URLError, ValueError):
        raise RecoveryError('upstream_metadata_unavailable') from None


class Backend:
    def __init__(self, repo, directory, settings):
        self.repo, self.directory, self.settings = repo, directory, validate_settings(settings)
        self.config_path = repo / 'lavalink/application.yml'
        self.containers = {}

    def inspect(self):
        names = ['vybertron-warp', 'vybertron-lavalink', 'vybertron-yt-cipher', 'vybertron-bot']
        values = json.loads(command(['docker', 'inspect', *names]))
        self.containers = {item['Name'].lstrip('/'): item for item in values}
        return self.containers

    def observe(self):
        containers = self.inspect()
        running = all(item['State']['Status'] == 'running' for item in containers.values())
        if not running:
            return {'kind': 'stopped', 'playing': None}
        namespaces = {os.readlink(f"/proc/{containers[name]['State']['Pid']}/ns/net")
                      for name in ['vybertron-warp', 'vybertron-lavalink', 'vybertron-yt-cipher']}
        if len(namespaces) != 1:
            return {'kind': 'namespace', 'playing': None}
        if containers['vybertron-warp']['State'].get('Health', {}).get('Status') != 'healthy':
            return {'kind': 'network', 'playing': None}
        script = """
const headers={Authorization:process.env.LAVALINK_PASSWORD};
const healthBase='http://127.0.0.1:'+(Number(process.env.VYBERTRON_HEALTH_PORT)||3000);
async function read(url, auth=true) {
 try { const r=await fetch(url,{headers:auth?headers:{},signal:AbortSignal.timeout(6000)}); return r.ok?await r.json():null; }
 catch { return null; }
}
const [stats,info,health,search,playback]=await Promise.all([
 read('http://lavalink:2333/v4/stats'), read('http://lavalink:2333/v4/info'),
 read(healthBase+'/health',false),
 read('http://lavalink:2333/v4/loadtracks?identifier=ytsearch%3Aloser%20tame%20impala'),
 read(healthBase+'/playback',false)]);
console.log(JSON.stringify({api:!!stats,bot:health?.ready===true,playing:stats?.playingPlayers??null,
 version:info?.plugins?.find(p=>p.name==='youtube-plugin')?.version,
 search:search?.loadType==='search'&&search.data?.length>0,failures:playback?.failures??[]}));
"""
        result = json.loads(command(['docker', 'exec', '-i', 'vybertron-bot', 'node', '--input-type=module'], data=script, timeout=20))
        result['kind'] = 'audio_service' if not result['api'] else 'bot' if not result['bot'] else 'ready'
        return result

    def current(self):
        return version_of(self.config_path.read_text())

    def artifact(self, version):
        if not VERSION.fullmatch(version):
            raise RecoveryError('invalid_plugin_version')
        artifacts = self.directory / 'artifacts'
        artifacts.mkdir(parents=True, exist_ok=True)
        path = artifacts / f'youtube-plugin-{version}.jar'
        if not path.exists():
            repository = 'snapshots' if re.fullmatch(r'[a-f0-9]{40}', version) else 'releases'
            url = f'{MAVEN}/{repository}/dev/lavalink/youtube/youtube-plugin/{version}/youtube-plugin-{version}.jar'
            try:
                metadata = f'{MAVEN}/{repository}/dev/lavalink/youtube/youtube-plugin/maven-metadata.xml'
                with urllib.request.urlopen(metadata, timeout=20) as response:
                    versions = ET.fromstring(response.read(2 * 1024 * 1024)).findall('./versioning/versions/version')
                if version not in [entry.text for entry in versions]:
                    raise RecoveryError('plugin_not_published')
                with urllib.request.urlopen(url, timeout=30) as response:
                    data = response.read(32 * 1024 * 1024 + 1)
                if len(data) > 32 * 1024 * 1024:
                    raise RecoveryError('plugin_artifact_too_large')
                with tempfile.NamedTemporaryFile(dir=artifacts, delete=False) as output:
                    temporary = Path(output.name)
                    output.write(data)
                try:
                    with zipfile.ZipFile(temporary) as jar:
                        if 'dev/lavalink/youtube/YoutubeAudioSourceManager.class' not in jar.namelist():
                            raise RecoveryError('invalid_plugin_artifact')
                    os.chmod(temporary, 0o644)
                    os.replace(temporary, path)
                finally:
                    temporary.unlink(missing_ok=True)
            except (urllib.error.URLError, zipfile.BadZipFile):
                raise RecoveryError('plugin_artifact_unavailable') from None
        return path

    def installed_artifact(self):
        version = self.current()
        path = self.directory / 'installed' / f'{version}.jar'
        path.parent.mkdir(parents=True, exist_ok=True)
        command(['docker', 'cp', f'vybertron-lavalink:/opt/Lavalink/plugins/youtube-plugin-{version}.jar', str(path)])
        os.chmod(path, 0o644)
        return path

    def prepare_probe(self):
        if not self.containers:
            self.inspect()
        image = self.containers['vybertron-lavalink']['Image']
        source = self.repo / 'ops/PlaybackProbe.java'
        installed = self.installed_artifact()
        key = hashlib.sha256(image.encode() + source.read_bytes() + installed.read_bytes()).hexdigest()[:24]
        bundle = self.directory / 'cache' / key
        bundle.mkdir(parents=True, exist_ok=True, mode=0o755)
        os.chmod(bundle, 0o755)
        if not (bundle / 'compiled').exists():
            lib = bundle / 'lib'
            lib.mkdir(exist_ok=True, mode=0o755)
            classes = bundle / 'classes'
            classes.mkdir(exist_ok=True, mode=0o755)
            lib.chmod(0o755)
            classes.chmod(0o755)
            fat_jar = bundle / 'Lavalink.jar'
            command(['docker', 'cp', 'vybertron-lavalink:/opt/Lavalink/Lavalink.jar', str(fat_jar)])
            with zipfile.ZipFile(fat_jar) as archive:
                for name in archive.namelist():
                    if name.startswith('BOOT-INF/lib/') and name.endswith('.jar'):
                        target = lib / Path(name).name
                        target.write_bytes(archive.read(name))
                        target.chmod(0o644)
            shutil.copyfile(installed, bundle / 'compile-plugin.jar')
            (bundle / 'compile-plugin.jar').chmod(0o644)
            name = 'vybertron-probe-compiler-' + uuid.uuid4().hex[:12]
            try:
                command(['docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,size=64m',
                         '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--user', '0:0',
                         '-v', f'{bundle}:/work', '-v', f'{source}:/PlaybackProbe.java:ro', '--entrypoint', 'javac', JDK,
                         '--release', '17', '-cp', '/work/lib/*:/work/compile-plugin.jar', '-d', '/work/classes', '/PlaybackProbe.java'], timeout=240)
            finally:
                subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=20)
            for item in classes.iterdir():
                item.chmod(0o644)
            (bundle / 'compiled').touch()
        (bundle / 'Lavalink.jar').unlink(missing_ok=True)
        trim_probe_cache(bundle.parent, bundle)
        return bundle, image

    def probe(self, version, full=False, installed=False, tracks=None):
        bundle, image = self.prepare_probe()
        plugin = self.installed_artifact() if installed else self.artifact(version)
        if installed and version != self.current():
            raise RecoveryError('installed_plugin_mismatch')
        config = bundle / 'application.yml'
        atomic_write(config, self.config_path.read_text(), 0o644)
        environment = dict(item.split('=', 1) for item in self.containers['vybertron-lavalink']['Config']['Env'] if '=' in item)
        fd, env_path = tempfile.mkstemp(dir=self.directory)
        name = 'vybertron-playback-probe-' + uuid.uuid4().hex[:12]
        try:
            with os.fdopen(fd, 'w') as env_file:
                for key in ['YOUTUBE_REFRESH_TOKEN', 'POT_TOKEN', 'POT_VISITOR_DATA']:
                    value = environment.get(key, '')
                    if '\n' in value or '\r' in value:
                        raise RecoveryError('invalid_probe_credentials')
                    env_file.write(f'{key}={value}\n')
            args = ['docker', 'run', '--rm', '--name', name, '--network', 'container:vybertron-warp',
                    '--read-only', '--tmpfs', '/tmp:rw,exec,size=96m', '--memory', '256m', '--memory-swap', '256m',
                    '--cpus', '1', '--pids-limit', '128', '--env-file', env_path,
                    '-e', '_JAVA_OPTIONS=-Xmx128m -Djava.net.preferIPv4Stack=true',
                    '-v', f'{bundle}:/probe:ro', '-v', f'{plugin}:/plugin.jar:ro', '--entrypoint', 'java', image,
                    '-cp', '/probe/classes:/probe/lib/*:/plugin.jar', 'PlaybackProbe', '/probe/application.yml',
                    'full' if full else 'short', *(TRACKS if tracks is None else tracks)]
            output = command(args, timeout=280 if full else 120)
            return probe_result(json.loads(output.splitlines()[-1]))
        except (ValueError, IndexError):
            raise RecoveryError('invalid_probe_response') from None
        finally:
            os.unlink(env_path)
            # A timed-out docker client can leave its container running.
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=20)

    def candidates(self, current):
        latest = public_json(GITHUB + '/releases/latest').get('tag_name', '')
        head = public_json(GITHUB + '/commits/main').get('sha', '')
        candidates = []
        for version in [latest, head]:
            if version == current or not VERSION.fullmatch(version):
                continue
            comparison = public_json(f'{GITHUB}/compare/{current}...{version}')
            if comparison.get('status') in ['ahead', 'identical']:
                candidates.append(version)
        return list(dict.fromkeys(candidates))

    def deploy(self):
        command(['docker', 'compose', 'config', '--quiet'], cwd=self.repo)
        command(['docker', 'compose', 'up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', 'lavalink'], cwd=self.repo, timeout=150)
        return self.wait_ready()

    def maintenance(self, action=''):
        route = '/maintenance' + ('/' + action if action else '')
        script = "const r=await fetch('http://127.0.0.1:'+(Number(process.env.VYBERTRON_HEALTH_PORT)||3000)+'" + route + "',{method:'" + ('POST' if action else 'GET') + "',signal:AbortSignal.timeout(5000)});if(!r.ok)process.exit(1);console.log(JSON.stringify(await r.json()));"
        return json.loads(command(['docker', 'exec', '-i', 'vybertron-bot', 'node', '--input-type=module'], data=script, timeout=10))

    def begin_update(self):
        status = self.maintenance('begin')
        for attempt in range(10):
            if status['busy']:
                self.maintenance('end')
                return False
            if status['active'] and status['inFlight'] == 0:
                return True
            time.sleep(1)
            status = self.maintenance()
        self.maintenance('end')
        return False

    def update_idle(self):
        status = self.maintenance()
        return not status['active'] and not status['busy'] and status['inFlight'] == 0

    def end_update(self):
        self.maintenance('end')

    def wait_ready(self):
        for attempt in range(12):
            observation = self.observe()
            if observation['kind'] == 'ready':
                return observation
            time.sleep(5)
        raise RecoveryError('services_not_ready')

    def recover(self, kind):
        if kind == 'network':
            # The supervisor restarts the daemon without breaking shared namespaces.
            command(['docker', 'exec', 'vybertron-warp', 'sudo', 'pkill', '-KILL', '-x', 'warp-svc'])
            time.sleep(10)
        elif kind == 'namespace':
            command(['docker', 'compose', 'up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'yt-cipher', 'lavalink'], cwd=self.repo, timeout=150)
            command(['docker', 'compose', 'restart', 'bot'], cwd=self.repo, timeout=45)
        elif kind == 'bot':
            command(['docker', 'compose', 'restart', 'bot'], cwd=self.repo, timeout=45)
        elif kind == 'audio_service':
            self.deploy()
        else:
            raise RecoveryError('unsupported_recovery')

    def verify(self, version):
        observation = self.wait_ready()
        if observation.get('version') != version or not observation.get('search'):
            return False
        expected = hashlib.sha256(self.artifact(version).read_bytes()).digest()
        actual = hashlib.sha256(self.installed_artifact().read_bytes()).digest()
        return expected == actual and self.probe(version, full=True, installed=True)['ok']

    def notify(self, event):
        channel = self.settings.get('discord_channel_id')
        guild = self.settings.get('discord_guild_id')
        if not channel or not guild:
            return False
        bot = json.loads(command(['docker', 'inspect', 'vybertron-bot']))[0]
        environment = dict(item.split('=', 1) for item in bot['Config']['Env'] if '=' in item)
        token = environment.get('DISCORD_BOT_TOKEN')
        if not token:
            return False
        headers = {'Authorization': f'Bot {token}', 'Content-Type': 'application/json', 'User-Agent': 'Vybertron-Recovery/2.0'}
        base = f'https://discord.com/api/v10/channels/{channel}'
        try:
            with urllib.request.urlopen(urllib.request.Request(base, headers=headers), timeout=10) as response:
                target = json.load(response)
            if target.get('guild_id') != guild or target.get('type') != 0:
                raise RecoveryError('alert_channel_mismatch')
            body = {'content': event['message'], 'allowed_mentions': {'parse': []}, 'nonce': event['id'], 'enforce_nonce': True}
            request = urllib.request.Request(base + '/messages', headers=headers, data=json.dumps(body).encode(), method='POST')
            with urllib.request.urlopen(request, timeout=10) as response:
                return str(json.load(response).get('channel_id')) == channel
        except urllib.error.URLError:
            return False


class Coordinator:
    def __init__(self, backend, state=None):
        self.backend = backend
        self.path = backend.directory / 'state.json'
        self.state = state if state is not None else read_json(self.path)

    def save(self):
        save_json(self.path, self.state)

    def event(self, message):
        outbox = self.state.get('outbox', [])
        if not isinstance(outbox, list):
            raise RecoveryError('invalid_alert_outbox')
        if not any(isinstance(event, dict) and event.get('message') == message for event in outbox):
            outbox.append({'id': uuid.uuid4().hex[:24], 'message': message})
        self.state['outbox'] = outbox[-MAX_OUTBOX:]
        self.save()

    def finish(self, kind, now, detail=''):
        healthy = kind == 'healthy'
        failures = 0 if healthy else self.state.get('failures', 0) + 1
        self.state.update(status=kind, checked_at=now, failures=failures, detail=detail, version=self.backend.current())
        if healthy and self.state.pop('incident_notified', False):
            self.state['started'] = True
            self.event('Vybertron has recovered. Discord connectivity, search, and audio checks are healthy again.')
        elif healthy and not self.state.get('started'):
            self.state['started'] = True
            self.event('Vybertron monitoring is enabled. Connectivity, search, and decoded audio are checked about every five minutes. Official YouTube plugin updates are checked every six hours and after persistent playback failures; updates must pass full playback tests and wait for an empty player/queue. Failed updates are rolled back. Routine successful checks stay quiet.')
        elif not healthy and failures >= 2 and self.state.get('incident_notified') != kind:
            self.state['incident_notified'] = kind
            self.event(f'Vybertron needs attention: {detail or kind}. Automatic recovery is limited to avoid repeated interruptions. Current YouTube plugin: {self.backend.current()}.')
        self.save()
        return self.state

    def recover_pending(self):
        pending = self.state.get('pending')
        if not pending:
            return
        if pending.get('rollback_attempts', 0) >= 2:
            raise RecoveryError('rollback_requires_attention')
        if self.backend.current() not in [pending['candidate'], pending['previous']]:
            raise RecoveryError('configuration_changed_during_update')
        backup = self.backend.directory / pending['backup']
        if backup.parent != self.backend.directory or not backup.name.startswith('backup-'):
            raise RecoveryError('invalid_rollback_backup')
        if not self.backend.begin_update():
            raise RecoveryError('rollback_waiting_for_idle')
        pending['rollback_attempts'] = pending.get('rollback_attempts', 0) + 1
        self.save()
        atomic_write(self.backend.config_path, backup.read_text(), 0o644)
        self.backend.deploy()
        self.state['override'] = pending.get('previous_override')
        self.state.pop('pending')
        self.state.setdefault('rejected', {})[pending['candidate']] = time.time() + 3600
        try:
            self.state['rollback_healthy'] = self.backend.probe(pending['previous'], installed=True)['ok']
        except RecoveryError:
            self.state['rollback_healthy'] = False
        with contextlib.suppress(RecoveryError):
            self.backend.end_update()
        self.save()
        self.event(f"Vybertron restored YouTube plugin {pending['previous']} after an interrupted or failed update to {pending['candidate']}.")

    def promote(self, candidate, now):
        # Prevent a new /play or an in-flight search from racing the idle check.
        if not self.backend.begin_update():
            self.state['candidate'] = candidate
            self.save()
            return False
        try:
            previous = self.backend.current()
            backup = f'backup-{int(now)}-{uuid.uuid4().hex[:8]}.yml'
            original = self.backend.config_path.read_text()
            atomic_write(self.backend.directory / backup, original)
            self.state['pending'] = {'candidate': candidate, 'previous': previous, 'backup': backup,
                                     'previous_override': self.state.get('override')}
            self.save()  # Durable before touching the live configuration.
            try:
                atomic_write(self.backend.config_path, pin_config(original, candidate), 0o644)
                self.backend.deploy()
                if not self.backend.verify(candidate):
                    raise RecoveryError('post_update_verification_failed')
            except Exception:
                self.recover_pending()
                return False
            baseline = version_of(command(['git', 'show', 'HEAD:lavalink/application.yml'], cwd=self.backend.repo))
            self.state['override'] = {'baseline': baseline, 'version': candidate}
            self.state.pop('pending')
            self.state.pop('candidate', None)
            self.state.setdefault('updates', []).append(now)
            self.save()
            self.event(f'Vybertron automatically updated the YouTube plugin from {previous} to {candidate}. Two complete tracks passed isolated playback tests before installation. The installed jar, search, audio, and bot connection passed verification afterward.')
            return True
        finally:
            with contextlib.suppress(RecoveryError):
                self.backend.end_update()

    def cycle(self, now, observe_only=False):
        deployment = read_json(self.backend.directory / 'deployment.json')
        if deployment and deployment.get('phase') not in ['complete', 'rolled_back']:
            return self.finish('pending_deployment', now, 'an interrupted deployment must be resolved before automatic recovery')
        if self.state.get('pending'):
            if observe_only:
                return self.finish('pending_update', now, 'an interrupted update requires rollback')
            self.recover_pending()
        self.state.pop('rollback_healthy', None)
        observation = self.backend.observe()
        kind = observation['kind']
        if kind != 'ready':
            recoveries = [stamp for stamp in self.state.get('recoveries', []) if now - stamp < RECOVERY_WINDOW]
            eligible = (kind != 'stopped' and self.state.get('status') == kind and self.state.get('failures', 0) >= 1 and len(recoveries) < 2
                        and (not recoveries or now - recoveries[-1] >= RECOVERY_COOLDOWN)
                        and not observation.get('playing'))
            if eligible and not observe_only:
                # Unknown player counts never establish that paused/queued music
                # is safe to interrupt. The loopback gate must confirm idleness.
                try:
                    idle = self.backend.update_idle()
                except RecoveryError:
                    idle = False
                if idle and self.backend.begin_update():
                    try:
                        self.state['recoveries'] = [*recoveries, now]
                        self.save()
                        self.backend.recover(kind)
                        observation = self.backend.observe()
                        kind = observation['kind']
                    finally:
                        with contextlib.suppress(RecoveryError):
                            self.backend.end_update()
            if kind != 'ready':
                details = {'stopped': 'a container is stopped; intentionally stopped containers are not restarted',
                           'namespace': 'the audio containers have lost their shared network',
                           'network': 'the WARP connection is unhealthy', 'audio_service': 'the audio API is unavailable',
                           'bot': 'the bot is disconnected from Discord or the audio server'}
                return self.finish(kind, now, details.get(kind, kind))
        current = self.backend.current()
        if observation.get('version') != current:
            return self.finish('configuration_drift', now, 'the loaded plugin differs from the configured version')
        handled = self.state.get('handled_failures', [])
        live_failures = [item for item in observation.get('failures', [])
                         if isinstance(item, dict) and isinstance(item.get('id'), str)
                         and re.fullmatch(r'[A-Za-z0-9_-]{1,64}', item['id'])
                         and item['id'] not in handled and isinstance(item.get('at'), (int, float))
                         and 0 <= now - item['at'] / 1000 < 900
                         and re.fullmatch(r'[A-Za-z0-9_-]{11}', str(item.get('identifier', '')))]
        if live_failures:
            # A fresh probe can succeed while the long-running source is broken.
            # Recheck the actual failed video, not just the fixed canaries.
            target = 'https://www.youtube.com/watch?v=' + live_failures[-1]['identifier']
            probe = self.backend.probe(current, installed=True, tracks=[target])
            self.state['last_live_failure_probe'] = probe
            if probe['ok']:
                recoveries = [stamp for stamp in self.state.get('recoveries', []) if now - stamp < RECOVERY_WINDOW]
                eligible = (not observe_only and len(recoveries) < 2
                            and (not recoveries or now - recoveries[-1] >= RECOVERY_COOLDOWN)
                            and observation.get('playing') == 0 and self.backend.update_idle())
                if not eligible or not self.backend.begin_update():
                    return self.finish('live_playback', now, 'real playback failed despite a passing fresh probe; recovery is waiting for an idle queue or its recovery limit')
                try:
                    self.state['recoveries'] = [*recoveries, now]
                    self.save()
                    self.backend.deploy()
                    observation = self.backend.observe()
                    if observation['kind'] != 'ready':
                        raise RecoveryError('services_not_ready')
                    # Testing one video must not acknowledge failures from
                    # another video that has never been checked.
                    verified = [item['id'] for item in live_failures if item['identifier'] == live_failures[-1]['identifier']]
                    self.state['handled_failures'] = [*handled, *verified][-30:]
                    self.save()
                    self.event('Vybertron restarted the idle audio service after a real playback failure that fresh audio probes could not reproduce. The bot reconnected; retry /play. Repeated recovery attempts are limited.')
                finally:
                    self.backend.end_update()
                probe = self.backend.probe(current, installed=True)
        else:
            probe = self.backend.probe(current, installed=True)
        self.state['last_probe'] = probe
        healthy = probe['ok'] and observation.get('search', False)
        categories = {track.get('category') for track in probe['tracks'] if not track.get('ok')}
        if 'probe_environment' in categories:
            return self.finish('monitor_error', now, 'the isolated audio probe runtime needs attention')
        failures = self.state.get('failures', 0) + (not healthy)
        due = (now - self.state.get('upstream_checked_at', 0) >= UPDATE_INTERVAL
               or self.state.get('candidate') or (not healthy and failures >= 2))
        if (due and not observe_only and self.backend.settings.get('auto_update', False)
                and not categories.intersection({'credentials', 'unavailable'})):
            try:
                candidates = [self.state['candidate']] if self.state.get('candidate') else self.backend.candidates(current)
                self.state['upstream_checked_at'] = now
                self.state.pop('update_error', None)
                for candidate in candidates[:2]:
                    if candidate == current or self.state.get('rejected', {}).get(candidate, 0) > now:
                        self.state.pop('candidate', None)
                        continue
                    recent = [stamp for stamp in self.state.get('updates', []) if now - stamp < 86400]
                    if len(recent) >= 2:
                        self.state['update_error'] = 'daily_update_limit'
                        break
                    if observation.get('playing') != 0 or not self.backend.update_idle():
                        self.state['candidate'] = candidate
                        break
                    trial = self.backend.probe(candidate, full=True)
                    if not trial['ok']:
                        self.state.setdefault('rejected', {})[candidate] = now + 3600
                        self.state.pop('candidate', None)
                        continue
                    if self.promote(candidate, now):
                        healthy = True
                    elif 'rollback_healthy' in self.state:
                        healthy = self.state.pop('rollback_healthy')
                    break
            except RecoveryError as error:
                self.state['update_error'] = str(error)
        if self.state.get('pending'):
            return self.finish('rollback_failed', now, 'an automatic update could not be rolled back; manual attention is required')
        if healthy:
            return self.finish('healthy', now)
        if 'credentials' in categories:
            return self.finish('credentials', now, 'the YouTube credentials need attention; a plugin update cannot refresh the account authorization')
        if 'unavailable' in categories:
            return self.finish('canary_degraded', now, 'test content is unavailable or region-restricted; this requires checking the test videos')
        if any(track.get('ok') for track in probe['tracks']):
            return self.finish('canary_degraded', now, 'one test video failed while another played; playback is not completely down')
        return self.finish('source', now, 'YouTube search or playback checks failed; no tested plugin update has restored playback yet')


def restore_runtime_pin(repo, directory):
    state = read_json(directory / 'state.json')
    if state.get('pending'):
        raise RecoveryError('incomplete_update_requires_rollback')
    override = state.get('override')
    if not override:
        return
    path = repo / 'lavalink/application.yml'
    config = path.read_text()
    if version_of(config) == override['baseline']:
        atomic_write(path, pin_config(config, override['version']), 0o644)
    elif version_of(config) != override['version']:
        # An explicit new repository pin takes precedence over the runtime pin.
        state.pop('override')
        save_json(directory / 'state.json', state)


def deliver_alerts(coordinator):
    """Bound retries and stop on the first failed delivery or Discord limit."""
    outbox = coordinator.state.get('outbox', [])
    if not isinstance(outbox, list):
        raise RecoveryError('invalid_alert_outbox')
    coordinator.state['outbox'] = [event for event in outbox
                                 if isinstance(event, dict) and isinstance(event.get('id'), str)
                                 and re.fullmatch(r'[a-f0-9]{24}', event['id'])
                                 and isinstance(event.get('message'), str) and 0 < len(event['message']) <= 1900][-MAX_OUTBOX:]
    coordinator.save()
    for event in list(coordinator.state['outbox'])[:MAX_ALERTS_PER_RUN]:
        try:
            sent = coordinator.backend.notify(event)
        except Exception:
            sent = False
        if not sent:
            break
        coordinator.state['outbox'].remove(event)
        coordinator.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['run', 'check', 'status', 'restore-pin', 'probe'])
    parser.add_argument('--full', action='store_true', help='Decode complete tracks with the probe action')
    parser.add_argument('--repo', type=Path, default=REPO)
    parser.add_argument('--state-dir', type=Path, default=STATE_DIR)
    args = parser.parse_args()
    directory = args.state_dir.resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    if args.action == 'status':
        state = read_json(directory / 'state.json')
        print(json.dumps({key: value for key, value in state.items() if key not in ['outbox', 'pending']}, indent=2))
        return
    if args.action == 'restore-pin':
        # The deployment workflow already holds the same maintenance lock.
        restore_runtime_pin(args.repo, directory)
        return
    if args.action == 'probe':
        # Deployment holds the maintenance lock. This isolated check never
        # mutates players, updates plugins, queues alerts, or opens Discord voice.
        backend = Backend(args.repo.resolve(), directory, {})
        try:
            result = backend.probe(backend.current(), full=args.full, installed=True)
            print(json.dumps(result))
            raise SystemExit(0 if result['ok'] else 2)
        except RecoveryError as error:
            print(json.dumps({'ok': False, 'error': str(error)}))
            raise SystemExit(1) from None
    if (directory / 'paused').exists():
        print('Automatic recovery is paused.')
        return
    import fcntl  # VPS only; unit tests can import policy code on Windows.
    with open(LOCK, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('A deployment or recovery run is already active.')
            return
        settings = read_json(directory / 'settings.json')
        backend = Backend(args.repo.resolve(), directory, settings)
        coordinator = Coordinator(backend)
        try:
            coordinator.cycle(time.time(), observe_only=args.action == 'check')
        except Exception as error:
            code = str(error) if isinstance(error, RecoveryError) else type(error).__name__
            coordinator.finish('monitor_error', time.time(), 'the recovery monitor could not complete its checks (' + code + ')')
        if args.action == 'run':
            deliver_alerts(coordinator)
        print(json.dumps({key: coordinator.state.get(key) for key in ['status', 'checked_at', 'version', 'detail', 'update_error']}))


if __name__ == '__main__':
    main()
