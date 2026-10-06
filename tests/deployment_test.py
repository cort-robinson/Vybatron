import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('deployment', Path(__file__).resolve().parents[1] / 'ops/deploy.py')
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)
OLD, NEW = 'a' * 40, 'b' * 40
PREVIOUS_IMAGES = {name: 'sha256:' + char * 64 for name, char in zip(d.SERVICES, 'abcd')}
RELEASE_IMAGE = 'sha256:' + 'e' * 64


class FakeHost:
    def __init__(self, root):
        self.repo, self.directory = root / 'repo', root / 'state'
        (self.repo / 'lavalink').mkdir(parents=True)
        (self.repo / 'lavalink/application.yml').write_text('tested-runtime-pin\n')
        self.head = OLD
        self.current_images = dict(PREVIOUS_IMAGES)
        self.calls, self.probes = [], []
        self.busy, self.bot_running, self.stale = False, True, False
        self.changed, self.dirty = 'docker-compose.yml', ''
        self.probe_fails, self.register_fails, self.bot_fails = False, False, False
        self.busy_after_start_failure = False
        self.clear_runtime_override = False
        self.busy_after_build = False
        self.build_fails = False

    def run(self, args, **kwargs):
        self.calls.append(args)
        if args[:2] == ['docker', 'ps']:
            return 'vybertron-portal' if getattr(self, 'portal', False) else ''
        if args[:3] == ['git', 'rev-parse', 'HEAD']:
            return self.head
        if args[:3] == ['git', 'reset', '--hard']:
            self.head = args[3]
            return ''
        if args[:3] == ['git', 'merge-base', '--is-ancestor'] and args[-1] == OLD:
            if not self.stale:
                raise d.DeploymentError('not_ancestor')
        if args[:3] == ['git', 'diff', '--name-only']:
            return self.dirty if args[3] == 'HEAD' else self.changed
        if args[:3] == ['docker', 'inspect', '--format']:
            if args[3] == '{{.State.Running}}':
                return 'true' if self.bot_running else 'false'
            return self.current_images[args[-1].replace('vybertron-', '')]
        if args[:3] == ['docker', 'image', 'inspect']:
            return RELEASE_IMAGE
        if args[:2] == ['docker', 'build']:
            self.busy = self.busy_after_build
            if self.build_fails:
                raise d.DeploymentError('build_failed')
        if args[:3] == ['python3', 'ops/recovery.py', 'restore-pin'] and self.head == NEW and self.clear_runtime_override:
            state = d.read(self.directory / 'state.json')
            state.pop('override', None)
            d.write(self.directory / 'state.json', json.dumps(state))
        if args[:3] == ['docker', 'exec', '-i']:
            begin = '/maintenance/begin' in kwargs['data']
            return json.dumps({'active': begin, 'busy': self.busy, 'inFlight': 0})
        if args[:2] == ['docker', 'compose']:
            images = {name: value['image'] for name, value in json.loads(Path(args[5]).read_text())['services'].items()}
            action = args[6]
            if action == 'stop' and 'bot' in args:
                self.bot_running = False
            if action == 'run' and images['bot'] == RELEASE_IMAGE and self.register_fails:
                raise d.DeploymentError('command_registration_failed')
            if action == 'up' and args[-1] == 'bot':
                self.bot_running = True
                self.current_images = images
                if images['bot'] == RELEASE_IMAGE and self.bot_fails:
                    self.busy = self.busy_after_start_failure
                    raise d.DeploymentError('bot_not_ready')
        return ''

    def probe(self, full):
        self.probes.append(full)
        if full and self.probe_fails:
            raise d.DeploymentError('probe_failed')


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.host = FakeHost(Path(temporary.name))
        self.deployer = d.Deployer(self.host.repo, self.host.directory, runner=self.host.run,
                                   probe=self.host.probe, sleep=lambda _: None)

    def docker_calls(self, action):
        return [args for args in self.host.calls if args[:2] == ['docker', 'compose'] and args[6] == action]

    def test_release_uses_exact_commit_and_preserves_tested_audio_images(self):
        self.assertEqual(self.deployer.deploy(NEW), 'deployed')
        self.assertIn(['git', 'reset', '--hard', NEW], self.host.calls)
        self.assertNotIn(['git', 'reset', '--hard', 'origin/main'], self.host.calls)
        self.assertEqual(self.host.head, NEW)
        self.assertEqual(self.host.current_images, {**PREVIOUS_IMAGES, 'bot': RELEASE_IMAGE})
        self.assertEqual(self.host.probes, [True])
        journal = d.read(self.deployer.journal_path)
        self.assertEqual(journal['phase'], 'complete')
        self.assertEqual(journal['bot_image'], RELEASE_IMAGE)
        self.assertFalse(any(args[:3] == ['docker', 'compose', 'pull'] for args in self.host.calls))
        audio_up = [args for args in self.docker_calls('up') if args[-1] == 'lavalink']
        self.assertEqual(audio_up[0][-3:], ['warp', 'yt-cipher', 'lavalink'])
        self.assertIn('--pull', audio_up[0])
        self.assertIn('never', audio_up[0])

    def test_portal_hosts_refuse_the_bot_only_release_before_any_change(self):
        self.host.portal = True
        with self.assertRaisesRegex(d.DeploymentError, 'portal_overlay_requires_portal_driver'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)
        self.assertFalse(any(args[:2] in (['git', 'fetch'], ['git', 'reset'], ['docker', 'build'], ['docker', 'compose']) for args in self.host.calls))
        self.assertFalse(self.deployer.journal_path.exists())

    def test_out_of_order_ci_and_busy_queues_do_not_touch_git_or_running_services(self):
        self.host.stale = True
        self.assertEqual(self.deployer.deploy(NEW), 'skipped_older_ci_run')
        self.assertFalse(self.docker_calls('stop'))
        self.host.stale, self.host.busy = False, True
        with self.assertRaisesRegex(d.DeploymentError, 'waiting_for_idle'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)
        self.assertFalse(self.docker_calls('stop'))

    def test_invalid_targets_and_unrelated_local_changes_are_rejected(self):
        for target in ['origin/main', NEW + '\n', '--all', None]:
            with self.assertRaisesRegex(d.DeploymentError, 'invalid_deployment_sha'):
                self.deployer.deploy(target)
        self.host.dirty = 'src/index.js'
        with self.assertRaisesRegex(d.DeploymentError, 'local_changes'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)

    def test_audio_probe_failure_restores_previous_commit_config_and_images(self):
        self.host.probe_fails = True
        with self.assertRaisesRegex(d.DeploymentError, 'previous_release_restored'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)
        self.assertEqual(self.host.current_images, PREVIOUS_IMAGES)
        self.assertEqual((self.host.repo / 'lavalink/application.yml').read_text(), 'tested-runtime-pin\n')
        self.assertEqual(d.read(self.deployer.journal_path)['phase'], 'rolled_back')
        self.assertEqual(self.host.probes, [True, False])

    def test_failed_command_registration_restores_the_previous_command_catalog(self):
        self.host.register_fails = True
        with self.assertRaisesRegex(d.DeploymentError, 'previous_release_restored'):
            self.deployer.deploy(NEW)
        self.assertEqual(len(self.docker_calls('run')), 2)
        self.assertEqual(self.host.current_images, PREVIOUS_IMAGES)

    def test_rollback_restores_the_tested_runtime_pin_even_if_a_new_repo_pin_removed_its_override(self):
        previous_override = {'baseline': OLD, 'version': 'c' * 40}
        d.write(self.host.directory / 'state.json', json.dumps({'override': previous_override}))
        self.host.clear_runtime_override, self.host.register_fails = True, True
        with self.assertRaisesRegex(d.DeploymentError, 'previous_release_restored'):
            self.deployer.deploy(NEW)
        self.assertEqual(d.read(self.host.directory / 'state.json')['override'], previous_override)

    def test_bot_only_change_preserves_shared_audio_namespace(self):
        self.host.changed = ''
        self.deployer.deploy(NEW)
        self.assertFalse(any(args[-1] == 'lavalink' for args in self.docker_calls('up')))
        self.assertEqual(self.host.current_images['warp'], PREVIOUS_IMAGES['warp'])

    def test_a_session_started_after_a_long_build_prevents_service_changes_and_restores_only_files(self):
        self.host.busy_after_build = True
        with self.assertRaisesRegex(d.DeploymentError, 'previous_release_restored'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)
        self.assertTrue(self.host.bot_running)
        self.assertTrue(self.host.busy)
        self.assertEqual(self.host.current_images, PREVIOUS_IMAGES)
        self.assertFalse(self.docker_calls('stop'))
        self.assertFalse(self.docker_calls('up'))
        self.assertEqual(self.host.probes, [])
        self.assertEqual(d.read(self.deployer.journal_path)['phase'], 'rolled_back')

    def test_failed_build_does_not_restart_the_healthy_previous_stack(self):
        self.host.build_fails = True
        with self.assertRaisesRegex(d.DeploymentError, 'previous_release_restored'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, OLD)
        self.assertFalse(self.docker_calls('stop'))
        self.assertFalse(self.docker_calls('up'))
        self.assertEqual(d.read(self.deployer.journal_path)['services_changed'], False)

    def test_a_new_active_session_prevents_rollback_and_preserves_the_pending_journal(self):
        self.host.bot_fails, self.host.busy_after_start_failure = True, True
        with self.assertRaisesRegex(d.DeploymentError, 'waiting_for_idle'):
            self.deployer.deploy(NEW)
        self.assertEqual(self.host.head, NEW)
        self.assertEqual(d.read(self.deployer.journal_path)['phase'], 'starting_bot')
        with self.assertRaisesRegex(d.DeploymentError, 'incomplete_deployment'):
            self.deployer.deploy(NEW)

    def test_interrupted_deployment_can_roll_back_from_its_durable_journal(self):
        backup = self.host.directory / ('deployment-config-' + OLD + '.yml')
        d.write(backup, 'original-config\n')
        d.write(self.deployer.journal_path, json.dumps({'phase': 'releasing', 'previous_sha': OLD,
                'previous_images': PREVIOUS_IMAGES, 'config_backup': backup.name}))
        self.host.head, self.host.bot_running = NEW, False
        self.assertEqual(self.deployer.rollback(), 'rolled_back')
        self.assertEqual(self.host.head, OLD)
        self.assertEqual((self.host.repo / 'lavalink/application.yml').read_text(), 'original-config\n')

    def test_rollback_rejects_escape_paths_and_exhausted_attempts(self):
        journal = {'phase': 'releasing', 'previous_sha': OLD, 'previous_images': PREVIOUS_IMAGES,
                   'config_backup': '../deployment-config-private.yml'}
        with self.assertRaisesRegex(d.DeploymentError, 'invalid_deployment_rollback'):
            self.deployer.rollback(journal)
        journal['rollback_attempts'] = 2
        with self.assertRaisesRegex(d.DeploymentError, 'requires_attention'):
            self.deployer.rollback(journal)
        self.assertFalse(self.docker_calls('stop'))


if __name__ == '__main__':
    unittest.main()
