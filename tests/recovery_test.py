import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
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
    # As the short probe reports it: 250 decoded frames per passing canary.
    track = {'ok': True, 'category': 'audio', 'frames': 250} if ok else {'ok': False, 'category': category, 'frames': 0}
    return {'ok': ok, 'searchOk': True, 'tracks': [dict(track) for _ in r.TRACKS]}


def partial(category='source'):
    return {'ok': False, 'searchOk': True, 'tracks': [{'ok': True, 'category': 'audio'}, {'ok': False, 'category': category}]}


class FakeBackend:
    def __init__(self, root):
        self.directory = root / 'state'
        self.repo = root / 'repo'
        self.config_path = self.repo / 'lavalink/application.yml'
        r.atomic_write(self.config_path, CONFIG)
        self.settings = {'auto_update': True}
        self.kind, self.playing, self.idle, self.gate = 'ready', 0, True, True
        self.available, self.calls = [], []
        self.failures, self.probed_tracks, self.queued = [], [], []
        self.results, self.verify_ok, self.deploy_error, self.fix_recovery = {}, True, False, False
        self.mirror_error = None
        self.services = None  # Fingerprint of the service containers; None never skips a decode.
        self.search, self.canaries = True, [True] * len(r.TRACKS)
        self.monotonic, self.boot = 5000.0, '0f2c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'

    def current(self):
        return r.version_of(self.config_path.read_text())

    def observe(self):
        return {'kind': self.kind, 'playing': self.playing, 'version': self.current(), 'search': self.search,
                'canaries': self.canaries, 'failures': self.failures, 'services': self.services}

    def clock(self):
        return {'monotonic': self.monotonic, 'boot': self.boot}

    def probe(self, version, full=False, installed=False, tracks=None):
        self.calls.append(('probe', version, full, installed))
        self.probed_tracks.append(tracks)
        if self.queued:
            return self.queued.pop(0)
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

    def mirror_plugins(self):
        self.calls.append(('mirror',))
        if self.mirror_error:
            raise r.RecoveryError(self.mirror_error)

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

    def live_failure(self):
        self.backend.failures = [{'id': 'event-1', 'at': self.clock * 1000, 'identifier': 'RYnFIRc0k6E'}]

    def test_live_failure_with_passing_fresh_probe_recovers_once(self):
        self.live_failure()
        self.cycle()
        self.assertEqual(self.calls('deploy'), [('deploy', OLD)])
        self.assertEqual(self.backend.probed_tracks[0], ['https://www.youtube.com/watch?v=RYnFIRc0k6E'])
        self.assertIn('event-1', self.coordinator.state['handled_failures'])
        self.cycle()
        self.assertEqual(len(self.calls('deploy')), 1)
        self.assertEqual(len(self.calls('end')), 1)

    def test_live_failure_waits_for_idle_queue(self):
        self.live_failure()
        self.backend.idle = False
        self.assertEqual(self.cycle()['status'], 'live_playback')
        self.assertFalse(self.calls('deploy'))
        self.assertNotIn('handled_failures', self.coordinator.state)

    def test_live_failure_honors_existing_recovery_cooldown(self):
        self.live_failure()
        self.coordinator.state['recoveries'] = [self.clock]
        self.assertEqual(self.cycle()['status'], 'live_playback')
        self.assertFalse(self.calls('deploy'))

    def test_reproducible_live_source_failure_does_not_blindly_restart(self):
        self.live_failure()
        self.backend.results[OLD] = result(False)
        self.assertEqual(self.cycle()['status'], 'source')
        self.assertFalse(self.calls('deploy'))
        self.assertEqual(self.backend.probed_tracks[0], ['https://www.youtube.com/watch?v=RYnFIRc0k6E'])

    def test_live_failure_observe_only_cannot_restart(self):
        self.live_failure()
        self.cycle(observe_only=True)
        self.assertFalse(self.calls('deploy'))

    def test_failed_live_recovery_is_rate_limited_and_not_acknowledged(self):
        self.live_failure()
        self.backend.deploy_error = True
        with self.assertRaises(r.RecoveryError):
            self.cycle()
        self.assertEqual(len(self.calls('end')), 1)
        self.assertNotIn('handled_failures', self.coordinator.state)
        self.cycle()
        self.assertEqual(len(self.calls('deploy')), 1)

    def test_expired_and_invalid_live_failure_ids_are_ignored(self):
        self.backend.failures = [{'id': 'expired', 'at': 0, 'identifier': 'RYnFIRc0k6E'},
                                 {'id': 'invalid', 'at': self.clock * 1000, 'identifier': 'https://private.example'}]
        self.cycle()
        self.assertFalse(self.calls('deploy'))
        self.assertEqual(self.backend.probed_tracks, [None])

    def test_stopped_containers_and_known_playing_players_are_not_restarted(self):
        self.backend.kind = 'stopped'
        self.cycle()
        self.cycle()
        self.backend.kind, self.backend.playing = 'bot', 1
        self.cycle()
        self.cycle()
        self.assertFalse(self.calls('recover'))

    def test_unknown_player_count_still_requires_an_idle_queue_and_maintenance_gate(self):
        self.backend.kind, self.backend.playing, self.backend.idle = 'namespace', None, False
        self.cycle()
        self.cycle()
        self.assertFalse(self.calls('recover'))
        self.backend.idle, self.backend.gate = True, False
        self.cycle()
        self.assertFalse(self.calls('recover'))
        self.backend.gate = True
        self.cycle()
        self.assertEqual(self.calls('recover'), [('recover', 'namespace')])
        self.assertEqual(len(self.calls('end')), 1)

    def test_an_interrupted_deployment_blocks_monitor_recovery_and_source_updates(self):
        r.save_json(self.backend.directory / 'deployment.json', {'phase': 'releasing'})
        self.backend.available, self.backend.kind = [NEW], 'network'
        self.cycle()
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'pending_deployment')
        self.assertFalse(self.calls('recover'))
        self.assertFalse(self.calls('candidates'))
        self.assertFalse(self.calls('deploy'))

    def test_testing_one_live_failure_does_not_acknowledge_a_different_video(self):
        self.backend.failures = [
            {'id': 'first-event', 'at': self.clock * 1000, 'identifier': 'jNQXAC9IVRw'},
            {'id': 'last-event', 'at': self.clock * 1000, 'identifier': 'RYnFIRc0k6E'}]
        self.cycle()
        self.assertEqual(self.coordinator.state['handled_failures'], ['last-event'])

    def test_probe_schema_filters_private_fields_and_rejects_false_success(self):
        value = {'ok': True, 'searchOk': True, 'private': 'signed-url',
                 'tracks': [{'ok': True, 'category': 'audio', 'frames': 300, 'private': 'token'}]}
        clean = r.probe_result(value)
        self.assertNotIn('private', clean)
        self.assertNotIn('private', clean['tracks'][0])
        value['tracks'][0]['ok'] = False
        with self.assertRaisesRegex(r.RecoveryError, 'invalid_probe_response'):
            r.probe_result(value)

    def test_invalid_monitor_settings_cannot_enable_unintended_updates_or_alerts(self):
        for settings in [{'auto_update': 'false'}, {'discord_guild_id': 'private'},
                         {'discord_guild_id': '123456789012345678', 'discord_channel_id': 'private'}]:
            with self.assertRaises(r.RecoveryError):
                r.validate_settings(settings)
        self.assertEqual(r.validate_settings({'auto_update': False}), {'auto_update': False})

    def test_alert_delivery_is_bounded_and_failed_delivery_preserves_the_outbox(self):
        sent = []
        self.backend.notify = lambda event: sent.append(event) or False
        for index in range(r.MAX_OUTBOX + 5):
            self.coordinator.event('Operational event ' + str(index))
        self.assertEqual(len(self.coordinator.state['outbox']), r.MAX_OUTBOX)
        r.deliver_alerts(self.coordinator)
        self.assertEqual(len(sent), 1)
        self.assertEqual(len(self.coordinator.state['outbox']), r.MAX_OUTBOX)
        self.backend.notify = lambda event: sent.append(event) or True
        r.deliver_alerts(self.coordinator)
        self.assertEqual(len(self.coordinator.state['outbox']), r.MAX_OUTBOX - r.MAX_ALERTS_PER_RUN)

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

    def attention(self):
        return [event for event in self.coordinator.state.get('outbox', []) if 'needs attention' in event['message']]

    def test_canary_failure_that_passes_on_retry_is_healthy(self):
        self.backend.queued = [partial()]
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'healthy')
        self.assertEqual(self.coordinator.state['failures'], 0)
        self.assertEqual(len(self.calls('probe')), 2)

    def test_degraded_canaries_alert_only_after_three_runs(self):
        self.backend.settings['auto_update'] = False
        self.backend.results[OLD] = partial()
        self.cycle()
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'canary_degraded')
        self.assertFalse(self.attention())
        self.cycle()
        self.assertEqual(len(self.attention()), 1)

    def test_complete_playback_failure_still_alerts_after_two_runs(self):
        self.backend.settings['auto_update'] = False
        self.backend.results[OLD] = result(False)
        self.cycle()
        self.assertFalse(self.attention())
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'source')
        self.assertEqual(len(self.attention()), 1)

    def test_unresponsive_cipher_is_restarted_when_idle(self):
        self.backend.kind, self.backend.fix_recovery = 'cipher', True
        self.cycle()
        self.assertEqual(self.coordinator.state['status'], 'cipher')
        self.assertFalse(self.calls('recover'))
        self.cycle()
        self.assertEqual(self.calls('recover'), [('recover', 'cipher')])
        self.assertEqual(self.coordinator.state['status'], 'healthy')

    def test_cipher_recovery_restarts_only_the_cipher_container(self):
        backend = r.Backend(self.backend.repo, self.backend.directory, {})
        with patch.object(r, 'command') as command, patch.object(r.time, 'sleep'):
            backend.recover('cipher')
        self.assertEqual(command.call_args.args[0], ['docker', 'restart', '-t', '10', 'vybertron-yt-cipher'])

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

    def test_old_rollback_result_cannot_hide_a_new_playback_outage(self):
        self.coordinator.state['rollback_healthy'] = True
        self.backend.results[OLD] = result(False)
        self.backend.available, self.backend.gate = [NEW], False
        self.assertEqual(self.cycle()['status'], 'source')
        self.assertFalse(self.calls('deploy'))

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

    def test_healthy_cycle_mirrors_loaded_plugins(self):
        self.assertEqual(self.cycle()['status'], 'healthy')
        self.assertEqual(len(self.calls('mirror')), 1)
        self.cycle(observe_only=True)
        self.assertEqual(len(self.calls('mirror')), 1)

    def test_checksum_mismatch_alerts_and_other_mirror_errors_keep_health(self):
        self.backend.mirror_error = 'command_failed'
        state = self.cycle()
        self.assertEqual((state['status'], state['mirror_error']), ('healthy', 'command_failed'))
        self.backend.mirror_error = 'plugin_checksum_mismatch'
        self.assertEqual(self.cycle()['status'], 'plugin_checksum')
        self.backend.mirror_error = None
        state = self.cycle()
        self.assertEqual(state['status'], 'healthy')
        self.assertNotIn('mirror_error', state)


