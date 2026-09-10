import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'ops/recovery.py')
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
OLD, NEW, MANUAL = 'a' * 40, 'b' * 40, 'c' * 40
CONFIG = f'''lavalink:
  plugins:
    - dependency: "dev.lavalink.youtube:youtube-plugin:{OLD}"
      repository: "https://maven.lavalink.dev/snapshots"
      snapshot: true
    - dependency: "example:unrelated:1.0.0"
      repository: "https://example.com"
      snapshot: false
  server:
    password: ${{LAVALINK_PASSWORD}}
plugins:
  youtube:
    clients: [TV, WEB]
'''


def result(ok=True, category='source'):
    return {'ok': ok, 'searchOk': True, 'tracks': [{'ok': ok, 'category': 'audio' if ok else category}] * 2}


class FakeBackend:
    def __init__(self, root):
        self.directory = root / 'state'
        self.repo = root / 'repo'
        self.config_path = self.repo / 'lavalink/application.yml'
        r.atomic_write(self.config_path, CONFIG)
        self.settings = {'auto_update': True}
        self.kind, self.playing, self.idle, self.gate = 'ready', 0, True, True
        self.available, self.calls = [], []
        self.results, self.verify_ok, self.deploy_error, self.fix_recovery = {}, True, False, False

    def current(self):
        return r.version_of(self.config_path.read_text())

    def observe(self):
        return {'kind': self.kind, 'playing': self.playing, 'version': self.current(), 'search': True}

    def probe(self, version, full=False, installed=False):
        self.calls.append(('probe', version, full, installed))
        return self.results.get(version, result())

    def candidates(self, current):
        self.calls.append(('candidates', current))
        return self.available

    def update_idle(self):
        return self.idle

    def begin_update(self):
        self.calls.append(('begin',))
        return self.gate

    def end_update(self):
        self.calls.append(('end',))

    def deploy(self):
        self.calls.append(('deploy', self.current()))
        if self.deploy_error:
            raise r.RecoveryError('services_not_ready')

    def verify(self, version):
        self.calls.append(('verify', version))
        return self.verify_ok

    def recover(self, kind):
        self.calls.append(('recover', kind))
        if self.fix_recovery:
            self.kind = 'ready'


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = FakeBackend(Path(self.temp.name))
        self.coordinator = r.Coordinator(self.backend)
        self.clock = 100000
        self.git = patch.object(r, 'command', return_value=CONFIG)
        self.git.start()
        self.addCleanup(self.git.stop)

    def cycle(self, delta=300, **kwargs):
        self.clock += delta
        return self.coordinator.cycle(self.clock, **kwargs)

    def calls(self, name):
        return [call for call in self.backend.calls if call[0] == name]

    def test_two_failures_before_recovery_with_cooldown_and_window_limit(self):
        self.backend.kind = 'network'
        self.cycle()
        self.assertFalse(self.calls('recover'))
        self.cycle()
        self.assertEqual(len(self.calls('recover')), 1)
        self.cycle()
        self.assertEqual(len(self.calls('recover')), 1)
        self.cycle(delta=r.RECOVERY_COOLDOWN)
        self.assertEqual(len(self.calls('recover')), 2)
        self.cycle(delta=r.RECOVERY_COOLDOWN)
        self.assertEqual(len(self.calls('recover')), 2)
        self.cycle(delta=r.RECOVERY_WINDOW)
        self.assertEqual(len(self.calls('recover')), 3)

    def test_stopped_containers_and_known_playing_players_are_not_restarted(self):
        self.backend.kind = 'stopped'
        self.cycle()
        self.cycle()
        self.backend.kind, self.backend.playing = 'bot', 1
        self.cycle()
        self.cycle()
        self.assertFalse(self.calls('recover'))

    def test_recovery_must_pass_audio_and_alerts_are_deduplicated(self):
        self.backend.kind = 'network'
        self.cycle()
        self.cycle()
        self.cycle()
        self.assertEqual(len(self.coordinator.state['outbox']), 1)
        self.backend.kind = 'ready'
        self.backend.results[OLD] = result(False)
        self.assertEqual(self.cycle()['status'], 'source')
        self.backend.results[OLD] = result()
        self.assertEqual(self.cycle()['status'], 'healthy')
        self.cycle()
        messages = [event['message'] for event in self.coordinator.state['outbox']]
        self.assertEqual(sum('has recovered' in message for message in messages), 1)
        self.assertFalse(any('monitoring is enabled' in message for message in messages))

    def test_short_audio_failure_does_not_trigger_blind_restarts(self):
        self.backend.results[OLD] = result(False)
        self.cycle()
        self.cycle()
        self.assertFalse(self.calls('recover'))
        self.assertFalse(self.calls('deploy'))
        self.assertEqual(self.coordinator.state['status'], 'source')

    def test_credentials_do_not_trigger_plugin_updates(self):
        self.backend.results[OLD] = result(False, 'credentials')
        self.backend.available = [NEW]
        self.cycle()
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'credentials')
        self.assertFalse(self.calls('candidates'))
        self.assertFalse(self.calls('deploy'))

    def test_probe_runtime_failures_do_not_trigger_plugin_updates(self):
        self.backend.results[OLD] = result(False, 'probe_environment')
        self.backend.available = [NEW]
        self.cycle()
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'monitor_error')
        self.assertFalse(self.calls('candidates'))
        self.assertFalse(self.calls('deploy'))

    def test_unavailable_content_does_not_trigger_plugin_updates(self):
        self.backend.results[OLD] = result(False, 'unavailable')
        self.backend.available = [NEW]
        self.cycle()
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'canary_degraded')
        self.assertFalse(self.calls('candidates'))
        self.assertFalse(self.calls('deploy'))

    def test_probe_cache_retention_preserves_current_bundle_and_unrelated_files(self):
        cache = Path(self.temp.name) / 'cache'
        active = cache / ('a' * 24)
        for name in ['a' * 24, 'b' * 24, 'c' * 24, 'd' * 24, 'unrelated']:
            (cache / name).mkdir(parents=True)
            (cache / name / 'file').write_text('fixture')
        r.trim_probe_cache(cache, active)
        self.assertTrue(active.exists())
        self.assertTrue((cache / 'unrelated/file').exists())
        self.assertEqual(len(list(cache.iterdir())), 4)

    def test_candidate_is_deferred_for_active_or_paused_queue_and_rechecked(self):
        self.backend.available = [NEW]
        self.backend.idle = False
        self.cycle()
        self.assertEqual(self.coordinator.state['candidate'], NEW)
        self.assertFalse(self.calls('deploy'))
        self.assertFalse(any(call[2] for call in self.calls('probe')))
        self.backend.idle = True
        self.cycle()
        self.assertEqual(self.backend.current(), NEW)

    def test_play_started_during_trial_prevents_installation(self):
        self.backend.available, self.backend.gate = [NEW], False
        self.cycle()
        self.assertTrue(any(call[2] for call in self.calls('probe')))
        self.assertFalse(self.calls('deploy'))
        self.assertEqual(self.backend.current(), OLD)
        self.assertEqual(self.coordinator.state['candidate'], NEW)

    def test_failed_candidate_never_touches_live_config_or_retries_immediately(self):
        self.backend.available = [NEW]
        self.backend.results[NEW] = result(False)
        self.cycle()
        self.cycle()
        self.assertEqual(self.backend.config_path.read_text(), CONFIG)
        self.assertFalse(self.calls('deploy'))
        self.assertEqual(len([call for call in self.calls('probe') if call[1] == NEW]), 1)

    def test_promotion_requires_full_trial_and_post_install_verification(self):
        self.backend.available = [NEW]
        self.cycle()
        calls = self.backend.calls
        self.assertLess(calls.index(('probe', NEW, True, False)), calls.index(('deploy', NEW)))
        self.assertLess(calls.index(('deploy', NEW)), calls.index(('verify', NEW)))
        self.assertEqual(self.backend.current(), NEW)
        self.assertNotIn('pending', self.coordinator.state)
        self.assertEqual(self.coordinator.state['override'], {'baseline': OLD, 'version': NEW})
        self.assertEqual(r.read_json(self.coordinator.path)['override']['version'], NEW)

    def test_failed_installation_restores_previous_configuration(self):
        self.backend.available, self.backend.verify_ok = [NEW], False
        self.cycle()
        self.assertEqual(self.calls('deploy'), [('deploy', NEW), ('deploy', OLD)])
        self.assertEqual(self.backend.config_path.read_text(), CONFIG)
        self.assertNotIn('pending', self.coordinator.state)
        self.assertIn(NEW, self.coordinator.state['rejected'])
        self.assertEqual(self.coordinator.state['status'], 'healthy')

    def test_failed_rollback_never_reports_healthy_and_is_bounded(self):
        self.backend.available, self.backend.deploy_error = [NEW], True
        self.assertEqual(self.cycle()['status'], 'rollback_failed')
        with self.assertRaises(r.RecoveryError):
            self.cycle()
        self.assertEqual(len(self.calls('deploy')), 3)
        with self.assertRaisesRegex(r.RecoveryError, 'rollback_requires_attention'):
            self.cycle()
        self.assertEqual(len(self.calls('deploy')), 3)

    def test_interrupted_update_rolls_back_after_process_restart_and_waits_for_idle(self):
        backup = self.backend.directory / 'backup-test.yml'
        r.atomic_write(backup, CONFIG)
        r.atomic_write(self.backend.config_path, r.pin_config(CONFIG, NEW))
        self.coordinator.state['pending'] = {'candidate': NEW, 'previous': OLD, 'backup': backup.name}
        self.coordinator.save()
        self.coordinator = r.Coordinator(self.backend)
        self.backend.gate = False
        with self.assertRaisesRegex(r.RecoveryError, 'rollback_waiting_for_idle'):
            self.cycle()
        self.assertFalse(self.calls('deploy'))
        self.backend.gate = True
        self.cycle()
        self.assertEqual(self.backend.current(), OLD)
        self.assertNotIn('pending', self.coordinator.state)

    def test_observe_only_never_recovers_or_installs(self):
        self.backend.available, self.backend.kind = [NEW], 'network'
        self.cycle(observe_only=True)
        self.cycle(observe_only=True)
        self.backend.kind = 'ready'
        self.cycle(observe_only=True)
        self.assertFalse(self.calls('recover'))
        self.assertFalse(self.calls('deploy'))
        self.assertFalse(self.calls('candidates'))

    def test_runtime_pin_survives_unrelated_deploy_but_explicit_repo_pin_wins(self):
        r.save_json(self.coordinator.path, {'override': {'baseline': OLD, 'version': NEW}})
        r.restore_runtime_pin(self.backend.repo, self.backend.directory)
        self.assertEqual(self.backend.current(), NEW)
        self.assertIn('example:unrelated:1.0.0', self.backend.config_path.read_text())
        r.atomic_write(self.backend.config_path, r.pin_config(CONFIG, MANUAL))
        r.restore_runtime_pin(self.backend.repo, self.backend.directory)
        self.assertEqual(self.backend.current(), MANUAL)
        self.assertNotIn('override', r.read_json(self.coordinator.path))

    def test_pins_validate_versions_and_preserve_other_plugin_settings(self):
        updated = r.pin_config(CONFIG, '1.19.0')
        self.assertIn('repository: "https://maven.lavalink.dev/releases"\n      snapshot: false', updated)
        self.assertIn('repository: "https://example.com"\n      snapshot: false', updated)
        self.assertIn('${LAVALINK_PASSWORD}', updated)
        with self.assertRaises(r.RecoveryError):
            r.pin_config(CONFIG, '../../untrusted')
        with self.assertRaises(r.RecoveryError):
            r.pin_config(CONFIG + CONFIG, NEW)


if __name__ == '__main__':
    unittest.main()
