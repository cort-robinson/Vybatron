import importlib.util
import inspect
import json
import os
from pathlib import Path
import sys
import shutil
import tempfile
import unittest
import unittest.mock

OPS = Path(__file__).resolve().parents[1] / 'ops'
sys.path.insert(0, str(OPS))
spec = importlib.util.spec_from_file_location('portal_deploy', OPS / 'portal_deploy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PortalDeployer, DeploymentError = module.PortalDeployer, module.DeploymentError
SHA = 'a' * 40
OLD = 'sha256:' + 'b' * 64
BOT = 'sha256:' + 'c' * 64
WEB = 'sha256:' + 'd' * 64


class Harness:
    def __init__(self, root):
        self.root, self.calls = root, []
        self.scripts = []
        self.busy = False
        self.ready_lease = True
        self.fail = None
        self.fail_removes_bot = False
        self.busy_after_failure = False
        self.configured_volume = 'vybertron_bot-data'
        self.inspect_error = None
        self.label = SHA
        self.catalog = [{'id': 'old-id', 'name': 'play', 'description': 'Play music', 'type': 1}]
        self.volume = root / 'volume'
        self.volume.mkdir()
        (self.volume / 'library.json').write_text('{"version":1,"favorite":"preserved"}')
        self.containers = {name: {'Id': 'id-' + name, 'Image': OLD,
            'State': {'Running': True}, 'Mounts': []} for name in ('bot', 'warp', 'yt-cipher', 'lavalink')}
        self.containers['bot']['Mounts'] = [{'Destination': '/app/data', 'Type': 'volume',
            'RW': True, 'Name': 'vybertron_bot-data', 'Source': str(self.volume)}]
        self.bot_mounts = self.containers['bot']['Mounts']

    def run(self, args, **kwargs):
        self.calls.append(list(args))
        if kwargs.get('data'):
            self.scripts.append(kwargs['data'])
        if args[:3] == ['docker', 'image', 'inspect']:
            image = BOT if 'vybertron-bot:' in args[3] else WEB
            return json.dumps([{'Id': image, 'Config': {'Labels': {'org.opencontainers.image.revision': self.label}}}])
        if args[:2] == ['docker', 'ps']:
            name = args[args.index('--filter') + 1].removeprefix('name=^/vybertron-').removesuffix('$')
            return 'vybertron-' + name if name in self.containers else ''
        if args[:2] == ['docker', 'inspect']:
            name = args[-1].removeprefix('vybertron-')
            if name == self.inspect_error:
                self.inspect_error = None
                raise DeploymentError('deployment_command_failed')
            if name not in self.containers:
                raise DeploymentError('deployment_command_failed')
            if '--format' in args:
                return self.containers[name]['Image']
            return json.dumps([self.containers[name]])
        if args[:3] == ['docker', 'volume', 'inspect']:
            return json.dumps([{'Mountpoint': str(self.volume)}])
        if args[:2] == ['docker', 'exec']:
            script = kwargs.get('data', '')
            if '/maintenance/begin' in script:
                return json.dumps({'active': self.ready_lease, 'busy': self.busy, 'inFlight': 0})
            if '/maintenance/end' in script:
                return '{}'
            if '/commands' in script:
                return json.dumps(self.catalog)
            return ''
        if args[:2] == ['docker', 'compose']:
            cmd = args[args.index('--profile') + 2:]
            overlays = [Path(args[i + 1]) for i, value in enumerate(args) if value == '-f']
            selected = json.loads(overlays[-1].read_text())['services']
            if cmd[0] == 'up':
                name = cmd[-1]
                if self.fail == name:
                    self.fail = None
                    self.busy = self.busy or self.busy_after_failure
                    if name == 'bot' and self.fail_removes_bot:
                        self.containers.pop(name, None)
                    raise DeploymentError('deployment_command_failed')
                image = selected[name]['image']
                if name not in self.containers:
                    self.containers[name] = {'Id': 'id-' + name, 'State': {}, 'Mounts': self.bot_mounts if name == 'bot' else []}
                self.containers[name].update(Image=image, State={'Running': True})
                if name == 'bot' and image == BOT:
                    (self.volume / 'library.json').write_text('{"version":2,"favorite":"preserved","new":"saved"}')
            elif cmd[0] == 'stop':
                if cmd[-1] in self.containers:
                    self.containers[cmd[-1]]['State']['Running'] = False
            elif cmd[0] == 'rm':
                self.containers.pop(cmd[-1], None)
            elif cmd[0] == 'config' and '--format' in cmd:
                return json.dumps({'services': {'bot': {'volumes': [{
                    'type': 'volume', 'source': 'bot-data', 'target': '/app/data'}]}},
                    'volumes': {'bot-data': {'name': self.configured_volume}}})
            elif cmd[0] not in ('run', 'config'):
                raise AssertionError('Unexpected compose operation: ' + str(cmd))
            return ''
        raise AssertionError('Unexpected external command: ' + str(args))


class PortalReleasePolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo, self.state = self.root / 'release', self.root / 'private'
        self.repo.mkdir(); self.state.mkdir()
        (self.repo / '.portal-release.json').write_text(json.dumps({'revision': SHA}))
        self.env = self.root / 'bot.env'; self.env.write_text('PRIVATE=test')
        self.portal_env = self.root / 'portal.env'; self.portal_env.write_text('PRIVATE=test')
        self.env.chmod(0o600); self.portal_env.chmod(0o600)
        self.harness = Harness(self.root)
        self.deployer = PortalDeployer(self.repo, self.state, env_file=self.env,
            portal_env=self.portal_env, runner=self.harness.run, sleep=lambda _: None)

    def deploy(self):
        return self.deployer.deploy(SHA, '123456789012345678')

    def mutations(self):
        return [a for a in self.harness.calls if a[:2] == ['docker', 'compose'] and
            a[a.index('--profile') + 2] in ('up', 'stop', 'run', 'rm')]

    def test_wrong_prebuilt_revision_rejected_before_leasing_or_stopping(self):
        self.harness.label = 'e' * 40
        with self.assertRaisesRegex(DeploymentError, 'image_identity'):
            self.deploy()
        self.assertEqual(self.mutations(), [])
        self.assertFalse(any(a[:2] == ['docker', 'exec'] for a in self.harness.calls))

    def test_source_archive_must_identify_exact_sha(self):
        (self.repo / '.portal-release.json').write_text(json.dumps({'revision': 'f' * 40}))
        with self.assertRaisesRegex(DeploymentError, 'source_identity'):
            self.deploy()
        self.assertEqual(self.harness.calls, [])

    def test_busy_or_unconfirmed_lease_cannot_replace_services(self):
        for busy, ready in ((True, True), (False, False)):
            with self.subTest(busy=busy, ready=ready):
                self.harness.busy, self.harness.ready_lease = busy, ready
                with self.assertRaisesRegex(DeploymentError, 'waiting_for'):
                    self.deploy()
                self.assertEqual(self.mutations(), [])

    def test_release_changes_only_bot_and_portal_and_retains_exact_volume(self):
        self.assertEqual(self.deploy(), 'deployed')
        for args in self.mutations():
            self.assertNotIn('build', args)
            self.assertNotIn('warp', args)
            self.assertNotIn('lavalink', args)
            self.assertNotIn('yt-cipher', args)
        self.assertEqual(self.harness.containers['bot']['Image'], BOT)
        self.assertEqual(self.deployer.bot_volume()['name'], 'vybertron_bot-data')
        journal = module.read(self.state / 'portal-deployment.json')
        self.assertEqual(journal['phase'], 'complete')
        self.assertEqual(module.read(self.state / 'deployment.json')['phase'], 'complete')
        self.assertEqual(module.read(self.state / journal['commands_backup'])['commands'][0].get('id'), None)

    def test_portal_failure_rolls_back_image_catalog_and_data_preserving_failed_data(self):
        self.harness.fail = 'portal'
        original = (self.harness.volume / 'library.json').read_text()
        with self.assertRaisesRegex(DeploymentError, 'previous_release_restored'):
            self.deploy()
        self.assertEqual(self.harness.containers['bot']['Image'], OLD)
        self.assertEqual((self.harness.volume / 'library.json').read_text(), original)
        journal = module.read(self.state / 'portal-deployment.json')
        self.assertEqual(journal['phase'], 'rolled_back')
        failed = self.state / journal['failed_data_backup'] / 'library.json'
        self.assertEqual(json.loads(failed.read_text())['new'], 'saved')
        self.assertFalse('portal' in self.harness.containers)
        puts = [s for s in self.harness.scripts if "method:'PUT'" in s]
        # Release cleared the test guild copy, then rollback restored the global
        # catalog followed by the guild catalog from the version-2 backup.
        self.assertEqual(len(puts), 3)
        self.assertTrue(puts[0].startswith('const commands=[];') and '/guilds/' in puts[0])
        self.assertNotIn('/guilds/', puts[1]); self.assertIn('"name": "play"', puts[1])
        self.assertIn('/guilds/', puts[2]); self.assertIn('"name": "play"', puts[2])
        for args in self.mutations():
            self.assertNotIn('warp', args)
            self.assertNotIn('lavalink', args)
            self.assertNotIn('yt-cipher', args)

    def test_release_registers_global_commands_and_clears_the_guild_copy(self):
        self.assertEqual(self.deploy(), 'deployed')
        runs = [args for args in self.harness.calls if args[:2] == ['docker', 'compose'] and 'deploy-commands.js' in args]
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0][-1], 'global')
        self.assertFalse(any(arg.startswith('GUILD_ID=') for arg in runs[0]))
        puts = [s for s in self.harness.scripts if "method:'PUT'" in s]
        self.assertEqual(len(puts), 1)
        self.assertTrue(puts[0].startswith('const commands=[];') and '/guilds/' in puts[0])
        journal = module.read(self.state / 'portal-deployment.json')
        backup = module.read(self.state / journal['commands_backup'])
        self.assertEqual(backup['version'], 2)
        self.assertEqual([c['name'] for c in backup['global']], ['play'])
        self.assertEqual([c['name'] for c in backup['commands']], ['play'])

    def test_version_one_command_backup_restores_only_the_guild_catalog(self):
        self.deploy()
        journal = module.read(self.state / 'portal-deployment.json')
        module.write(self.state / journal['commands_backup'], json.dumps({'commands': [{'name': 'play', 'description': 'Play music', 'type': 1}]}))
        self.harness.scripts.clear()
        self.deployer.restore_commands(journal)
        puts = [s for s in self.harness.scripts if "method:'PUT'" in s]
        self.assertEqual(len(puts), 1)
        self.assertIn('/guilds/', puts[0])

    def test_rollback_rechecks_idle_before_stopping_new_player(self):
        self.deploy()
        self.harness.calls.clear(); self.harness.busy = True
        with self.assertRaisesRegex(DeploymentError, 'waiting_for_idle'):
            self.deployer.rollback()
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.harness.containers['bot']['Image'], BOT)
        self.assertEqual(module.read(self.state / 'portal-deployment.json')['phase'], 'complete')

    def test_failed_release_that_cannot_roll_back_is_not_reported_as_waiting_for_idle(self):
        # Deploy retries only the pre-change idle refusal; a listener who joins the new bot before a
        # failed release rolls back must surface as a failure, not as "wait and try again".
        self.harness.fail, self.harness.busy_after_failure = 'portal', True
        with self.assertRaises(DeploymentError) as raised:
            self.deploy()
        self.assertEqual(str(raised.exception), 'portal_failed_rollback_waiting_for_idle')
        self.assertEqual(module.read(self.state / 'portal-deployment.json')['phase'], 'releasing')

    def test_same_sha_can_be_retried_after_successful_rollback(self):
        self.harness.fail = 'portal'
        with self.assertRaises(DeploymentError):
            self.deploy()
        first = module.read(self.state / 'portal-deployment.json')['data_backup']
        self.assertEqual(self.deploy(), 'deployed')
        second = module.read(self.state / 'portal-deployment.json')['data_backup']
        self.assertNotEqual(first, second)
        self.assertTrue((self.state / first / 'library.json').is_file())

    def test_corrupt_backup_stops_rollback_without_starting_old_bot(self):
        self.deploy()
        journal = module.read(self.state / 'portal-deployment.json')
        (self.state / journal['data_backup'] / 'library.json').write_text('corrupt')
        with self.assertRaisesRegex(DeploymentError, 'rollback_failed'):
            self.deployer.rollback()
        self.assertFalse(self.harness.containers['bot']['State']['Running'])
        self.assertEqual(self.harness.containers['bot']['Image'], BOT)
        self.assertEqual(module.read(self.state / 'portal-deployment.json')['phase'], 'rollback_failed')

    def test_read_only_or_wrong_volume_rejected_without_service_replacement(self):
        self.harness.containers['bot']['Mounts'][0]['RW'] = False
        with self.assertRaisesRegex(DeploymentError, 'not_persistent'):
            self.deploy()
        self.assertEqual(self.mutations(), [])

    def test_pending_other_deployment_prevents_portal_transaction(self):
        module.write(self.state / 'deployment.json', json.dumps({'phase': 'releasing'}))
        with self.assertRaisesRegex(DeploymentError, 'requires_rollback'):
            self.deploy()
        self.assertEqual(self.harness.calls, [])

    def test_failed_recreation_without_bot_recovers_original_image_and_volume(self):
        self.harness.fail = 'bot'; self.harness.fail_removes_bot = True
        original = (self.harness.volume / 'library.json').read_bytes()
        with self.assertRaisesRegex(DeploymentError, 'previous_release_restored'):
            self.deploy()
        self.assertEqual(self.harness.containers['bot']['Image'], OLD)
        self.assertEqual((self.harness.volume / 'library.json').read_bytes(), original)
        self.assertEqual(self.deployer.bot_volume()['name'], 'vybertron_bot-data')
        self.assertEqual(module.read(self.state / 'portal-deployment.json')['phase'], 'rolled_back')

    def test_stale_rollback_refuses_unrelated_bot_or_portal_without_mutation(self):
        self.deploy()
        for name in ('bot', 'portal'):
            expected = self.harness.containers[name]['Image']
            self.harness.containers[name]['Image'] = 'sha256:' + 'e' * 64
            self.harness.calls.clear()
            with self.assertRaisesRegex(DeploymentError, 'external_image_changed'):
                self.deployer.rollback()
            self.assertEqual(self.mutations(), [])
            self.assertEqual(self.harness.containers[name]['Image'], 'sha256:' + 'e' * 64)
            self.harness.containers[name]['Image'] = expected

    def test_missing_or_empty_manifest_cannot_start_old_bot_with_new_data(self):
        for content in (None, '{}'):
            with self.subTest(content=content):
                # A new setup keeps each failed rollback transaction independent.
                self.setUp()
                self.deploy()
                journal = module.read(self.state / 'portal-deployment.json')
                marker = self.state / journal['data_backup'] / '.backup-manifest.json'
                marker.unlink() if content is None else marker.write_text(content)
                with self.assertRaisesRegex(DeploymentError, 'rollback_failed'):
                    self.deployer.rollback()
                self.assertEqual(self.harness.containers['bot']['Image'], BOT)
                self.assertFalse(self.harness.containers['bot']['State']['Running'])
                self.assertEqual(json.loads((self.harness.volume / 'library.json').read_text())['version'], 2)

    def test_original_empty_volume_has_explicit_validated_manifest(self):
        (self.harness.volume / 'library.json').unlink()
        name = self.deployer.snapshot_data(self.deployer.bot_volume(), 'portal-data-empty')
        self.deployer.restore_data(self.deployer.bot_volume(), name)
        envelope = module.read(self.state / name / '.backup-manifest.json')
        self.assertEqual(envelope, {'version': 1, 'file_count': 0, 'total_bytes': 0, 'files': {}})

    def test_rollback_restores_original_absence_and_preserves_candidate_only_files(self):
        (self.harness.volume / 'library.json').unlink()
        self.deploy()
        (self.harness.volume / 'extra.json').write_text('new-music-data')
        self.assertEqual(self.deployer.rollback(), 'rolled_back')
        self.assertFalse((self.harness.volume / 'library.json').exists())
        self.assertFalse((self.harness.volume / 'extra.json').exists())
        journal = module.read(self.state / 'portal-deployment.json')
        self.assertEqual(json.loads((self.state / journal['failed_data_backup'] / 'library.json').read_text())['version'], 2)
        self.assertEqual((self.state / journal['quarantined_data'][0] / 'extra.json').read_text(), 'new-music-data')
        self.assertEqual(self.harness.containers['bot']['Image'], OLD)

    def test_existing_portal_inspection_failure_is_not_treated_as_absence(self):
        self.harness.containers['portal'] = {'Id': 'old-portal', 'Image': OLD, 'State': {'Running': True}, 'Mounts': []}
        self.harness.inspect_error = 'portal'
        with self.assertRaisesRegex(DeploymentError, 'command_failed'):
            self.deploy()
        self.assertEqual(self.mutations(), [])
        self.assertEqual(self.harness.containers['portal']['Image'], OLD)

    def test_unknown_compose_volume_refused_even_if_bot_container_is_absent(self):
        self.deploy()
        self.harness.containers.pop('bot')
        self.harness.configured_volume = 'different-data'
        self.harness.calls.clear()
        with self.assertRaisesRegex(DeploymentError, 'compose_volume_identity_mismatch'):
            self.deployer.rollback()
        self.assertEqual(self.mutations(), [])

    def test_backup_manifest_cannot_silently_omit_existing_files(self):
        name = self.deployer.snapshot_data(self.deployer.bot_volume(), 'portal-data-incomplete')
        module.write(self.state / name / '.backup-manifest.json', json.dumps({
            'version': 1, 'file_count': 0, 'total_bytes': 0, 'files': {}}))
        with self.assertRaisesRegex(DeploymentError, 'backup_incomplete'):
            self.deployer.restore_data(self.deployer.bot_volume(), name)


