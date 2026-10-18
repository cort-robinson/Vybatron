import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ALERT_MUTE_ID,
  ALERT_UNMUTE_ID,
  createAlertMonitor,
  createAlertPreferences,
  handleAlertInteraction,
  readSignals,
  safeAlertText,
  startOperatorAlerts,
} from '../src/operator-alerts.js';
import { recordPlaybackFailure } from '../src/utils/playback-health.js';

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
  const monitor = createAlertMonitor({ now: time.now });
  const offline = { audioReady: false };
  assert.deepEqual(run(monitor, time, [offline, offline, offline, {}]), []);
  const messages = run(monitor, time, [offline, offline, offline, offline, offline, offline]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'alert');
  assert.match(messages[0].text, /audio service is offline/);
});

test('recovery sends one resolved message after the condition stays clear', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now });
  run(monitor, time, Array(4).fill({ audioReady: false }));
  assert.deepEqual(run(monitor, time, [{}]), []);
  const resolved = run(monitor, time, [{}, {}, {}]);
  assert.deepEqual(resolved.map(({ kind, key }) => ({ kind, key })), [{ kind: 'resolved', key: 'audio-offline' }]);
  assert.deepEqual(monitor.active(), []);
});

test('flapping inside the cooldown stays quiet, including its resolve', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now });
  const outage = Array(4).fill({ audioReady: false });
  const first = run(monitor, time, [...outage, {}, {}]);
  assert.deepEqual(first.map((m) => m.kind), ['alert', 'resolved']);
  assert.deepEqual(run(monitor, time, [...outage, {}, {}]), []);
  time.advance(30 * 60_000);
  assert.deepEqual(run(monitor, time, outage).map((m) => m.kind), ['alert']);
});

test('a condition that persists after a suppressed alert is reported once limits allow', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now });
  const outage = Array(4).fill({ audioReady: false });
  run(monitor, time, [...outage, {}, {}]);
  assert.deepEqual(run(monitor, time, outage), []);
  const later = run(monitor, time, Array(60).fill({ audioReady: false }));
  assert.deepEqual(later.map((m) => m.kind), ['alert']);
});

test('an hourly cap bounds alerts across conditions', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now, hourlyLimit: 2 });
  const messages = run(monitor, time, Array(4).fill({ audioReady: false, recentFailures: 9, statsUnavailable: true }));
  assert.equal(messages.filter((m) => m.kind === 'alert').length, 2);
});

test('shutdown and pre-login checks never alert', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now });
  assert.deepEqual(run(monitor, time, Array(6).fill({ audioReady: false, draining: true })), []);
  assert.deepEqual(run(monitor, time, Array(6).fill({ discordReady: false, statsUnavailable: true })), []);
});

test('cumulative breaker and stats counters alert on recent increases only', () => {
  const time = clock();
  const monitor = createAlertMonitor({ now: time.now });
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
  const monitor = createAlertMonitor({ now: time.now });
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
  const monitor = createAlertMonitor({ now: time.now });
  const text = run(monitor, time, [signals, signals]).map((m) => m.text).join('\n');
  assert.match(text, /5 songs failed to play/);
  assert.match(text, /music library is 90% full/);
  for (const leaked of ['dQw4w9WgXcQ', 'Secret Song', '123456789012345678', 'secret', 'http']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(safeAlertText('user 123456789012345678 at https://example.com/x?sig=abc'), 'user [id] at [link]');
});

function fakeClient({ sendFails = new Set() } = {}) {
  const sent = [];
  return {
    sent,
    operatorIds: new Set(['22']),
    application: { owner: { id: '11' } },
    users: { fetch: async (id) => ({ send: async (payload) => {
      if (sendFails.has(id)) throw Object.assign(new Error(`Cannot DM https://discord.com token=abc ${id}`), { code: 50007 });
      sent.push({ id, ...payload });
    } }) },
  };
}

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybatron-alerts-'));
  return path.join(dir, 'operator-alerts.json');
}

test('alerts DM the owner and operators, skip muted recipients, and survive failed DMs', async () => {
  const client = fakeClient({ sendFails: new Set(['22']) });
  const logs = [];
  const logger = { log: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) };
  const preferences = createAlertPreferences(await tempFile(), { logger });
  const message = { key: 'audio-offline', kind: 'alert', text: 'Audio alert: test' };
  let pending = [message];
  const alerts = await startOperatorAlerts(client, { logger, preferences,
    monitor: { check: () => pending.splice(0) }, timers: { setInterval: () => null, clearInterval() {} } });
  alerts.tick();
  await alerts.idle();
  assert.deepEqual(client.sent.map(({ id, content }) => ({ id, content })), [{ id: '11', content: 'Audio alert: test' }]);
  assert.equal(client.sent[0].components[0].toJSON().components[0].custom_id, ALERT_MUTE_ID);
  assert.ok(logs.some((line) => line.includes('operator_alert_failed')));
  assert.ok(!logs.join('\n').includes('token=abc') && !logs.join('\n').includes('discord.com'));

  await preferences.setMuted('11', true);
  pending = [message];
  alerts.tick();
  await alerts.idle();
  assert.equal(client.sent.length, 1);
});

test('mute preferences persist across restarts and ignore a damaged file', async () => {
  const file = await tempFile();
  const concurrent = createAlertPreferences(file);
  await Promise.all([concurrent.setMuted('11', true), concurrent.setMuted('22', true)]);
  assert.ok(concurrent.muted('11') && concurrent.muted('22'));
  assert.ok((await createAlertPreferences(file).load()).muted('22'));
  await concurrent.setMuted('22', false);
  await createAlertPreferences(file).setMuted('11', true);
  assert.equal((await createAlertPreferences(file).load()).muted('11'), true);
  await fs.writeFile(file, '{not json');
  const logs = [];
  const reloaded = await createAlertPreferences(file, { logger: { error: (line) => logs.push(line) } }).load();
  assert.equal(reloaded.muted('11'), false);
  assert.match(logs[0], /operator_alert_preferences_unreadable/);
});

test('only alert recipients can change alert preferences from a DM button', async () => {
  const client = fakeClient();
  client.operatorAlerts = { preferences: createAlertPreferences(await tempFile()) };
  const replies = [];
  const interaction = (userId, customId) => ({ client, customId, user: { id: userId }, reply: async (payload) => replies.push(payload) });
  await handleAlertInteraction(interaction('99', ALERT_MUTE_ID));
  assert.match(replies.at(-1).content, /only for the bot owner/);
  assert.equal(client.operatorAlerts.preferences.muted('99'), false);
  await handleAlertInteraction(interaction('22', ALERT_MUTE_ID));
  assert.equal(client.operatorAlerts.preferences.muted('22'), true);
  assert.equal(replies.at(-1).components[0].toJSON().components[0].custom_id, ALERT_UNMUTE_ID);
  await handleAlertInteraction(interaction('22', ALERT_UNMUTE_ID));
  assert.equal(client.operatorAlerts.preferences.muted('22'), false);
});
