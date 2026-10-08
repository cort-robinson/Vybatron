import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlayTracker, requesterOf } from '../src/utils/play-tracking.js';
import { PlayStats } from '../src/utils/play-stats.js';
import { endReason, handlePlayerDestroy, handleTrackEnd, handleTrackStart } from '../src/lavalink.js';
import { presentationWritePending } from '../src/utils/presentation-updates.js';
import { getControllerRecord, resetControllers } from '../src/utils/player-controller.js';

const song = (id, requester = { id: '200', bot: false }) => ({ requester, info: { sourceName: 'youtube', identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, title: `Song ${id}`, author: 'Artist - Topic', duration: 200_000, isStream: false } });
const player = (extra = {}) => ({ guildId: '100', voiceChannelId: '300', textChannelId: '400', paused: false, lastPosition: 0, queue: { current: null, tracks: [] }, ...extra });

function harness() {
  const clock = { now: 1_000_000 };
  const calls = [];
  const stats = {
    begin(details) { const handle = { id: calls.length, durationMs: details.track.info.duration }; calls.push(['begin', details]); return handle; },
    finish(handle, outcome) { calls.push(['finish', handle.id, outcome]); },
  };
  const tracker = createPlayTracker({ stats, botUserId: () => '999', now: () => clock.now, logger: { error() {} } });
  const finishes = () => calls.filter(call => call[0] === 'finish').map(call => call[2]);
  const begins = () => calls.filter(call => call[0] === 'begin').map(call => call[1]);
  return { clock, tracker, finishes, begins };
}

test('requester is the human who queued it; bot and autoplay picks are unattended; listeners are never read', () => {
  assert.deepEqual(requesterOf(song('a'), '999'), { requesterKind: 'user', requesterId: '200' });
  assert.deepEqual(requesterOf(song('a', { id: '999', bot: true }), '999'), { requesterKind: 'autoplay', requesterId: null });
  assert.deepEqual(requesterOf(song('a', { id: '998', bot: true }), '999'), { requesterKind: 'autoplay', requesterId: null });
  assert.deepEqual(requesterOf(song('a', null), '999'), { requesterKind: 'unknown', requesterId: null });
  const { tracker, begins } = harness();
  const listening = player({ voiceChannel: { members: new Map([['201', {}], ['202', {}]]) } });
  tracker.started(listening, song('a'));
  assert.deepEqual(Object.keys(begins()[0]).sort(), ['guildId', 'requesterId', 'requesterKind', 'track', 'voiceChannelId']);
});

test('skipping early counts as an early skip; finishing counts as complete', () => {
  const { clock, tracker, finishes } = harness();
  const p = player();
  tracker.started(p, song('a'));
  clock.now += 10_000;
  tracker.ended(p, 'moved-on');
  tracker.started(p, song('b'));
  clock.now += 200_000;
  tracker.ended(p, 'finished');
  assert.deepEqual(finishes(), [
    { playedMs: 10_000, completed: false, skipped: true },
    { playedMs: 200_000, completed: true, skipped: false },
  ]);
});

test('moving on late, stopping early and nearly finishing are not early skips', () => {
  const { clock, tracker, finishes } = harness();
  const p = player();
  tracker.started(p, song('a')); clock.now += 150_000; tracker.ended(p, 'moved-on');
  tracker.started(p, song('b')); clock.now += 5_000; tracker.ended(p, 'ended');
  tracker.started(p, song('c')); clock.now += 185_000; tracker.started(p, song('d'));
  assert.deepEqual(finishes(), [
    { playedMs: 150_000, completed: false, skipped: false },
    { playedMs: 5_000, completed: false, skipped: false },
    { playedMs: 185_000, completed: true, skipped: false },
  ]);
});

test('paused time does not count as listening', () => {
  const { clock, tracker, finishes } = harness();
  const p = player({ queue: { current: null } });
  const track = song('a'); p.queue.current = track;
  tracker.started(p, track);
  clock.now += 20_000; p.paused = true; p.lastPosition = 20_000; tracker.progress(p);
  clock.now += 120_000;
  tracker.ended(p, 'moved-on');
  assert.deepEqual(finishes(), [{ playedMs: 20_000, completed: false, skipped: true }]);
});

