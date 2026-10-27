import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { portalFixture } from './portal-fixtures.js';

const fixture = portalFixture;

const feed = (f, instance = '', after = '', headers) => f.request(`/v1/changes?instance=${instance}&after=${after}`, { headers });
async function cursor(f) {
  const first = await feed(f);
  assert.equal(first.status, 200); assert.equal(first.body.reset, true);
  // The first consumer call primes the revision baseline for active players.
  await delay(30);
  const settled = await feed(f, first.body.instanceId, first.body.sequence);
  return { instance: first.body.instanceId, after: settled.body.sequence };
}

test('the change feed requires bridge authentication and carries only guild IDs', async t => {
  const f = await portalFixture(t);
  const denied = await feed(f, '', '', { Authorization: 'Bearer wrong-token-that-is-long-enough-000' });
  assert.equal(denied.status, 401);
  const { instance, after } = await cursor(f);
  const held = feed(f, instance, after);
  await delay(20); f.player.paused = true; f.player.playing = false; f.manager.emit('playerPaused', f.player);
  const woke = await held;
  assert.equal(woke.status, 200);
  assert.deepEqual(Object.keys(woke.body).sort(), ['guildIds', 'instanceId', 'reset', 'sequence', 'sequences']);
  assert.deepEqual(woke.body.guildIds, ['100']); assert.equal(woke.body.reset, false); assert.ok(woke.body.sequence > after);
  assert.deepEqual(woke.body.sequences, [woke.body.sequence]);
});

test('native playback events wake a held poll immediately and silent queue edits within one scan', async t => {
  const f = await portalFixture(t);
  let { instance, after } = await cursor(f);
  for (const change of ['event', 'silent']) {
    const started = performance.now(); const held = feed(f, instance, after); await delay(20);
    if (change === 'event') { f.player.paused = true; f.manager.emit('playerPaused', f.player); }
    else f.player.queue.tracks.reverse(); // A native move/shuffle emits no Lavalink event.
    const woke = await held; const elapsed = performance.now() - started;
    assert.deepEqual(woke.body.guildIds, ['100'], change);
    assert.ok(elapsed < 1000, `${change} woke in ${Math.round(elapsed)} ms`);
    after = woke.body.sequence;
  }
});

test('voice joins and moves wake the guild, but mute-only voice updates do not', async t => {
  const f = await portalFixture(t);
  const { instance, after } = await cursor(f);
  const guild = { id: '100' };
  f.client.emit('voiceStateUpdate', { channelId: '300', guild, selfMute: false }, { channelId: '300', guild, selfMute: true });
  const quiet = await Promise.race([feed(f, instance, after), delay(400).then(() => null)]);
  assert.equal(quiet, null, 'a mute toggle changes no projected state');
  const held = feed(f, instance, after); await delay(20);
  f.client.emit('voiceStateUpdate', { channelId: null, guild }, { channelId: '300', guild });
  assert.deepEqual((await held).body.guildIds, ['100']);
});

test('an unknown instance or an expired cursor resets the consumer instead of missing changes', async t => {
  const f = await portalFixture(t);
  const { instance, after } = await cursor(f);
  assert.equal((await feed(f, '00000000-0000-4000-8000-000000000000', after)).body.reset, true);
  assert.equal((await feed(f, instance, after + 50)).body.reset, true);
  assert.equal((await feed(f, instance, 'x')).body.reset, true);
});

test('closing the bridge releases a held poll promptly', async t => {
  const f = await portalFixture(t);
  const { instance, after } = await cursor(f);
  const held = feed(f, instance, after).catch(error => error); await delay(20);
  const started = performance.now(); await f.bridge.close();
  await held; assert.ok(performance.now() - started < 1500);
});

const cursorOf = response => {
  const [instance, sequence] = (response.headers.get('x-change-cursor') || '').split(':');
  return instance ? { instance, sequence: Number(sequence) } : null;
};

test('snapshot reads report the feed position their authorization began at; other reads report none', async t => {
  const f = await fixture(t);
  assert.equal(cursorOf(await f.request()), null, 'without a feed consumer a cursor would promise nothing');
  const { instance, after } = await cursor(f);
  const read = await f.request();
  assert.deepEqual(cursorOf(read), { instance, sequence: after });
  assert.equal(cursorOf(await f.request('/library')), null);
  // A change already seen is published before the cursor is taken, so the read covers it.
  f.player.paused = true; f.manager.emit('playerPaused', f.player);
  const covered = cursorOf(await f.request());
  assert.ok(covered.sequence > after);
  const woke = await feed(f, instance, after);
  assert.deepEqual(woke.body.guildIds, ['100']);
  assert.ok(woke.body.sequences[0] <= covered.sequence);
});

test('a command publishes one entry with its cursor, and the scan does not report the same change again', async t => {
  const f = await fixture(t);
  const { instance, after } = await cursor(f);
  const paused = await f.command({ command: 'pause' });
  assert.equal(paused.status, 200);
  const position = cursorOf(paused);
  assert.equal(position.instance, instance); assert.ok(position.sequence > after);
  const woke = await feed(f, instance, after);
  assert.deepEqual(woke.body.guildIds, ['100']); assert.deepEqual(woke.body.sequences, [position.sequence]);
  // The pause changed the revision; the command already reported it.
  const again = await Promise.race([feed(f, instance, position.sequence), delay(600).then(() => null)]);
  assert.equal(again, null);
  const rejected = await f.command({ command: 'nope' });
  assert.notEqual(rejected.status, 200); assert.equal(cursorOf(rejected), null);
});