class DecodeScheduleTests(unittest.TestCase):
    """The JVM decode runs every five minutes unless idle and unchanged."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = FakeBackend(Path(self.temp.name))
        self.backend.services = 'services-1'
        self.backend.settings['auto_update'] = False
        self.coordinator = r.Coordinator(self.backend)
        self.clock = 100000
        git = patch.object(r, 'command', return_value=CONFIG)
        git.start()
        self.addCleanup(git.stop)
        self.cycle()  # First run always decodes and records the basis.

    def cycle(self, delta=300, wall=None, **kwargs):
        """Advance both clocks by delta; wall overrides the wall-clock step."""
        self.clock += delta if wall is None else wall
        self.backend.monotonic += delta
        before = self.probes()
        self.coordinator.cycle(self.clock, **kwargs)
        return self.probes() - before

    def probes(self):
        return len([call for call in self.backend.calls if call[0] == 'probe'])

    def mirrors(self):
        return len([call for call in self.backend.calls if call[0] == 'mirror'])

    def attention(self):
        return [event for event in self.coordinator.state.get('outbox', []) if 'needs attention' in event['message']]

    def test_first_run_decodes_and_records_the_basis(self):
        state = self.coordinator.state
        self.assertEqual(self.probes(), 1)
        self.assertEqual(state['last_check'], 'decode')
        self.assertEqual(state['decode_basis'], {
            'at': self.clock, 'monotonic': self.backend.monotonic, 'boot': self.backend.boot, 'version': OLD,
            'services': 'services-1', 'canaries': r.TRACKS, 'probe': result()})

    def test_idle_and_unchanged_skips_the_decode_but_stays_healthy(self):
        mirrors = self.mirrors()
        self.assertEqual(self.cycle(), 0)
        self.assertEqual(self.coordinator.state['status'], 'healthy')
        self.assertEqual(self.coordinator.state['last_check'], 'cheap')
        self.assertEqual(self.mirrors(), mirrors + 1)  # This cheap run mirrored, not just setUp's.

    def test_idle_decodes_again_once_the_interval_passes(self):
        skipped = sum(self.cycle() == 0 for _ in range(r.IDLE_DECODE_INTERVAL // 300 - 1))
        self.assertEqual(skipped, r.IDLE_DECODE_INTERVAL // 300 - 1)
        self.assertEqual(self.cycle(), 1)
        self.assertEqual(self.coordinator.state['decode_basis']['at'], self.clock)
        self.assertEqual(self.cycle(), 0)

    def test_a_backward_wall_clock_jump_decodes(self):
        for _ in range(5):  # Cheap runs through +25 minutes.
            self.assertEqual(self.cycle(), 0)
        # The wall clock goes back to +1 minute while 5 more real minutes pass.
        self.assertEqual(self.cycle(wall=-(24 * 60)), 1)

    def test_a_forward_wall_clock_jump_decodes(self):
        self.assertEqual(self.cycle(wall=600), 1)  # 10 wall minutes, 5 real.
        self.assertEqual(self.cycle(), 0)
        self.assertEqual(self.cycle(wall=r.CLOCK_TOLERANCE + 301), 1)

    def test_small_clock_disagreement_within_tolerance_still_skips(self):
        self.assertEqual(self.cycle(wall=300 + r.CLOCK_TOLERANCE), 0)

    def test_a_reboot_decodes_even_when_the_wall_clock_looks_fine(self):
        self.backend.boot = '11111111-2222-4333-8444-555555555555'
        self.backend.monotonic = 10.0  # Monotonic time restarts at boot.
        self.assertEqual(self.cycle(), 1)
        self.assertEqual(self.coordinator.state['decode_basis']['boot'], self.backend.boot)
        self.assertEqual(self.cycle(), 0)

    def test_an_unreadable_boot_id_never_skips_and_records_no_basis(self):
        self.backend.boot = None
        self.assertEqual(self.cycle(), 1)
        self.assertNotIn('decode_basis', self.coordinator.state)
        self.assertEqual(self.cycle(), 1)

    def test_a_failed_live_search_decodes(self):
        self.backend.search = False
        self.assertEqual(self.cycle(), 1)  # A fresh decode, not cached evidence.
        self.assertEqual(self.coordinator.state['last_check'], 'decode')
        self.assertNotEqual(self.coordinator.state['status'], 'healthy')

    def test_a_failed_or_missing_canary_lookup_decodes(self):
        for canaries in [[True, False], [False, False], [True], [True, True, True], None, [True, 1], 'yes']:
            self.backend.canaries = canaries
            self.assertEqual(self.cycle(), 1, canaries)
            self.backend.canaries = [True] * len(r.TRACKS)
            self.assertEqual(self.cycle(), 0)

    def test_unreadable_or_malformed_playback_telemetry_decodes(self):
        good = {'id': 'event-1', 'at': (self.clock - 3600) * 1000, 'identifier': 'RYnFIRc0k6E'}
        for failures in [None, {}, 'none', [None], [{}], [{**good, 'id': 7}], [{**good, 'at': 'x'}],
                         [{**good, 'at': float('nan')}], [{**good, 'identifier': 'short'}], [good] * 33]:
            self.backend.failures = failures
            self.assertGreaterEqual(self.cycle(), 1, failures)
            self.backend.failures = []
            self.cycle()  # Back to a skippable state.

    def test_old_and_handled_failures_still_allow_a_skip(self):
        self.backend.failures = [{'id': 'event-1', 'at': (self.clock - 3600) * 1000, 'identifier': 'RYnFIRc0k6E'}]
        self.assertEqual(self.cycle(), 0)

    def test_a_future_dated_failure_decodes(self):
        self.backend.failures = [{'id': 'event-1', 'at': (self.clock + 3600) * 1000, 'identifier': 'RYnFIRc0k6E'}]
        self.assertEqual(self.cycle(), 1)

    def test_playing_or_unknown_players_decode_every_run(self):
        for playing in [1, None, 2, False, 0.0, '0']:
            self.backend.playing = playing
            self.assertEqual(self.cycle(), 1, playing)

    def test_incomplete_or_malformed_cached_evidence_decodes(self):
        bad = [{'ok': True, 'searchOk': True, 'tracks': []},
               {'ok': True, 'searchOk': True, 'tracks': [{'ok': True, 'category': 'audio', 'frames': 250}]},
               {'ok': True, 'searchOk': True, 'tracks': [{'ok': True, 'category': 'audio'}] * 2},
               {'ok': True, 'searchOk': True, 'tracks': [{'ok': True, 'category': 'audio', 'frames': 10}] * 2},
               {'ok': True, 'searchOk': False, 'tracks': [{'ok': True, 'category': 'audio', 'frames': 250}] * 2},
               {'ok': True, 'tracks': [{'ok': True, 'category': 'audio', 'frames': 250}] * 2},
               {'ok': 1, 'searchOk': True, 'tracks': [{'ok': True, 'category': 'audio', 'frames': 250}] * 2},
               None, 'ok', []]
        for evidence in bad:
            self.coordinator.state['last_probe'] = evidence
            self.coordinator.state['decode_basis']['probe'] = evidence
            self.assertEqual(self.cycle(), 1, evidence)
            self.assertEqual(self.coordinator.state['status'], 'healthy')

    def test_a_malformed_basis_decodes(self):
        for key, value in [('at', 'x'), ('at', None), ('monotonic', float('inf')), ('boot', 7),
                           ('services', None), ('version', NEW), ('canaries', r.TRACKS[:1])]:
            self.coordinator.state['decode_basis'][key] = value
            self.assertEqual(self.cycle(), 1, key)
        self.coordinator.state['decode_basis'] = 'cached'
        self.assertEqual(self.cycle(), 1)

    def test_a_restart_or_redeploy_decodes_on_the_next_run(self):
        self.backend.services = 'services-2'
        self.assertEqual(self.cycle(), 1)
        self.assertEqual(self.cycle(), 0)
        self.backend.services = None  # Unreadable fingerprint never skips.
        self.assertEqual(self.cycle(), 1)

    def test_a_plugin_change_decodes_on_the_next_run(self):
        r.atomic_write(self.backend.config_path, r.pin_config(CONFIG, NEW))
        self.assertEqual(self.cycle(), 1)

    def test_any_failure_returns_to_a_decode_every_run_until_healthy(self):
        self.backend.kind = 'network'
        self.assertEqual(self.cycle(), 0)  # Cheap checks find it, no decode needed.
        self.assertEqual(self.coordinator.state['status'], 'network')
        self.backend.kind = 'ready'
        self.assertEqual(self.cycle(), 1)
        self.assertEqual(self.cycle(), 0)

    def test_last_check_never_reports_an_earlier_runs_decode(self):
        self.assertEqual(self.coordinator.state['last_check'], 'decode')
        self.backend.kind = 'network'
        self.cycle()
        self.assertEqual(self.coordinator.state['last_check'], 'cheap')
        r.save_json(self.backend.directory / 'deployment.json', {'phase': 'releasing'})
        self.cycle()
        self.assertEqual(self.coordinator.state['last_check'], 'none')
        self.assertEqual(self.coordinator.state['status'], 'pending_deployment')

    def test_a_failed_decode_clears_the_basis_and_alerts_after_two_runs(self):
        self.backend.results[OLD] = result(False)
        self.assertEqual(self.cycle(delta=r.IDLE_DECODE_INTERVAL), 2)  # Includes the retry.
        self.assertNotIn('decode_basis', self.coordinator.state)
        self.assertEqual(self.attention(), [])  # The first failed run stays quiet.
        self.assertEqual(self.cycle(), 2)
        self.assertEqual(self.coordinator.state['status'], 'source')
        self.assertEqual(len(self.attention()), 1)

    def test_one_failing_canary_alerts_after_three_runs(self):
        self.backend.results[OLD] = partial()
        self.assertEqual(self.cycle(delta=r.IDLE_DECODE_INTERVAL), 2)
        self.assertEqual(self.cycle(), 2)
        self.assertEqual(self.coordinator.state['status'], 'canary_degraded')
        self.assertEqual(self.attention(), [])
        self.assertEqual(self.cycle(), 2)
        self.assertEqual(len(self.attention()), 1)

    def test_real_playback_failures_are_probed_immediately(self):
        self.backend.failures = [{'id': 'event-1', 'at': (self.clock + 300) * 1000, 'identifier': 'RYnFIRc0k6E'}]
        before = len(self.backend.probed_tracks)
        self.assertGreaterEqual(self.cycle(), 1)
        self.assertEqual(self.backend.probed_tracks[before], ['https://www.youtube.com/watch?v=RYnFIRc0k6E'])
        self.assertEqual(self.coordinator.state['last_check'], 'decode')

    def test_manual_check_always_decodes(self):
        self.assertEqual(self.cycle(observe_only=True), 1)

    def test_a_due_or_deferred_plugin_update_check_decodes(self):
        self.backend.settings['auto_update'] = True
        self.assertEqual(self.cycle(), 1)  # Upstream never checked: due.
        self.assertEqual(self.cycle(), 0)
        self.coordinator.state['candidate'] = NEW
        self.backend.playing = 0
        self.backend.idle = False
        self.assertEqual(self.cycle(), 1)

    def test_a_future_or_malformed_upstream_check_time_counts_as_due(self):
        self.backend.settings['auto_update'] = True
        self.cycle()
        self.assertEqual(self.cycle(), 0)
        for value in [self.clock + 3600, 'x', None]:
            self.coordinator.state['upstream_checked_at'] = value
            self.backend.available = []
            self.assertEqual(self.cycle(), 1, value)

    def test_services_fingerprint_changes_with_container_identity_or_restart(self):
        containers = {name: {'Id': name + '-id', 'State': {'StartedAt': 't1'}} for name in r.SERVICES}
        first = r.services_fingerprint(containers)
        self.assertTrue(first)
        containers['vybertron-lavalink']['State']['StartedAt'] = 't2'
        self.assertNotEqual(r.services_fingerprint(containers), first)
        containers['vybertron-lavalink'] = {'Id': 'c', 'State': {'StartedAt': 't1'}}
        self.assertNotEqual(r.services_fingerprint(containers), first)

    def test_services_fingerprint_is_unknown_without_every_identity(self):
        full = {name: {'Id': name + '-id', 'State': {'StartedAt': 't1'}} for name in r.SERVICES}
        for change in [lambda c: c.pop('vybertron-bot'), lambda c: c['vybertron-bot'].pop('Id'),
                       lambda c: c['vybertron-bot']['State'].pop('StartedAt'),
                       lambda c: c['vybertron-bot']['State'].update(StartedAt=''),
                       lambda c: c['vybertron-bot'].update(State=None), lambda c: c.update(extra={})]:
            containers = {name: {'Id': item['Id'], 'State': dict(item['State'])} for name, item in full.items()}
            change(containers)
            self.assertIsNone(r.services_fingerprint(containers))

    def test_boot_id_reads_only_a_well_formed_identifier(self):
        path = Path(self.temp.name) / 'boot_id'
        self.assertIsNone(r.read_boot_id(path))
        path.write_text('0f2c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f\n')
        self.assertEqual(r.read_boot_id(path), '0f2c3d4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')
        path.write_text('not-a-boot-id\n')
        self.assertIsNone(r.read_boot_id(path))


class PluginMirrorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.repo = root / 'repo'
        self.mirror = self.repo / 'lavalink/plugins'
        r.atomic_write(self.repo / 'lavalink/application.yml', CONFIG)
        self.backend = r.Backend(self.repo, root / 'state', {})
        self.installed = {f'youtube-plugin-{OLD}.jar': b'youtube', 'unrelated-1.0.0.jar': b'unrelated'}
        self.copies = []
        self.docker = patch.object(r, 'command', side_effect=self.docker_cp)
        self.docker.start()
        self.addCleanup(self.docker.stop)

    def docker_cp(self, args, **kwargs):
        self.assertEqual(args[:2], ['docker', 'cp'])
        source = args[2].removeprefix('vybertron-lavalink:/opt/Lavalink/plugins/')
        self.copies.append(source)
        Path(args[3]).write_bytes(self.installed[source])
        return ''

    def record(self, **checksums):
        lines = [f'{digest}  {name}\n' for name, digest in checksums.items()]
        r.atomic_write(self.repo / r.CHECKSUMS, ''.join(lines), 0o644)

    def test_committed_pins_have_recorded_checksums(self):
        repo = Path(__file__).resolve().parents[1]
        jars = r.plugin_jars((repo / 'lavalink/application.yml').read_text())
        self.assertIn('youtube-plugin', jars)
        self.assertLessEqual(set(jars.values()), set(r.recorded_checksums(repo)))

    def test_mirrors_loaded_jars_once_and_prunes_superseded_versions(self):
        self.record(**{f'youtube-plugin-{OLD}.jar': r.hashlib.sha256(b'youtube').hexdigest()})
        r.atomic_write(self.mirror / f'youtube-plugin-{NEW}.jar', 'superseded')
        r.atomic_write(self.mirror / 'vybatron-audio.jar', 'local build')
        self.backend.mirror_plugins()
        self.assertEqual((self.mirror / f'youtube-plugin-{OLD}.jar').read_bytes(), b'youtube')
        self.assertEqual((self.mirror / 'unrelated-1.0.0.jar').read_bytes(), b'unrelated')
        self.assertFalse((self.mirror / f'youtube-plugin-{NEW}.jar').exists())
        self.assertTrue((self.mirror / 'vybatron-audio.jar').exists())
        self.backend.mirror_plugins()
        self.assertEqual(len(self.copies), 2)

    def test_rejects_a_loaded_jar_that_differs_from_its_recorded_checksum(self):
        self.record(**{f'youtube-plugin-{OLD}.jar': '0' * 64})
        with self.assertRaisesRegex(r.RecoveryError, 'plugin_checksum_mismatch'):
            self.backend.mirror_plugins()
        self.assertEqual(list(self.mirror.glob('youtube-plugin-*')), [])

    def test_replaces_a_kept_jar_that_differs_from_its_recorded_checksum(self):
        self.record(**{f'youtube-plugin-{OLD}.jar': r.hashlib.sha256(b'youtube').hexdigest()})
        r.atomic_write(self.mirror / f'youtube-plugin-{OLD}.jar', 'corrupted')
        self.backend.mirror_plugins()
        self.assertEqual((self.mirror / f'youtube-plugin-{OLD}.jar').read_bytes(), b'youtube')
        self.installed[f'youtube-plugin-{OLD}.jar'] = b'corrupted'
        r.atomic_write(self.mirror / f'youtube-plugin-{OLD}.jar', 'corrupted')
        with self.assertRaisesRegex(r.RecoveryError, 'plugin_checksum_mismatch'):
            self.backend.mirror_plugins()
        self.assertEqual(list(self.mirror.glob('youtube-plugin-*')), [])

    @unittest.skipUnless(shutil.which('sh'), 'needs a POSIX shell')
    def test_entrypoint_seeds_only_declared_plugin_jars(self):
        root = Path(self.temp.name) / 'lavalink'
        (root / 'bin').mkdir(parents=True)
        java = root / 'bin/java'
        java.write_text('#!/bin/sh\nls plugins\n', newline='\n')
        java.chmod(0o755)
        r.atomic_write(root / 'application.yml', CONFIG)
        for name in [f'youtube-plugin-{OLD}.jar', f'youtube-plugin-{NEW}.jar', 'removed-plugin-1.0.0.jar',
                     'unrelated-1.0.0.jar', 'vybatron-audio.jar']:
            r.atomic_write(self.mirror / name, name)
        script = Path(__file__).resolve().parents[1] / 'lavalink/plugins/start.sh'
        environment = {**os.environ, 'PATH': f'{root / "bin"}{os.pathsep}{os.environ["PATH"]}'}
        output = subprocess.run(['sh', script.as_posix(), self.mirror.as_posix()], cwd=root, env=environment,
                                capture_output=True, text=True, check=True).stdout.split()
        self.assertEqual(sorted(output), sorted([f'youtube-plugin-{OLD}.jar', 'unrelated-1.0.0.jar', 'vybatron-audio.jar']))

    def test_rejects_malformed_checksum_records(self):
        r.atomic_write(self.repo / r.CHECKSUMS, 'not a checksum\n')
        with self.assertRaisesRegex(r.RecoveryError, 'invalid_plugin_checksums'):
            self.backend.mirror_plugins()


if __name__ == '__main__':
    unittest.main()