test('recovery replays continue the same play; unrecovered short failures are discarded', () => {
  const { clock, tracker, finishes, begins } = harness();
  const p = player();
  tracker.started(p, song('a'));
  clock.now += 40_000; tracker.failed(p);
  tracker.started(p, song('mirror'), { recovering: true });
  assert.equal(begins().length, 1, 'no second play for the recovery replay');
  clock.now += 160_000; tracker.ended(p, 'finished');
  assert.deepEqual(finishes(), [{ playedMs: 200_000, completed: true, skipped: false }]);

  tracker.started(p, song('b'));
  clock.now += 3_000; tracker.failed(p);
  tracker.started(p, song('c'));
  assert.deepEqual(finishes().at(-1), { discard: true });
});

test('a replaced player cannot end the new session’s play; shutdown closes every open play', () => {
  const { clock, tracker, finishes } = harness();
  const old = player(); const replacement = player();
  tracker.started(old, song('a'));
  tracker.started(replacement, song('b'));
  assert.equal(finishes().length, 1, 'the old play was closed by the new start');
  tracker.ended(old, 'ended');
  assert.equal(finishes().length, 1);
  tracker.started(player({ guildId: '101' }), song('c'));
  clock.now += 60_000;
  tracker.closeAll();
  assert.equal(finishes().length, 3);
  assert.equal(tracker.openCount(), 0);
});

test('Lavalink end reasons map to play outcomes and recovery replacements are ignored', () => {
  assert.equal(endReason({ reason: 'finished' }), 'finished');
  assert.equal(endReason({ reason: 'stopped' }), 'moved-on');
  assert.equal(endReason({ reason: 'replaced' }), 'moved-on');
  assert.equal(endReason({ reason: 'loadFailed' }), 'failed');
  assert.equal(endReason({ reason: 'cleanup' }), 'ended');
  assert.equal(endReason({ reason: 'stopped' }, 'ended'), 'ended');
  const ended = [];
  const client = { playTracker: { ended: (_player, reason) => ended.push(reason) } };
  handleTrackEnd(client, player({ getData: () => undefined }), { reason: 'replaced' });
  assert.deepEqual(ended, ['moved-on']);
});

test('a failing stats store never interrupts playback events', async t => {
  t.after(resetControllers);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-stats-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const stats = await new PlayStats(path.join(directory, 'stats.sqlite'), { logger: { error() {} }, flushDelayMs: 1 }).open();
  stats.db.close(); // every later SQLite call fails
  const logs = [];
  const tracker = createPlayTracker({ stats, logger: { error: line => logs.push(line) } });
  const sends = [];
  const channel = { messages: { fetch: async () => null }, send: async payload => { sends.push(payload); return { id: 'm1', edit: async () => ({}) }; } };
  const client = { channels: { cache: new Map([['400', channel]]) }, stats, playTracker: tracker };
  const p = player();
  p.queue.current = song('aaaaaaaaaaa');
  await assert.doesNotReject(handleTrackStart(client, p, p.queue.current));
  assert.equal(tracker.openCount(), 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.doesNotThrow(() => handleTrackEnd(client, p, { reason: 'finished' }));
  assert.doesNotThrow(() => stats.flush());
  const deadline = Date.now() + 1000;
  while (presentationWritePending('controller:100')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.equal(getControllerRecord('100')?.state, 'playing', 'the controller still reflects playback');
  assert.equal(sends.length, 1);
  assert.ok(stats.status().writeFailures >= 1);

  // A tracker that throws internally is contained too.
  const broken = { ...client, playTracker: createPlayTracker({ stats: { begin() { throw new Error('boom'); } }, logger: { error: line => logs.push(line) } }) };
  await assert.doesNotReject(handleTrackStart(broken, p, p.queue.current));
  assert.ok(logs.some(line => /Could not track a play/.test(line)));
  assert.doesNotThrow(() => handlePlayerDestroy({ ...broken, lavalink: { getPlayer: () => null } }, p));
});
