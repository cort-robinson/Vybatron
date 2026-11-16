import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  ALERT_CONDITIONS,
  ALERT_MUTE_ID,
  createAlertMonitor,
  handleAlertInteraction,
  readSignals,
  safeAlertText,
  startOperatorAlerts,
} from '../src/operator-alerts.js';
import { startHealthServer } from '../src/health.js';
import { recordPlaybackFailure } from '../src/utils/playback-health.js';

// The debounce and rate limits are condition-agnostic; these tests use an
// audio-offline condition of their own (the host monitor reports real outages).
const OFFLINE = { key: 'audio-offline', raiseAfter: 4, resolveAfter: 2,
  active: (signals) => signals.discordReady && !signals.audioReady,
  message: () => 'The audio service is offline.', resolved: 'Resolved: the audio service is back online.' };
const CONDITIONS = [OFFLINE, ...ALERT_CONDITIONS];

const healthy = { discordReady: true, audioReady: true, draining: false, recentFailures: 0,
  circuitTrips: 0, statsUnavailable: false, statsFailures: 0, libraryPercent: 0 };

function clock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => { time += ms; } };
}

function run(monitor, time, samples) {
  return samples.flatMap((sample) => { time.advance(30_000); return monitor.check({ ...healthy, ...sample }); });
}

test('a short audio outage is debounced; a sustained one alerts once', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  const offline = { audioReady: false };
  assert.deepEqual(run(monitor, time, [offline, offline, offline, {}]), []);
  const messages = run(monitor, time, [offline, offline, offline, offline, offline, offline]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'alert');
  assert.match(messages[0].text, /audio service is offline/);
});

test('recovery sends one resolved message after the condition stays clear', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  run(monitor, time, Array(4).fill({ audioReady: false }));
  assert.deepEqual(run(monitor, time, [{}]), []);
  const resolved = run(monitor, time, [{}, {}, {}]);
  assert.deepEqual(resolved.map(({ kind, key }) => ({ kind, key })), [{ kind: 'resolved', key: 'audio-offline' }]);
  assert.deepEqual(monitor.active(), []);
});

test('flapping inside the cooldown stays quiet, including its resolve', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  const outage = Array(4).fill({ audioReady: false });
  const first = run(monitor, time, [...outage, {}, {}]);
  assert.deepEqual(first.map((m) => m.kind), ['alert', 'resolved']);
  assert.deepEqual(run(monitor, time, [...outage, {}, {}]), []);
  time.advance(30 * 60_000);
  assert.deepEqual(run(monitor, time, outage).map((m) => m.kind), ['alert']);
});

test('a condition that persists after a suppressed alert is reported once limits allow', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  const outage = Array(4).fill({ audioReady: false });
  run(monitor, time, [...outage, {}, {}]);
  assert.deepEqual(run(monitor, time, outage), []);
  const later = run(monitor, time, Array(60).fill({ audioReady: false }));
  assert.deepEqual(later.map((m) => m.kind), ['alert']);
});

test('an hourly cap bounds alerts across conditions', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now, hourlyLimit: 2 });
  const messages = run(monitor, time, Array(4).fill({ audioReady: false, recentFailures: 9, statsUnavailable: true }));
  assert.equal(messages.filter((m) => m.kind === 'alert').length, 2);
});

test('shutdown and pre-login checks never alert', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  assert.deepEqual(run(monitor, time, Array(6).fill({ audioReady: false, draining: true })), []);
  assert.deepEqual(run(monitor, time, Array(6).fill({ discordReady: false, statsUnavailable: true })), []);
});

test('cumulative breaker and stats counters alert on recent increases only', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  assert.deepEqual(run(monitor, time, [{ circuitTrips: 4, statsFailures: 7 }]), []); // Earlier process history.
  const messages = run(monitor, time, [{ circuitTrips: 5, statsFailures: 9 }]);
  assert.deepEqual(messages.map((m) => m.key).sort(), ['source-breaker', 'stats-store']);
  assert.match(messages.find((m) => m.key === 'stats-store').text, /2 play statistics writes failed/);
  time.advance(10 * 60_000);
  const resolved = run(monitor, time, [{ circuitTrips: 5, statsFailures: 9 }, { circuitTrips: 5, statsFailures: 9 }]);
  assert.deepEqual(resolved.map((m) => m.kind), ['resolved', 'resolved']);
});

