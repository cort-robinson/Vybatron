import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandTimings, commandTimingSpan, commandReadyForMutation } from '../src/portal/timing.js';
import { portalFixture } from './portal-fixtures.js';

test('private command timings retain only fixed labels and numeric spans, preserving replies and failures', async () => {
  let elapsed = 0; const timing = createCommandTimings({ clock: () => elapsed, wallClock: () => 123 });
  const reply = { private: 'not retained' };
  assert.equal(await timing.run('pause', async () => {
    await commandTimingSpan('authorization', () => { elapsed += 30; });
    commandReadyForMutation(); elapsed += 2; commandReadyForMutation();
    await commandTimingSpan('playback', () => { elapsed += 10; });
    await commandTimingSpan('presentation', () => { elapsed += 20; });
    return reply;
  }), reply);
  const failure = new Error('private error');
  await assert.rejects(timing.run('resume', () => commandTimingSpan('authorization', () => { elapsed += 4; throw failure; })), error => error === failure);
  const records = timing.snapshot().records;
  assert.deepEqual(records[0], { at: 123, command: 'pause', success: true, totalMs: 62, readyForMutationMs: 30,
    authorization: { count: 1, ms: 30 }, playback: { count: 1, ms: 10 }, presentation: { count: 1, ms: 20 } });
  assert.equal(records[1].success, false); assert.equal(records[1].authorization.ms, 4);
  assert.ok(!JSON.stringify(records).includes('private'));
  records[0].command = 'changed'; assert.equal(timing.snapshot().records[0].command, 'pause');
});

test('interleaved commands keep their spans isolated and ignore unrecognized client labels', async () => {
  let elapsed = 0; const timing = createCommandTimings({ clock: () => elapsed });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const first = timing.run('pause', () => commandTimingSpan('presentation', async () => { await gate; elapsed += 5; }));
  await timing.run('seek', () => commandTimingSpan('authorization', () => { elapsed += 3; }));
  await timing.run('untrusted-user-label', () => commandTimingSpan('playback', () => { elapsed += 2; }));
  release(); await first;
  const records = timing.snapshot().records;
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].authorization, { count: 1, ms: 3 });
  assert.equal(records[0].presentation.count, 0);
  assert.equal(records[1].authorization.count, 0); assert.equal(records[1].presentation.count, 1);
  assert.equal(records[1].playback.count, 0);
});

test('timing records expire, remain bounded, and cannot reappear after bridge shutdown', async () => {
  let now = 0; const timing = createCommandTimings({ wallClock: () => now });
  for (let n = 0; n < 35; n++) { now = n; await timing.run('volume', () => n); }
  assert.equal(timing.snapshot().records.length, 32);
  assert.equal(timing.snapshot().records[0].at, 3);
  now += 900_001; assert.equal(timing.snapshot().records.length, 0);
  let release; const pending = timing.run('pause', () => new Promise(resolve => { release = resolve; }));
  timing.close(); release(); await pending;
  await timing.run('pause', () => 1);
  assert.equal(timing.snapshot().records.length, 0);
});

test('real bridge timing observations require fresh maintainer identity and never expose command payloads', async t => {
  const f = await portalFixture(t);
  const paused = await f.command({ command: 'pause' });
  assert.equal(paused.status, 200);
  assert.equal(f.calls.filter(call => call === 'pause').length, 1);
  const route = '/v1/latency?actorId=900';
  assert.equal((await f.request(route, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request(route, { headers: { Origin: 'https://browser.invalid' } })).status, 403);
  for (const actor of ['200', '201', '202']) assert.equal((await f.request(`/v1/latency?actorId=${actor}`)).status, 403);
  const observed = await f.request(route);
  assert.equal(observed.status, 200);
  assert.equal(observed.body.records.length, 1);
  const record = observed.body.records[0];
  assert.equal(record.command, 'pause'); assert.equal(record.success, true);
  assert.ok(record.authorization.count >= 2);
  assert.equal(record.playback.count, 1);
  assert.deepEqual(record.presentation, { count: 0, ms: 0 }, 'web commands do not await cosmetic writers');
  assert.equal(typeof record.readyForMutationMs, 'number');
  assert.deepEqual(Object.keys(record).sort(), ['at', 'authorization', 'command', 'playback', 'presentation', 'readyForMutationMs', 'success', 'totalMs'].sort());
  f.client.application.fetch = async () => ({ owner: f.users.get('901') });
  assert.equal((await f.request(route)).status, 403);
});
