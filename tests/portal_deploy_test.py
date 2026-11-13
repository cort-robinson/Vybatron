import importlib.util
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


@unittest.skipIf(sys.platform == 'win32', 'the maintenance lock uses fcntl')
def release_dir(root, sha, mtime):
    path = root / sha
    (path / 'ops').mkdir(parents=True)
    (path / 'ops' / 'deploy.py').write_text('# source')
    (path / '.portal-release.json').write_text(json.dumps({'revision': sha}))
    os.utime(path, (mtime, mtime))
    return path


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
        self.previous_revision = self.shas[-2]
        self.containers = []
        self.failing = None
        self.deployer = PortalDeployer(self.current, self.root / 'private', env_file=self.root / 'x.env',
            portal_env=self.root / 'p.env', runner=self.host, sleep=lambda _: None)

    def host(self, args, **kwargs):
        if self.failing and self.failing(args):
            raise DeploymentError('deployment_command_failed')
        if args[:2] == ['docker', 'ps']:
            return '\n'.join(str(i) for i in range(len(self.containers)))
        if args[:2] == ['docker', 'inspect']:
            return json.dumps(self.containers)
        if args[:3] == ['docker', 'image', 'inspect']:
            revision = self.previous_revision if args[3] == OLD else 'f' * 40
            return json.dumps([{'Id': args[3], 'Config': {'Labels': {'org.opencontainers.image.revision': revision}}}])
        raise AssertionError('Unexpected external command: ' + str(args))

    def prune(self, keep=module.KEEP_RELEASES):
        return self.deployer.prune_releases({'previous_images': {'bot': OLD, 'portal': None}}, keep)

    def remaining(self):
        return sorted(p.name for p in self.releases.iterdir())

    def test_keeps_the_newest_releases_and_removes_older_ones(self):
        result = self.prune()
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.remaining(), sorted(self.shas[-3:]))
        self.assertEqual(result['removed'], sorted(self.shas[:3]))
        self.assertEqual(self.prune()['removed'], [])  # Idempotent.

    def test_never_removes_the_running_release_or_the_rollback_target(self):
        # Old mtimes: a retried staging keeps its original directory.
        os.utime(self.current, (1, 1))
        self.previous_revision = self.shas[0]
        result = self.prune(keep=1)
        self.assertEqual(result['status'], 'ok')
        self.assertEqual(self.remaining(), sorted([self.shas[0], self.shas[-2], self.shas[-1]]))

    def test_keeps_any_release_a_container_still_mounts_or_was_composed_from(self):
        self.containers = [
            {'Mounts': [{'Source': str(self.releases / self.shas[1] / 'lavalink' / 'application.yml')}], 'Config': {'Labels': {}}},
            {'Mounts': [], 'Config': {'Labels': {
                'com.docker.compose.project.working_dir': str(self.releases / self.shas[0]),
                'com.docker.compose.project.config_files': '/root/Vybertron/docker-compose.yml,' + str(self.releases / self.shas[2] / 'docker-compose.portal.yml')}}},
        ]
        self.prune(keep=1)
        self.assertEqual(self.remaining(), sorted([self.shas[0], self.shas[1], self.shas[2], self.shas[-2], self.shas[-1]]))

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

    def test_refuses_a_path_that_resolves_outside_the_releases_directory(self):
        outside = self.root / 'outside'
        outside.mkdir()
        with self.assertRaisesRegex(DeploymentError, 'outside_releases'):
            PortalDeployer.remove_inside(self.releases.resolve(), outside)
        self.assertTrue(outside.is_dir())

    def test_a_releases_directory_that_is_a_symlink_is_not_pruned(self):
        real = self.root / 'real-releases'
        self.releases.rename(real)
        self.releases.symlink_to(real, target_is_directory=True)
        self.assertEqual(self.prune()['status'], 'skipped')
        self.assertEqual(len(list(real.iterdir())), 6)

    def test_only_the_deploy_layout_is_pruned(self):
        checkout = self.root / 'Vybertron'
        checkout.mkdir()
        deployer = PortalDeployer(checkout, self.root / 'private', env_file=self.root / 'x.env',
            portal_env=self.root / 'p.env', runner=self.host)
        self.assertEqual(deployer.prune_releases({})['status'], 'skipped')
        self.assertEqual(len(self.remaining()), 6)

    def test_tolerates_half_written_and_missing_directories(self):
        half = self.releases / self.shas[0]
        (half / '.portal-release.json').unlink()
        (self.releases / '.pruning-old-1').mkdir()  # Left by an interrupted prune.
        self.assertEqual(self.prune()['status'], 'ok')
        self.assertNotIn('.pruning-old-1', self.remaining())
        shutil.rmtree(self.releases)
        self.assertEqual(self.prune()['status'], 'failed')

    def test_an_unreadable_container_or_image_state_removes_nothing(self):
        for failing in ('ps', 'inspect', 'image'):
            self.failing = lambda args, failing=failing: args[1] == failing
            self.containers = [{'Mounts': []}]
            result = self.prune()
            self.assertEqual(result, {'status': 'failed', 'error': 'deployment_command_failed'})
            self.assertEqual(len(self.remaining()), 6)

    def test_a_failed_removal_is_reported_without_raising(self):
        with unittest.mock.patch.object(module.shutil, 'rmtree', side_effect=PermissionError()):
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

        def run(args, **kwargs):
            if args[:3] == ['docker', 'ps', '--all'] and '--quiet' in args:
                if self.prune_error:
                    raise DeploymentError('deployment_command_failed')
                return ''
            return original(args, **kwargs)
        self.prune_error = False
        self.deployer = PortalDeployer(self.repo, self.state, env_file=self.env,
            portal_env=self.portal_env, runner=run, sleep=lambda _: None)

    def test_verified_release_prunes_older_sources(self):
        self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result['status'], 'ok')
        self.assertEqual(sorted(p.name for p in self.releases.iterdir()), sorted([SHA, '3' * 40, '4' * 40]))

    def test_pruning_failure_does_not_fail_the_release(self):
        self.prune_error = True
        self.assertEqual(self.deploy(), 'deployed')
        self.assertEqual(self.deployer.prune_result, {'status': 'failed', 'error': 'deployment_command_failed'})
        self.assertEqual(len(list(self.releases.iterdir())), 5)
        self.assertEqual(json.loads((self.state / 'portal-deployment.json').read_text())['phase'], 'complete')

    def test_a_failed_release_prunes_nothing(self):
        self.harness.fail = 'portal'
        with self.assertRaises(DeploymentError):
            self.deploy()
        self.assertIsNone(self.deployer.prune_result)
        self.assertEqual(len(list(self.releases.iterdir())), 5)


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