test('a nearly full library alerts at the warning threshold and resolves below it', () => {
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  assert.deepEqual(run(monitor, time, [{ libraryPercent: 79 }]), []);
  const [alert] = run(monitor, time, [{ libraryPercent: 82 }]);
  assert.match(alert.text, /music library is 82% full/);
  assert.deepEqual(run(monitor, time, [{ libraryPercent: 78 }, { libraryPercent: 79 }, { libraryPercent: 76 }]), []);
  assert.deepEqual(run(monitor, time, [{ libraryPercent: 70 }, { libraryPercent: 70 }]).map((m) => m.kind), ['resolved']);
});

test('alert text carries no IDs, titles, URLs or provider errors', () => {
  const client = {
    isReady: () => true,
    lavalink: { nodeManager: { nodes: new Map([['main', { connected: true }]]) },
      playbackRecovery: { summary: () => ({ circuitTrips: 0, guildId: '123456789012345678' }) } },
    stats: { status: () => ({ available: true, writeFailures: 0, droppedWrites: 0, lastError: 'token=secret' }) },
    library: { capacity: () => ({ bytes: 900, limitBytes: 1000 }) },
  };
  for (const identifier of ['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd']) {
    recordPlaybackFailure(client, { info: { sourceName: 'youtube', identifier, title: 'Secret Song Title' } });
  }
  const signals = readSignals(client);
  assert.deepEqual(Object.keys(signals).sort(), Object.keys(healthy).sort());
  const time = clock();
  const monitor = createAlertMonitor({ conditions: CONDITIONS, now: time.now });
  const text = run(monitor, time, [signals, signals]).map((m) => m.text).join('\n');
  assert.match(text, /5 songs failed to play/);
  assert.match(text, /music library is 90% full/);
  for (const leaked of ['dQw4w9WgXcQ', 'Secret Song', '123456789012345678', 'secret', 'http']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(safeAlertText('user 123456789012345678 at https://example.com/x?sig=abc'), 'user [id] at [link]');
});

test('the bot no longer raises its own audio-offline alert', () => {
  assert.ok(!ALERT_CONDITIONS.some((condition) => condition.key === 'audio-offline'));
});

function silent() {
  const logs = [];
  return { logs, logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) } };
}

test('alerts wait on the loopback /alerts route for the host monitor to post them', async () => {
  const { logs, logger } = silent();
  let pending = [{ key: 'stats-store', kind: 'alert', text: 'Audio alert: test' }];
  const client = { isReady: () => true, lavalink: { nodeManager: { nodes: new Map() } }, users: { fetch: () => assert.fail('no DMs') } };
  const alerts = await startOperatorAlerts(client, { logger,
    monitor: { check: () => pending.splice(0) }, timers: { setInterval: () => null, clearInterval() {} } });
  alerts.tick();
  pending = [{ key: 'stats-store', kind: 'resolved', text: 'Resolved: test' }];
  alerts.tick();
  const server = startHealthServer(client, { port: 0 });
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/alerts`);
    assert.equal(response.status, 200);
    const { alerts: served } = await response.json();
    assert.deepEqual(served.map((alert) => alert.text), ['Audio alert: test', 'Resolved: test']);
    for (const alert of served) {
      assert.match(alert.id, /^[A-Za-z0-9_-]{1,64}$/);
      assert.deepEqual(Object.keys(alert).sort(), ['at', 'id', 'text']);
    }
    // Every poll sees the same entries, so a host retry never loses or reorders one.
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${server.address().port}/alerts`)).json()).alerts, served);
  } finally { server.close(); }
  assert.ok(logs.some((line) => line.includes('"condition":"stats-store"')));
});

test('the alert queue keeps only the newest entries', async () => {
  let pending = [];
  const alerts = await startOperatorAlerts({}, { logger: silent().logger,
    monitor: { check: () => pending.splice(0) }, timers: { setInterval: () => null, clearInterval() {} } });
  for (let i = 0; i < 40; i++) { pending = [{ key: 'k', kind: 'alert', text: `Audio alert: ${i}` }]; alerts.tick(); }
  const queued = alerts.pending();
  assert.equal(queued.length, 32);
  assert.equal(queued[0].text, 'Audio alert: 8');
  queued[0].text = 'mutated';
  assert.equal(alerts.pending()[0].text, 'Audio alert: 8');
});

test('an old DM mute button explains where alerts went', async () => {
  const replies = [];
  await handleAlertInteraction({ customId: ALERT_MUTE_ID, user: { id: '22' }, reply: async (payload) => replies.push(payload) });
  assert.match(replies[0].content, /alerts channel/);
  assert.ok(!replies[0].components);
});