def release_dir(root, sha, mtime):
    path = root / sha
    (path / 'ops').mkdir(parents=True)
    (path / 'ops' / 'deploy.py').write_text('# source')
    (path / '.portal-release.json').write_text(json.dumps({'revision': sha}))
    os.utime(path, (mtime, mtime))
    return path


def container(index, mounts=(), working_dir=None, config_files=None):
    """A complete `docker inspect` entry, as Docker returns it."""
    labels = {}
    if working_dir is not None:
        labels['com.docker.compose.project.working_dir'] = str(working_dir)
    if config_files is not None:
        labels['com.docker.compose.project.config_files'] = ','.join(str(f) for f in config_files)
    return {'Id': format(index, 'x').rjust(64, '0'),
            'Mounts': [{'Type': 'bind', 'Source': str(source), 'Destination': '/m' + str(n)}
                       for n, source in enumerate(mounts)],
            'Config': {'Labels': labels}}


NORMAL_MOUNTS = (
    '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n'
    '23 22 0:21 / /proc rw,nosuid shared:12 - proc proc rw\n'
    '24 22 0:22 / /tmp rw shared:13 - tmpfs tmpfs rw\n'
    '25 22 259:2 /var/lib/docker /var/lib/docker rw shared:1 - ext4 /dev/nvme0n1p2 rw\n')


def prune_deployer(repo, state, runner, releases, mountinfo, **kwargs):
    accepted = inspect.signature(PortalDeployer).parameters
    extra = {name: value for name, value in [('releases_dir', releases), ('mountinfo', mountinfo)] if name in accepted}
    return PortalDeployer(repo, state, env_file=kwargs.pop('env_file', state.parent / 'x.env'),
                          portal_env=kwargs.pop('portal_env', state.parent / 'p.env'),
                          runner=runner, sleep=lambda _: None, **extra, **kwargs)


class ReleasePruneTests(unittest.TestCase):
    """Old releases/<sha> source directories are pruned after a verified release."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = self.root / 'releases'
        self.releases.mkdir()
        self.shas = [format(i, 'x') * 40 for i in range(1, 7)]  # Oldest first.
        for index, sha in enumerate(self.shas):
            release_dir(self.releases, sha, 1_000_000 + index * 100)
        self.current = self.releases / self.shas[-1]
        self.revisions = {OLD: self.shas[-2], WEB: self.shas[-2]}
        # The just-released bot was composed from the current release.
        self.containers = [container(1, working_dir=self.current,
                                     config_files=[self.current / 'docker-compose.yml'])]
        self.images = None
        self.failing = None
        # Mount points that are all outside releases/ (an ancestor is fine).
        self.mountinfo = self.root / 'mountinfo'
        self.mountinfo.write_text(NORMAL_MOUNTS + '26 22 0:40 / ' + str(self.root) + ' rw - tmpfs tmpfs rw\n')
        self.deployer = prune_deployer(self.current, self.root / 'private', self.host, self.releases, self.mountinfo)

    def host(self, args, **kwargs):
        if self.failing and self.failing(args):
            raise DeploymentError('deployment_command_failed')
        if args[:2] == ['docker', 'ps']:
            return '\n'.join(item['Id'] if isinstance(item, dict) and 'Id' in item else format(n + 1, 'x').rjust(64, '0')
                             for n, item in enumerate(self.containers))
        if args[:2] == ['docker', 'inspect']:
            return json.dumps(self.containers)
        if args[:3] == ['docker', 'image', 'inspect']:
            if self.images is not None:
                return json.dumps(self.images(args[3]))
            labels = {'org.opencontainers.image.revision': self.revisions[args[3]]} if args[3] in self.revisions else {}
            return json.dumps([{'Id': args[3], 'Config': {'Labels': labels}}])
        raise AssertionError('Unexpected external command: ' + str(args))

    def prune(self, keep=module.KEEP_RELEASES, previous=None):
        journal = {'previous_images': previous if previous is not None else {'bot': OLD, 'portal': WEB}}
        return self.deployer.prune_releases(journal, keep)

    def remaining(self):
        return sorted(p.name for p in self.releases.iterdir())

    def assert_skipped(self, result, reason):
        self.assertEqual(result, {'status': 'skipped', 'reason': reason})
        self.assertEqual(len([p for p in self.releases.iterdir() if p.name in self.shas]), 6)

    def test_keeps_the_newest_releases_and_removes_older_ones(self):
        result = self.prune()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.remaining(), sorted(self.shas[-3:]))
        self.assertEqual(result['removed'], sorted(self.shas[:3]))
        self.assertEqual(self.prune()['removed'], [])  # Idempotent.

    def test_never_removes_the_running_release_or_the_rollback_target(self):
        # Old mtimes: a retried staging keeps its original directory.
        os.utime(self.current, (1, 1))
        self.revisions = {OLD: self.shas[0], WEB: self.shas[1]}
        result = self.prune(keep=1)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.remaining(), sorted([self.shas[0], self.shas[1], self.shas[-2], self.shas[-1]]))

    def test_a_first_portal_release_has_no_previous_portal_image(self):
        self.assertEqual(self.prune(previous={'bot': OLD, 'portal': None})['status'], 'ok')

    def test_a_rollback_image_without_a_revision_label_skips_pruning(self):
        self.revisions = {OLD: self.shas[0]}  # The portal image has no label.
        self.assert_skipped(self.prune(), 'rollback_revision_unknown')

    def test_a_malformed_rollback_revision_label_skips_pruning(self):
        for label in ['', 'main', self.shas[0][:-1], 'A' * 40, 'a' * 40 + '\n', 7, None]:
            self.revisions = {OLD: self.shas[-2], WEB: label}
            self.assert_skipped(self.prune(), 'rollback_revision_unknown')

    def test_an_unexpected_image_inspection_skips_pruning(self):
        responses = [[], [{}], [{'Id': OLD}], {'Id': OLD}, [{'Id': 'sha256:' + 'e' * 64, 'Config': {'Labels': {}}}],
                     [{'Id': OLD, 'Config': {'Labels': {'org.opencontainers.image.revision': self.shas[0]}}}] * 2]
        for response in responses:
            self.images = lambda image, response=response: response
            self.assert_skipped(self.prune(previous={'bot': OLD, 'portal': None}), 'rollback_revision_unknown')

    def test_a_missing_portal_rollback_field_skips_pruning(self):
        # release() always records 'portal', as None only before the first portal release.
        self.assert_skipped(self.prune(previous={'bot': OLD}), 'rollback_revision_unknown')

    def test_a_missing_or_malformed_rollback_record_skips_pruning(self):
        for previous in [{}, {'portal': WEB}, {'bot': None, 'portal': WEB}, {'bot': 'latest', 'portal': WEB},
                         {'bot': OLD, 'portal': 'latest'}, ['bot']]:
            self.assert_skipped(self.prune(previous=previous), 'rollback_revision_unknown')
        self.assert_skipped(self.deployer.prune_releases(None), 'rollback_revision_unknown')

    def test_keeps_any_release_a_container_still_mounts_or_was_composed_from(self):
        self.containers += [
            container(2, mounts=[self.releases / self.shas[1] / 'lavalink' / 'application.yml']),
            container(3, working_dir=self.releases / self.shas[0],
                      config_files=['/root/Vybertron/docker-compose.yml', self.releases / self.shas[2] / 'docker-compose.portal.yml']),
        ]
        self.assertEqual(self.prune(keep=1)['status'], 'ok')
        self.assertEqual(self.remaining(), sorted([self.shas[0], self.shas[1], self.shas[2], self.shas[-2], self.shas[-1]]))

    def test_partial_container_inspection_skips_pruning(self):
        good = container(2, mounts=[self.releases / self.shas[0]])
        partial = [
            {}, {'Id': good['Id']}, {'Id': good['Id'], 'Mounts': []}, {'Id': good['Id'], 'Config': {}},
            {**good, 'Mounts': None}, {**good, 'Mounts': {}}, {**good, 'Config': None}, {**good, 'Config': {}},
            {**good, 'Config': {'Labels': []}}, {**good, 'Mounts': [{}]}, {**good, 'Mounts': [{'Type': 'bind'}]},
            {**good, 'Mounts': [{'Type': 'bind', 'Source': 7}]}, {**good, 'Mounts': [{'Type': 'bind', 'Source': ''}]},
            {**good, 'Mounts': [{'Type': 'bind', 'Source': 'relative/path'}]}, {**good, 'Mounts': ['x']},
            {**good, 'Config': {'Labels': {'com.docker.compose.project.working_dir': 7}}},
            {**good, 'Config': {'Labels': {'com.docker.compose.project.working_dir': 'releases/x'}}},
            {**good, 'Id': 'short'}, 'not a container',
        ]
        for entry in partial:
            self.containers = [self.containers[0], entry]
            self.assert_skipped(self.prune(keep=1), 'container_state_unknown')

    def test_present_but_null_or_non_string_fields_skip_pruning(self):
        other = self.releases / self.shas[0]
        for key in ['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files']:
            for value in [None, 7, ['x'], {}, '']:
                entry = container(2, mounts=[other / 'warp'])
                entry['Config']['Labels'][key] = value
                self.containers = [self.containers[0], entry]
                self.assert_skipped(self.prune(keep=1), 'container_state_unknown')
        for change in [lambda e: e['Config'].update(Labels=None), lambda e: e['Mounts'][0].update(Source=None),
                       lambda e: e['Mounts'][0].update(Type=None), lambda e: e['Mounts'][0].update(Type='')]:
            entry = container(2, mounts=[other / 'warp'])
            change(entry)
            self.containers = [self.containers[0], entry]
            self.assert_skipped(self.prune(keep=1), 'container_state_unknown')

    def test_a_numeric_container_id_must_still_be_a_string(self):
        numeric = '1' * 64
        entry = container(2, mounts=[self.releases / self.shas[0] / 'warp'])
        self.containers = [self.containers[0], entry]
        listing = self.containers[0]['Id'] + '\n' + numeric
        answer = json.dumps([self.containers[0], {**entry, 'Id': 0}]).replace('"Id": 0', '"Id": ' + numeric)
        self.deployer.runner = lambda args, **kwargs: (
            listing if args[:2] == ['docker', 'ps'] else answer if args[:2] == ['docker', 'inspect']
            else self.host(args, **kwargs))
        self.assert_skipped(self.prune(keep=1), 'container_state_unknown')

    def test_inspection_must_answer_for_exactly_the_listed_containers(self):
        listed = [self.containers[0], container(2, mounts=[self.releases / self.shas[0]])]
        for answer in [listed[:1], [listed[0], listed[0]], [listed[0], container(9)], listed + [container(3)], {}]:
            self.containers = listed
            original = self.host

            def host(args, answer=answer, original=original, **kwargs):
                return json.dumps(answer) if args[:2] == ['docker', 'inspect'] else original(args, **kwargs)
            self.deployer.runner = host
            self.assert_skipped(self.prune(keep=1), 'container_state_unknown')
        # Container IDs that are not full IDs, or are listed twice.
        for listing in ['not-an-id', listed[0]['Id'] + '\n' + listed[0]['Id']]:
            self.deployer.runner = lambda args, listing=listing, **kwargs: (
                listing if args[:2] == ['docker', 'ps'] else self.host(args, **kwargs))
            self.assert_skipped(self.prune(keep=1), 'container_state_unknown')

    def test_tmpfs_and_volume_mounts_without_paths_are_accepted(self):
        entry = container(2)
        entry['Mounts'] = [{'Type': 'tmpfs', 'Source': '', 'Destination': '/tmp'},
                           {'Type': 'volume', 'Name': 'data', 'Source': '/var/lib/docker/volumes/data/_data', 'Destination': '/d'}]
        self.containers.append(entry)
        self.assertEqual(self.prune()['status'], 'ok')

    def test_no_containers_or_an_unreferenced_current_release_skips_pruning(self):
        self.containers = []
        self.assert_skipped(self.prune(keep=1), 'current_release_not_in_use')
        self.containers = [container(1, working_dir='/root/Vybertron')]
        self.assert_skipped(self.prune(keep=1), 'current_release_not_in_use')

    def test_a_mount_of_the_releases_directory_or_an_ancestor_skips_pruning(self):
        for source in [self.releases, self.releases.parent, Path('/')]:
            self.containers = [self.containers[0], container(2, mounts=[source])]
            self.assert_skipped(self.prune(keep=1), 'container_mounts_releases_directory')
        self.containers = [self.containers[0], container(2, working_dir=self.releases)]
        self.assert_skipped(self.prune(keep=1), 'container_mounts_releases_directory')

    def test_a_mount_through_a_symlinked_ancestor_is_still_an_ancestor(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        self.containers = [self.containers[0], container(2, mounts=[alias])]
        self.assert_skipped(self.prune(keep=1), 'container_mounts_releases_directory')

    def test_never_follows_or_removes_anything_outside_the_releases_directory(self):
        outside = self.root / 'outside'
        (outside / 'keep').mkdir(parents=True)
        (outside / 'keep' / 'data').write_text('precious')
        os.utime(outside, (1, 1))
        link = self.releases / ('9' * 40)
        link.symlink_to(outside, target_is_directory=True)
        # A symlink inside an old release must be unlinked, not followed.
        (self.releases / self.shas[0] / 'escape').symlink_to(outside, target_is_directory=True)
        os.utime(self.releases / self.shas[0], (1, 1))
        (self.releases / 'notes.txt').write_text('operator file')
        (self.releases / (self.shas[0][:-1] + 'z')).mkdir()
        staging = self.releases / (self.shas[0] + '.tmp')
        staging.mkdir()
        result = self.prune()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual((outside / 'keep' / 'data').read_text(), 'precious')
        self.assertTrue(link.is_symlink())
        self.assertTrue(staging.is_dir())
        self.assertTrue((self.releases / 'notes.txt').exists())
        self.assertNotIn(self.shas[0], self.remaining())

    def test_remove_inside_takes_only_a_plain_directory_name_in_the_open_directory(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.releases / 'link').symlink_to(outside, target_is_directory=True)
        (self.releases / 'file').write_text('x')
        fd = os.open(self.releases, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        self.addCleanup(os.close, fd)
        for name in ['link', 'file', '..', '.', '', '../outside', str(outside), self.shas[0] + '/ops', 'missing']:
            with self.assertRaises((DeploymentError, OSError)):
                PortalDeployer.remove_inside(fd, name)
        self.assertTrue(outside.is_dir())
        self.assertTrue((self.releases / 'link').is_symlink())
        PortalDeployer.remove_inside(fd, self.shas[0])
        self.assertNotIn(self.shas[0], self.remaining())

    def outside_with(self, shas):
        outside = self.root / 'outside'
        for sha in shas:
            (outside / sha).mkdir(parents=True)
            (outside / sha / 'sentinel').write_text('precious')
        return outside

    def assert_outside_intact(self, outside, shas):
        self.assertEqual(sorted(p.name for p in outside.iterdir()), sorted(shas))
        for sha in shas:
            self.assertEqual((outside / sha / 'sentinel').read_text(), 'precious')

    def test_releases_replaced_by_a_symlink_mid_removal_cannot_reach_outside(self):
        outside = self.outside_with(self.shas[:3])  # The same SHAs as the removal candidates.
        moved = self.root / 'moved'
        real_rename, swapped = os.rename, []

        def racing_rename(*args, **kwargs):
            if not swapped:
                swapped.append(True)
                real_rename(self.releases, moved)
                os.symlink(outside, self.releases)
            return real_rename(*args, **kwargs)
        with unittest.mock.patch.object(module.os, 'rename', racing_rename):
            self.prune()
        self.assert_outside_intact(outside, self.shas[:3])
        # The directory that was validated is the one pruned, wherever it now is.
        self.assertEqual(sorted(p.name for p in moved.iterdir()), sorted(self.shas[-3:]))

    def test_releases_replaced_after_opening_skips_pruning(self):
        outside = self.outside_with(self.shas[:3])
        original = self.host

        def host(args, **kwargs):
            if args[:2] == ['docker', 'inspect'] and not self.releases.is_symlink():
                self.releases.rename(self.root / 'moved')
                self.releases.symlink_to(outside, target_is_directory=True)
            return original(args, **kwargs)
        self.deployer.runner = host
        self.assertEqual(self.prune(), {'status': 'skipped', 'reason': 'releases_directory_changed'})
        self.assert_outside_intact(outside, self.shas[:3])
        self.assertEqual(len(list((self.root / 'moved').iterdir())), 6)

    def nest_releases(self):
        """Move releases/ under data/, where a parent swap can be staged."""
        data = self.root / 'data'
        data.mkdir()
        self.releases.rename(data / 'releases')
        self.releases = data / 'releases'
        self.current = self.releases / self.shas[-1]
        self.containers = [container(1, working_dir=self.current, config_files=[self.current / 'docker-compose.yml'])]
        self.deployer = prune_deployer(self.current, self.root / 'private', self.host, self.releases, self.mountinfo)
        return data

    def test_a_parent_replaced_before_opening_cannot_redirect_removal(self):
        data = self.nest_releases()
        outside = self.root / 'outside'
        self.outside_with(self.shas)  # outside/<sha> for every SHA, each with a sentinel.
        (outside.parent / 'outside-tree').mkdir()
        outside.rename(outside.parent / 'outside-tree' / 'releases')
        tree = outside.parent / 'outside-tree'
        # After the deployer resolved its paths, data/ becomes a symlink to a
        # tree with matching SHAs.
        data.rename(self.root / 'data-moved')
        data.symlink_to(tree, target_is_directory=True)
        result = self.prune()
        self.assert_outside_intact(tree / 'releases', self.shas)
        self.assertEqual(result, {'status': 'skipped', 'reason': 'releases_path_not_trusted'})
        self.assertEqual(len(list((self.root / 'data-moved' / 'releases').iterdir())), 6)

    def test_a_parent_replaced_after_opening_cannot_redirect_removal(self):
        data = self.nest_releases()
        self.outside_with(self.shas)
        tree = self.root / 'outside-tree'
        tree.mkdir()
        (self.root / 'outside').rename(tree / 'releases')
        original = self.host

        def host(args, **kwargs):
            if args[:2] == ['docker', 'inspect'] and not data.is_symlink():
                data.rename(self.root / 'data-moved')
                data.symlink_to(tree, target_is_directory=True)
            return original(args, **kwargs)
        self.deployer.runner = host
        self.prune()
        self.assert_outside_intact(tree / 'releases', self.shas)

    def write_mounts(self, *points):
        lines = [f'{40 + n} 22 259:2 /x {point} rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n'
                 for n, point in enumerate(points)]
        self.mountinfo.write_text(NORMAL_MOUNTS + ''.join(lines))

    def test_a_mount_at_or_inside_releases_skips_pruning(self):
        spaced = self.releases / self.shas[0] / 'my dir'
        spaced.mkdir()
        (spaced / 'data').write_text('bind-mounted')
        leftover = self.releases / ('.pruning-' + 'd' * 32)
        leftover.mkdir()
        escaped = str(spaced).replace(' ', '\\040')
        for point in [escaped, str(self.releases / self.shas[1] / 'lavalink'), str(leftover),
                      str(self.releases), str(self.releases / self.shas[-1])]:
            self.write_mounts(point)
            self.assert_skipped(self.prune(), 'mount_inside_releases')
            self.assertEqual((spaced / 'data').read_text(), 'bind-mounted')
            self.assertTrue(leftover.is_dir())

    def test_mount_points_beside_or_above_releases_do_not_block_pruning(self):
        self.write_mounts(str(self.root), str(self.root / 'releases-other'), str(self.releases) + '2',
                          str(self.releases).replace(' ', '\\040') + '\\040x')
        self.assertEqual(self.prune()['status'], 'ok')

    def test_unreadable_or_malformed_mountinfo_skips_pruning(self):
        self.mountinfo.unlink()
        self.assert_skipped(self.prune(), 'mountinfo_unavailable')
        for text in ['', 'garbage\n', '22 1 259:2 / / rw shared:1 ext4 /dev/x rw\n',
                     NORMAL_MOUNTS + '30 22 0:1 / relative/path rw - ext4 x rw\n',
                     NORMAL_MOUNTS + '30 22 0:1 / /bad\\9 rw - ext4 x rw\n']:
            self.mountinfo.write_text(text)
            self.assert_skipped(self.prune(), 'mountinfo_unavailable')

    def test_a_protected_directory_with_the_tombstone_name_is_never_replaced(self):
        # The old scheme renamed onto .pruning-<sha>-<time_ns>; the new one onto
        # a fixed child of a freshly created holding directory.
        fixed_ns = 1700000000000000000
        old_scheme = self.releases / ('.pruning-' + self.shas[2] + '-' + str(fixed_ns))
        new_scheme = self.releases / ('.pruning-' + '0' * 32)
        for path in [old_scheme, new_scheme]:
            path.mkdir()
        self.containers += [container(2, mounts=[old_scheme]), container(3, mounts=[new_scheme])]
        tokens = iter(['0' * 32, 'e' * 32, 'f' * 32, '9' * 32])
        with unittest.mock.patch('time.time_ns', return_value=fixed_ns), \
                unittest.mock.patch('secrets.token_hex', lambda _: next(tokens)):
            self.prune()
        self.assertTrue(old_scheme.is_dir() and new_scheme.is_dir())
        self.assertEqual(list(new_scheme.iterdir()), [])
        self.assertNotIn(self.shas[2], self.remaining())

    def test_holding_directories_are_private_and_fully_removed(self):
        made = []
        real_mkdir = os.mkdir

        def mkdir(path, mode=0o777, *, dir_fd=None):
            made.append((path, mode))
            return real_mkdir(path, mode, dir_fd=dir_fd)
        with unittest.mock.patch.object(module.os, 'mkdir', mkdir):
            result = self.prune()
        self.assertEqual(result['removed'], sorted(self.shas[:3]))
        self.assertEqual(len(made), 3)
        self.assertTrue(all(module.TOMBSTONE.fullmatch(name) and mode == 0o700 for name, mode in made))
        self.assertEqual(self.remaining(), sorted(self.shas[-3:]))

    def test_a_platform_without_safe_fd_removal_skips_pruning(self):
        with unittest.mock.patch.object(module.shutil.rmtree, 'avoids_symlink_attacks', False):
            self.assert_skipped(self.prune(), 'platform_cannot_prune_safely')

    def test_a_releases_directory_that_is_a_symlink_is_not_pruned(self):
        real = self.root / 'real-releases'
        self.releases.rename(real)
        self.releases.symlink_to(real, target_is_directory=True)
        self.assertEqual(self.prune()['status'], 'skipped')
        self.assertEqual(len(list(real.iterdir())), 6)

    def test_only_the_deploy_layout_is_pruned(self):
        checkout = self.root / 'Vybertron'
        checkout.mkdir()
        deployer = prune_deployer(checkout, self.root / 'private', self.host, self.releases, self.mountinfo)
        self.assertEqual(deployer.prune_releases({})['status'], 'skipped')
        unconfigured = PortalDeployer(self.current, self.root / 'private', env_file=self.root / 'x.env',
                                      portal_env=self.root / 'p.env', runner=self.host)
        self.assertEqual(unconfigured.prune_releases({})['status'], 'skipped')
        self.assertEqual(len(self.remaining()), 6)

    def test_tolerates_half_written_and_missing_directories(self):
        half = self.releases / self.shas[0]
        (half / '.portal-release.json').unlink()
        tombstone = self.releases / ('.pruning-' + 'c' * 32)
        (tombstone / 'release' / 'ops').mkdir(parents=True)  # Left by an interrupted prune.
        self.assertEqual(self.prune()['status'], 'ok')
        self.assertNotIn(tombstone.name, self.remaining())
        shutil.rmtree(self.releases)
        self.assertEqual(self.prune(), {'status': 'skipped', 'reason': 'releases_path_not_trusted'})

    def test_tombstone_cleanup_honours_container_references_and_exact_names(self):
        referenced = self.releases / ('.pruning-' + '1' * 32)
        stale = self.releases / ('.pruning-' + '2' * 32)
        lookalikes = [self.releases / name for name in [
            '.pruning-old-1', '.pruning-' + 'a' * 31, '.pruning-' + 'a' * 33, '.pruning-' + 'A' * 32,
            '.pruning-' + 'a' * 32 + '-1', '.pruning-' + 'g' * 32, '.pruning-' + 'a' * 31 + '\u0661',
            '.pruning-' + 'a' * 32 + '\n', '.pruning-' + self.shas[0] + '-1700000000000000001',
            'pruning-' + 'a' * 32]]
        for path in [referenced, stale, *lookalikes]:
            path.mkdir()
        self.containers.append(container(2, mounts=[referenced / 'lavalink']))
        result = self.prune()
        self.assertEqual(result['status'], 'ok')
        self.assertTrue(referenced.is_dir())
        self.assertFalse(stale.exists())
        self.assertTrue(all(path.is_dir() for path in lookalikes))

    def test_an_unreadable_container_or_image_state_removes_nothing(self):
        for failing in ('ps', 'inspect', 'image'):
            self.failing = lambda args, failing=failing: args[1] == failing
            result = self.prune()
            self.assertEqual(result['status'], 'skipped')
            self.assertEqual(len(self.remaining()), 6)

    def test_a_realistic_later_deployment_removes_exactly_the_unused_old_releases(self):
        shutil.rmtree(self.releases)
        self.releases.mkdir()
        old = ['%02x' % i * 20 for i in range(1, 9)]  # Eight older releases, oldest first.
        for index, sha in enumerate(old):
            release_dir(self.releases, sha, 1_000_000 + index * 100)
        current = release_dir(self.releases, 'f0' * 20, 2_000_000)
        rollback, audio = old[2], old[0]  # Both older than the newest three.
        self.revisions = {OLD: rollback, WEB: rollback}
        self.deployer.repo = current
        files = lambda release: [release / 'docker-compose.yml', release / 'docker-compose.portal.yml']
        bot = container(1, working_dir=current, config_files=files(current))
        bot['Mounts'] = [{'Type': 'volume', 'Name': 'vybertron_bot-data', 'Destination': '/app/data',
                          'Source': '/var/lib/docker/volumes/vybertron_bot-data/_data'}]
        portal = container(2, working_dir=current, config_files=files(current))
        portal['Mounts'] = [{'Type': 'volume', 'Name': 'vybertron_portal-data', 'Destination': '/app/data',
                             'Source': '/var/lib/docker/volumes/vybertron_portal-data/_data'},
                            {'Type': 'tmpfs', 'Source': '', 'Destination': '/tmp'}]
        # Audio from an older operator release keeps its bind mounts there.
        lavalink = container(3, mounts=[self.releases / audio / 'lavalink/application.yml', self.releases / audio / 'lavalink/plugins'],
                             working_dir=self.releases / audio, config_files=[self.releases / audio / 'docker-compose.yml'])
        warp = container(4, mounts=[self.releases / audio / 'warp/supervise.sh'], working_dir=self.releases / audio)
        warp['Mounts'].append({'Type': 'volume', 'Name': 'vybertron_warp-data', 'Destination': '/var/lib/cloudflare-warp',
                               'Source': '/var/lib/docker/volumes/vybertron_warp-data/_data'})
        cipher = container(5, working_dir=self.releases / audio)
        funnel = container(6, working_dir='/root/Vybertron/ops/portal-funnel',
                           config_files=['/root/Vybertron/ops/portal-funnel/compose.yml'])
        self.containers = [bot, portal, lavalink, warp, cipher, funnel]
        journal = {'previous_images': {'bot': OLD, 'portal': WEB, 'warp': 'sha256:' + '1' * 64,
                                       'yt-cipher': 'sha256:' + '2' * 64, 'lavalink': 'sha256:' + '3' * 64}}
        result = self.deployer.prune_releases(journal)
        kept = sorted([current.name, old[-1], old[-2], rollback, audio])
        self.assertEqual(result, {'status': 'ok', 'kept': kept, 'removed': sorted(set(old) - set(kept))})
        self.assertEqual(self.remaining(), kept)

    def test_a_failed_removal_is_reported_without_raising(self):
        def rmtree(path, ignore_errors=False, onerror=None, *, onexc=None, dir_fd=None):
            raise PermissionError()
        rmtree.avoids_symlink_attacks = True
        with unittest.mock.patch.object(module.shutil, 'rmtree', rmtree):
            result = self.prune()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['failed'], sorted(self.shas[:3]))


class ReleasePruneDeployTests(unittest.TestCase):
    """A verified release prunes old sources; a pruning failure never fails it."""

    deploy = PortalReleasePolicyTests.deploy

    def setUp(self):
        PortalReleasePolicyTests.setUp(self)
        releases = self.root / 'releases'
        releases.mkdir()
        for index, sha in enumerate(['1' * 40, '2' * 40, '3' * 40, '4' * 40]):
            release_dir(releases, sha, 1_000_000 + index)
        self.repo = releases / SHA
        self.repo.mkdir()
        (self.repo / '.portal-release.json').write_text(json.dumps({'revision': SHA}))
        self.releases = releases
        self.harness.label = SHA
        original = self.harness.run
        self.prune_error = False

        def run(args, **kwargs):
            if args[:3] == ['docker', 'ps', '--all'] and '--quiet' in args:
                if self.prune_error:
                    raise DeploymentError('deployment_command_failed')
                return container(1)['Id']
            if args[:2] == ['docker', 'inspect'] and args[-1] == container(1)['Id']:
                return json.dumps([container(1, working_dir=self.repo)])
            if args[:3] == ['docker', 'image', 'inspect'] and args[3] == OLD:
                return json.dumps([{'Id': OLD, 'Config': {'Labels': {'org.opencontainers.image.revision': '2' * 40}}}])
            return original(args, **kwargs)
        mountinfo = self.root / 'mountinfo'
        mountinfo.write_text(NORMAL_MOUNTS)
        self.deployer = prune_deployer(self.repo, self.state, run, releases, mountinfo,
                                       env_file=self.env, portal_env=self.portal_env)

    def test_verified_release_prunes_older_sources(self):
        self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result['status'], 'ok')
        self.assertEqual(sorted(p.name for p in self.releases.iterdir()), sorted([SHA, '2' * 40, '3' * 40, '4' * 40]))

    def test_pruning_failure_does_not_fail_the_release(self):
        self.prune_error = True
        self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'skipped', 'reason': 'container_state_unknown'})
        self.assertEqual(len(list(self.releases.iterdir())), 5)
        self.assertEqual(json.loads((self.state / 'portal-deployment.json').read_text())['phase'], 'complete')

    def test_an_unexpected_pruning_error_does_not_fail_the_release(self):
        with unittest.mock.patch.object(PortalDeployer, '_prune_releases', side_effect=RuntimeError()):
            self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'failed', 'error': 'RuntimeError'})

    def test_an_exception_that_cannot_be_formatted_does_not_fail_the_release(self):
        class Unprintable(DeploymentError):
            def __str__(self):
                raise RuntimeError('cannot format')
        with unittest.mock.patch.object(PortalDeployer, '_prune_releases', side_effect=Unprintable()):
            self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'failed', 'error': 'prune_error'})
        with unittest.mock.patch.object(PortalDeployer, '_prune_releases', side_effect=module.PruneSkipped(Unprintable())):
            self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'skipped', 'reason': 'prune_error'})

    def test_nothing_inside_the_optional_prune_call_changes_the_outcome(self):
        with unittest.mock.patch.object(PortalDeployer, 'prune_releases', side_effect=RuntimeError()):
            self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'failed', 'error': 'prune_error'})

    def test_a_failed_release_prunes_nothing(self):
        self.harness.fail = 'portal'
        with self.assertRaises(DeploymentError):
            self.deploy()
        self.assertIsNone(self.deployer.prune_result)
        self.assertEqual(len(list(self.releases.iterdir())), 5)


class WindowsSkipTests(unittest.TestCase):
    def test_only_the_fcntl_lock_tests_are_skipped_on_windows(self):
        load = importlib.util.spec_from_file_location('portal_deploy_test_win32', Path(__file__))
        copy = importlib.util.module_from_spec(load)
        path = list(sys.path)
        with unittest.mock.patch.object(sys, 'platform', 'win32'), unittest.mock.patch.object(sys, 'path', list(path)):
            load.loader.exec_module(copy)
        self.assertEqual(sys.path, path)
        self.assertTrue(getattr(copy.MaintenanceLockTests, '__unittest_skip__', False))
        self.assertFalse(getattr(copy.ReleasePruneTests, '__unittest_skip__', False))
        self.assertEqual(copy.release_dir.__name__, 'release_dir')
        self.assertFalse(hasattr(copy.release_dir, '__wrapped__'))
        self.assertFalse(getattr(copy.release_dir, '__unittest_skip__', False))


@unittest.skipIf(sys.platform == 'win32', 'the maintenance lock uses fcntl')
class MaintenanceLockTests(unittest.TestCase):
    """The 5-minute recovery check briefly holds the same maintenance lock."""

    def setUp(self):
        import fcntl
        self.fcntl = fcntl
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.holder = open(self.root / 'maintenance.lock', 'a')
        self.addCleanup(self.holder.close)
        fcntl.flock(self.holder, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.deployed = []
        test = self

        class Driver:
            def __init__(self, *args, **kwargs):
                pass

            def deploy(self, sha, guild):
                # The driver must hold the lock itself by now.
                with open(test.root / 'maintenance.lock', 'a') as probe, test.assertRaises(BlockingIOError):
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                test.deployed.append(sha)
                return 'deployed'

        patches = {'LOCK': str(self.root / 'maintenance.lock'), 'PortalDeployer': Driver, 'LOCK_POLL': 0.02}
        for name, value in patches.items():
            original = getattr(module, name, None)
            setattr(module, name, value)
            self.addCleanup(setattr, module, name, original)

    def main(self, *extra):
        import contextlib
        import io
        argv = ['portal-driver.py', 'deploy', '--sha', SHA, '--guild-id', '1' * 18,
                '--repo', str(self.root / 'release'), '--state-dir', str(self.root / 'state'), *extra]
        output, code = io.StringIO(), 0
        original = sys.argv
        sys.argv = argv
        try:
            with contextlib.redirect_stdout(output):
                module.main()
        except SystemExit as error:
            code = error.code
        finally:
            sys.argv = original
        return code, json.loads(output.getvalue().strip().splitlines()[-1])

    def test_waits_for_a_briefly_held_maintenance_lock(self):
        import threading
        release = threading.Timer(0.2, self.fcntl.flock, (self.holder, self.fcntl.LOCK_UN))
        release.start()
        self.addCleanup(release.cancel)
        code, result = self.main()
        self.assertEqual((code, result), (0, {'status': 'deployed', 'sha': SHA}))
        self.assertEqual(self.deployed, [SHA])

    def test_a_lock_held_past_the_timeout_still_fails_before_changing_anything(self):
        code, result = self.main('--lock-timeout', '0.1')
        self.assertEqual((code, result), (1, {'status': 'failed', 'error': 'portal_maintenance_lock_busy'}))
        self.assertEqual(self.deployed, [])


if __name__ == '__main__':
    unittest.main()
