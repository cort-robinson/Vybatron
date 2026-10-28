import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PLAYER_LIMITS, PlayerError } from '../src/utils/players.js';
import { DEVICE_RETENTION_MS, PLAYER_RETENTION_MS } from '../src/utils/listening-state.js';
import { openLibrary, closeLibraries } from './library-fixture.js';

const actor = '200'; const other = '201';
const phone = 'phonephonephonephone01'; const laptop = 'laptoplaptoplaptoplapt';
const song = n => ({ id: `song${n}`, title: `Song ${n}`, author: 'Artist', uri: `https://www.youtube.com/watch?v=${String(n).padStart(11, '0')}`,
  source: 'youtube', durationMs: 200_000, artworkUrl: null, isStream: false });
const songs = (count, from = 0) => Array.from({ length: count }, (_, index) => song(from + index));

async function fixture(t, { now } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-players-'));
  t.after(async () => { await closeLibraries(); await fs.rm(dir, { recursive: true, force: true }); });
  const clock = { now: now ?? 1_800_000_000_000 };
  const open = options => openLibrary(path.join(dir, 'library.json'), { now: () => clock.now, ...options });
  const library = await open();
  return { dir, clock, library, players: library.players, open };
}
const register = (players, deviceId = phone, owner = actor, sessionRef = 'session-a') => players.register(owner, { deviceId, name: 'Phone', kind: 'android', sessionRef });
async function rejects(promise, status, code) {
  await assert.rejects(async () => promise, error => error instanceof PlayerError && error.status === status && error.code === code);
}

test('an unknown listener has an empty, paused player and no devices', async t => {
  const { players } = await fixture(t);
  const { player, devices } = players.get(actor);
  assert.deepEqual(devices, []);
  assert.equal(player.current, null); assert.deepEqual(player.queue, []); assert.equal(player.revision, 0);
  assert.deepEqual(player.playhead, { positionMs: 0, at: 0, playing: false });
  assert.equal(player.volume, 100); assert.equal(player.repeat, 'off'); assert.equal(player.activeDeviceId, null);
});

test('edits name entries, bump the revision, and are refused against an old revision', async t => {
  const { players } = await fixture(t);
  let { player } = await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(4), position: 'end', guildId: '100' });
  assert.equal(player.revision, 1); assert.equal(player.guildId, '100');
  assert.equal(player.current.track.id, 'song0', 'the first song added to an empty player becomes current');
  assert.deepEqual(player.queue.map(entry => entry.track.id), ['song1', 'song2', 'song3']);
  assert.equal(player.playhead.playing, false, 'no device is active, so nothing plays');
  assert.equal(new Set([player.current, ...player.queue].map(entry => entry.entryId)).size, 4);

  // The same song twice is two entries.
  ({ player } = await players.edit(actor, { op: 'add', expectedRevision: 1, tracks: [song(1)], position: 'next' }));
  assert.deepEqual(player.queue.map(entry => entry.track.id), ['song1', 'song1', 'song2', 'song3']);
  const [first, second, third, fourth] = player.queue.map(entry => entry.entryId);
  assert.notEqual(first, second);

  ({ player } = await players.edit(actor, { op: 'add', expectedRevision: 2, tracks: [song(9)], position: { after: third } }));
  assert.deepEqual(player.queue.map(entry => entry.track.id), ['song1', 'song1', 'song2', 'song9', 'song3']);
  ({ player } = await players.edit(actor, { op: 'move', expectedRevision: 3, entryId: fourth, before: first }));
  assert.deepEqual(player.queue.map(entry => entry.track.id), ['song3', 'song1', 'song1', 'song2', 'song9']);
  ({ player } = await players.edit(actor, { op: 'move', expectedRevision: 4, entryId: fourth, before: null }));
  assert.equal(player.queue.at(-1).entryId, fourth);
  ({ player } = await players.edit(actor, { op: 'remove', expectedRevision: 5, entryId: second }));
  assert.equal(player.queue.some(entry => entry.entryId === second), false);
  ({ player } = await players.edit(actor, { op: 'shuffle', expectedRevision: 6 }));
  assert.equal(player.queue.length, 4); assert.equal(player.revision, 7);

  // A stale edit is refused with the current player and changes nothing.
  await assert.rejects(players.edit(actor, { op: 'clear', expectedRevision: 3 }), error => error.status === 409 && error.code === 'stale' && error.player.revision === 7);
  assert.equal(players.get(actor).player.queue.length, 4);
  await rejects(players.edit(actor, { op: 'remove', expectedRevision: 7, entryId: 'nosuchentry0' }), 400, 'unknown_entry');

  ({ player } = await players.edit(actor, { op: 'skipTo', expectedRevision: 7, entryId: player.queue[2].entryId }));
  assert.equal(player.queue.length, 1, 'songs before the chosen one are skipped');
  assert.equal(player.history[0].track.id, 'song0');
  ({ player } = await players.edit(actor, { op: 'play', expectedRevision: 8, tracks: songs(3, 20), startIndex: 1 }));
  assert.equal(player.current.track.id, 'song21'); assert.deepEqual(player.queue.map(entry => entry.track.id), ['song22']);
  ({ player } = await players.edit(actor, { op: 'clear', expectedRevision: 9 }));
  assert.deepEqual(player.queue, []); assert.equal(player.current.track.id, 'song21');
});

test('tracks are validated and bounded', async t => {
  const { players } = await fixture(t);
  for (const bad of [{ ...song(1), uri: 'http://www.youtube.com/watch?v=00000000001' }, { ...song(1), uri: null }, { ...song(1), artworkUrl: 'javascript:alert(1)' },
    { ...song(1), id: 'has spaces' }, { ...song(1), durationMs: -1 }, { ...song(1), uri: `https://example.com/${'a'.repeat(512)}` }]) {
    await rejects(players.edit(actor, { op: 'add', expectedRevision: 0, tracks: [bad], position: 'end' }), 400, 'invalid_input');
  }
  await rejects(players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(51), position: 'end' }), 400, 'invalid_input');
  const { player } = await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: [{ ...song(1), title: `\u0000${'t'.repeat(300)}`, author: 'a'.repeat(300) }], position: 'end' });
  assert.equal(player.current.track.title.length, 200); assert.equal(player.current.track.author.length, 200);
  assert.equal(player.current.track.title.includes('\u0000'), false);
});

test('a queue past 500 songs or 256 KiB is full', async t => {
  const { players } = await fixture(t);
  let revision = 0;
  for (let batch = 0; batch < 10; batch++) revision = (await players.edit(actor, { op: 'add', expectedRevision: revision, tracks: songs(50, batch * 50), position: 'end' })).player.revision;
  const { player } = players.get(actor);
  assert.equal(player.queue.length, 499);
  await players.edit(actor, { op: 'add', expectedRevision: revision++, tracks: [song(999)], position: 'end' });
  await assert.rejects(players.edit(actor, { op: 'add', expectedRevision: revision, tracks: [song(1000)], position: 'end' }), { code: 'queue_full', message: 'Your queue is full.' });

  // Long titles and addresses reach the byte bound first.
  const big = n => ({ ...song(n), title: 't'.repeat(200), author: 'a'.repeat(200), artworkUrl: `https://i.ytimg.com/${'x'.repeat(480)}`, uri: `https://soundcloud.com/${'y'.repeat(470)}${n}` });
  let bigRevision = 0; let full = null;
  for (let batch = 0; batch < 10 && !full; batch++) {
    try { bigRevision = (await players.edit(other, { op: 'add', expectedRevision: bigRevision, tracks: Array.from({ length: 50 }, (_, index) => big(batch * 50 + index)), position: 'end' })).player.revision; }
    catch (error) { full = error; }
  }
  assert.equal(full?.code, 'queue_full');
  assert.ok(players.get(other).player.queue.length < 500);
});

test('advances move the song to history, retries change nothing, and a removed song still becomes current', async t => {
  const { players, clock } = await fixture(t);
  await register(players);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(4), position: 'end' });
  let { player } = await players.activate(actor, { deviceId: phone, guildId: '100' });
  const generation = player.generation;
  const [a, b, c, d] = [player.current, ...player.queue].map(entry => entry.entryId);
  const report = body => players.report(actor, { deviceId: phone, generation, ...body });

  ({ player } = await report({ seq: 1, advance: { from: a, to: b }, playhead: { entryId: b, positionMs: 0, at: clock.now, playing: true } }));
  assert.equal(player.current.entryId, b); assert.deepEqual(player.history.map(entry => entry.entryId), [a]);
  assert.deepEqual(player.queue.map(entry => entry.entryId), [c, d]);
  const revision = player.revision; const version = player.playbackVersion;
  ({ player } = await report({ seq: 1, advance: { from: a, to: b } }));
  assert.equal(player.revision, revision, 'the same report again changes nothing');
  assert.equal(player.playbackVersion, version);
  await rejects(report({ advance: { from: a, to: b } }), 400, 'invalid_input');

  // A remote removed D while the device, offline, played C and then D.
  await players.edit(actor, { op: 'remove', expectedRevision: revision, entryId: d });
  await report({ seq: 2, advance: { from: b, to: c } });
  await rejects(report({ seq: 3, advance: { from: c, to: d } }), 400, 'unknown_entry');
  ({ player } = await report({ seq: 3, advance: { from: c, to: d, track: song(3) } }));
  assert.equal(player.current.entryId, d); assert.equal(player.current.track.id, 'song3');
  assert.deepEqual(player.history.map(entry => entry.entryId), [c, b, a]);
  // Re-sent after reconnecting: all already applied.
  for (const [seq, from, to] of [[1, a, b], [2, b, c], [3, c, d]]) assert.equal((await report({ seq, advance: { from, to } })).player.current.entryId, d);
  ({ player } = await report({ seq: 4, advance: { from: d, to: null } }));
  assert.equal(player.current, null); assert.equal(player.playhead.playing, false);
});

test('going back to a played song brings it back from history and puts the current one next', async t => {
  const { players, clock } = await fixture(t);
  await register(players);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(3), position: 'end' });
  let { player } = await players.activate(actor, { deviceId: phone });
  const [a, b, c] = [player.current, ...player.queue].map(entry => entry.entryId);
  const report = body => players.report(actor, { deviceId: phone, generation: player.generation, ...body });
  await report({ seq: 1, advance: { from: a, to: b } });
  ({ player } = await report({ seq: 2, advance: { from: b, to: a }, playhead: { entryId: a, positionMs: 0, at: clock.now, playing: true } }));
  assert.equal(player.current.entryId, a);
  assert.deepEqual(player.queue.map(entry => entry.entryId), [b, c]);
  assert.deepEqual(player.history, []);
  // And forward again.
  ({ player } = await report({ seq: 3, advance: { from: a, to: b } }));
  assert.equal(player.current.entryId, b); assert.deepEqual(player.history.map(entry => entry.entryId), [a]);
});

test('a retried or out-of-date report never touches a later song', async t => {
  const { players, clock } = await fixture(t);
  await register(players);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(3), position: 'end' });
  let { player } = await players.activate(actor, { deviceId: phone });
  const [a, b, c] = [player.current, ...player.queue].map(entry => entry.entryId);
  const report = body => players.report(actor, { deviceId: phone, generation: player.generation, ...body });
  await report({ seq: 1, advance: { from: a, to: b }, playhead: { entryId: b, positionMs: 0, at: clock.now, playing: true } });
  clock.now += 1000;
  ({ player } = await report({ seq: 2, advance: { from: b, to: c }, playhead: { entryId: c, positionMs: 0, at: clock.now, playing: false } }));
  const settled = structuredClone(player.playhead);
  // The first report again, with its old playhead: C keeps its own.
  ({ player } = await report({ seq: 1, advance: { from: a, to: b }, playhead: { entryId: b, positionMs: 150_000, at: clock.now, playing: true } }));
  assert.equal(player.current.entryId, c); assert.deepEqual(player.playhead, settled);
  // A new report about a song no longer current changes no playhead either.
  ({ player } = await report({ seq: 3, playhead: { entryId: b, positionMs: 150_000, at: clock.now, playing: true }, volume: 30 }));
  assert.deepEqual(player.playhead, settled); assert.equal(player.volume, 30);
});

test('playhead reports change the playback version only on play, pause and seek', async t => {
  const { players, clock } = await fixture(t);
  await register(players);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(2), position: 'end' });
  let { player } = await players.activate(actor, { deviceId: phone });
  const entryId = player.current.entryId; let seq = 0;
  const report = playhead => players.report(actor, { deviceId: phone, generation: player.generation, seq: ++seq, playhead: { entryId, ...playhead } });
  ({ player } = await report({ positionMs: 0, at: clock.now, playing: true }));
  const playing = player.playbackVersion;
  clock.now += 15_000;
  ({ player } = await report({ positionMs: 15_100, at: clock.now, playing: true }));
  assert.equal(player.playbackVersion, playing, 'a periodic report');
  ({ player } = await report({ positionMs: 90_000, at: clock.now, playing: true }));
  assert.equal(player.playbackVersion, playing + 1, 'a seek');
  ({ player } = await report({ positionMs: 90_000, at: clock.now, playing: false }));
  assert.equal(player.playbackVersion, playing + 2, 'a pause');
  ({ player } = await players.report(actor, { deviceId: phone, generation: player.generation, seq: ++seq, volume: 40, repeat: 'queue' }));
  assert.equal(player.volume, 40); assert.equal(player.repeat, 'queue');
  await rejects(report({ positionMs: 0, at: clock.now - 3_600_000, playing: true }), 400, 'invalid_input');
});

test('a newer generation fences reports from the device it replaced', async t => {
  const { players, clock } = await fixture(t);
  await register(players); await register(players, laptop);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(3), position: 'end' });
  let { player } = await players.activate(actor, { deviceId: phone });
  const old = player.generation; const entryId = player.current.entryId;
  await players.report(actor, { deviceId: phone, generation: old, seq: 5, playhead: { entryId, positionMs: 10_000, at: clock.now, playing: true } });
  clock.now += 5000;
  ({ player } = await players.activate(actor, { deviceId: laptop }));
  assert.equal(player.generation, old + 1); assert.equal(player.generationAt, clock.now); assert.equal(player.activeDeviceId, laptop);
  assert.deepEqual(player.playhead, { positionMs: 15_000, at: clock.now, playing: true }, 'the playhead carries on where it was');
  await assert.rejects(players.report(actor, { deviceId: phone, generation: old, seq: 6, playhead: { entryId, positionMs: 20_000, at: clock.now, playing: true } }),
    error => error.status === 409 && error.code === 'replaced' && error.player.activeDeviceId === laptop);
  await rejects(players.report(actor, { deviceId: phone, generation: old + 1, seq: 1, volume: 10 }), 409, 'replaced');
  // The new generation's reports count from 1 again.
  assert.equal((await players.report(actor, { deviceId: laptop, generation: old + 1, seq: 1, volume: 10 })).player.volume, 10);
  await rejects(players.deactivate(actor, { deviceId: phone, generation: old }), 409, 'replaced');
  await rejects(players.activate(actor, { deviceId: 'unregisteredunregister' }), 404, 'unknown_device');

  clock.now += 1000;
  ({ player } = await players.deactivate(actor, { deviceId: laptop, generation: old + 1 }));
  assert.equal(player.activeDeviceId, null); assert.deepEqual(player.playhead, { positionMs: 16_000, at: clock.now, playing: false });
  await rejects(players.report(actor, { deviceId: laptop, generation: old + 1, seq: 2, volume: 10 }), 409, 'replaced');
});

test('controls apply to the stored player, which only plays with an active device', async t => {
  const { players, clock } = await fixture(t);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(3), position: 'end' });
  let { player } = await players.control(actor, { action: 'play' });
  assert.equal(player.playhead.playing, false);
  ({ player } = await players.control(actor, { action: 'seek', value: 30_000 }));
  assert.equal(player.playhead.positionMs, 30_000);
  ({ player } = await players.control(actor, { action: 'next' }));
  assert.equal(player.current.track.id, 'song1'); assert.equal(player.history[0].track.id, 'song0'); assert.equal(player.playhead.positionMs, 0);
  ({ player } = await players.control(actor, { action: 'previous' }));
  assert.equal(player.current.track.id, 'song0'); assert.deepEqual(player.queue.map(entry => entry.track.id), ['song1', 'song2']);
  await players.control(actor, { action: 'volume', value: 55 });
  await players.control(actor, { action: 'repeat', value: 'queue' });
  ({ player } = await players.control(actor, { action: 'next' }));
  assert.equal(player.queue.at(-1).track.id, 'song0', 'repeat queue puts the finished song back at the end');
  assert.equal(player.volume, 55);
  await rejects(players.control(actor, { action: 'volume', value: 201 }), 400, 'invalid_input');
  await rejects(players.control(actor, { action: 'dance' }), 400, 'invalid_input');

  await register(players);
  await players.activate(actor, { deviceId: phone });
  ({ player } = await players.control(actor, { action: 'play' }));
  assert.equal(player.playhead.playing, true);
  clock.now += 5000;
  ({ player } = await players.control(actor, { action: 'pause' }));
  assert.deepEqual(player.playhead, { positionMs: 5000, at: clock.now, playing: false });
});

test('a legacy deck is adopted in batches, keeping what fits and counting the rest', async t => {
  const { players } = await fixture(t);
  let result = await players.adopt(actor, { current: song(0), tracks: songs(49, 1), positionMs: 42_000, volume: 70, repeat: 'track', guildId: '100' });
  assert.equal(result.dropped, 0);
  assert.equal(result.player.current.track.id, 'song0'); assert.equal(result.player.playhead.positionMs, 42_000);
  assert.equal(result.player.volume, 70); assert.equal(result.player.repeat, 'track'); assert.equal(result.player.queue.length, 49);
  for (let batch = 1; batch < 10; batch++) result = await players.adopt(actor, { tracks: songs(50, batch * 50) });
  assert.equal(result.player.queue.length, 499); assert.equal(result.dropped, 0);
  result = await players.adopt(actor, { tracks: songs(50, 500) });
  assert.equal(result.player.queue.length, 500); assert.equal(result.dropped, 49);
  // A player already playing something keeps its own place and settings.
  await players.adopt(other, { tracks: [song(1)] });
  result = await players.adopt(other, { current: song(2), tracks: [], volume: 10 });
  assert.equal(result.player.current.track.id, 'song1'); assert.equal(result.player.queue[0].track.id, 'song2'); assert.equal(result.player.volume, 100);
});

test('devices: validated, at most ten, renamed, forgotten by ID or session, pausing an active one', async t => {
  const { players, clock } = await fixture(t);
  await rejects(players.register(actor, { deviceId: 'short', name: 'Phone', kind: 'android', sessionRef: 'session-a' }), 400, 'invalid_input');
  await rejects(players.register(actor, { deviceId: phone, name: 'Bad\nname', kind: 'android', sessionRef: 'session-a' }), 400, 'invalid_input');
  await rejects(players.register(actor, { deviceId: phone, name: 'Phone', kind: 'fridge', sessionRef: 'session-a' }), 400, 'invalid_input');
  await rejects(players.register(actor, { deviceId: phone, name: 'n'.repeat(41), kind: 'android', sessionRef: 'session-a' }), 400, 'invalid_input');
  let { devices } = await players.register(actor, { deviceId: phone, name: '  Phone  ', kind: 'android', sessionRef: 'session-a' });
  assert.deepEqual(devices, [{ deviceId: phone, name: 'Phone', kind: 'android', lastSeen: clock.now }]);
  ({ devices } = await players.rename(actor, { deviceId: phone, name: 'Kitchen' }));
  assert.equal(devices[0].name, 'Kitchen');
  await rejects(players.rename(actor, { deviceId: laptop, name: 'Nope' }), 404, 'unknown_device');
  assert.deepEqual(players.get(other).devices, [], 'devices belong to one listener');

  for (let n = 0; n < 10; n++) { clock.now += 1000; await register(players, `device${String(n).padStart(16, '0')}`, actor, 'session-b'); }
  ({ devices } = players.get(actor));
  assert.equal(devices.length, 10);
  assert.equal(devices.some(device => device.deviceId === phone), false, 'the least recently seen is forgotten');

  const active = devices[0].deviceId;
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(1), position: 'end' });
  await players.activate(actor, { deviceId: active });
  let { player } = await players.control(actor, { action: 'play' });
  assert.equal(player.playhead.playing, true);
  ({ player, devices } = await players.forget(actor, { deviceId: active }));
  assert.equal(devices.length, 9); assert.equal(player.activeDeviceId, null); assert.equal(player.playhead.playing, false);
  await register(players, laptop, actor, 'session-c');
  await players.activate(actor, { deviceId: devices[0].deviceId });
  ({ player } = await players.control(actor, { action: 'play' }));
  assert.equal(player.playhead.playing, true);
  ({ player, devices } = await players.forgetSession(actor, { sessionRef: 'session-b' }));
  assert.deepEqual(devices.map(device => device.deviceId), [laptop]);
  assert.equal(player.activeDeviceId, null, 'signing out the playing device releases the player');
  assert.equal(player.playhead.playing, false);
});

test('devices are capped overall, and with players stay inside their 2 MiB budget', async t => {
  const { players, library, clock } = await fixture(t);
  const id = n => `d${String(n).padStart(21, '0')}`;
  // The device the first listener plays on is the overall least recently seen.
  await register(players, id(0), '1000', 'session-x');
  await players.adopt('1000', { tracks: [song(1)] });
  await players.activate('1000', { deviceId: id(0) });
  await players.control('1000', { action: 'play' });
  for (let n = 1; n <= PLAYER_LIMITS.allDevices; n++) {
    clock.now += 1;
    await players.register(String(1000 + Math.floor(n / 10)), { deviceId: id(n), name: 'n'.repeat(40), kind: 'browser', sessionRef: 's'.repeat(64) });
  }
  assert.equal(library.state.db.prepare('SELECT COUNT(*) AS devices FROM devices').get().devices, PLAYER_LIMITS.allDevices);
  const { player, devices } = players.get('1000');
  assert.equal(devices.some(device => device.deviceId === id(0)), false);
  assert.equal(player.activeDeviceId, null, 'an evicted active device releases its player');
  assert.equal(player.playhead.playing, false);
  assert.ok(library.state.playerBytes() <= PLAYER_LIMITS.totalBytes);
});

test('players past 2 MiB shed the least recently updated, and prune forgets old players and devices', async t => {
  const { players, library, clock } = await fixture(t);
  const big = n => ({ ...song(n), title: 't'.repeat(200), author: 'a'.repeat(200), artworkUrl: `https://i.ytimg.com/${'x'.repeat(480)}` });
  const listeners = Array.from({ length: 12 }, (_, n) => String(300 + n));
  for (const listener of listeners) {
    clock.now += 1000;
    let revision = 0;
    for (let batch = 0; batch < 4; batch++) revision = (await players.edit(listener, { op: 'add', expectedRevision: revision, tracks: Array.from({ length: 50 }, (_, index) => big(batch * 50 + index)), position: 'end' })).player.revision;
  }
  const total = library.state.db.prepare('SELECT SUM(bytes) AS bytes, COUNT(*) AS players FROM players').get();
  assert.ok(total.bytes <= PLAYER_LIMITS.totalBytes);
  assert.ok(total.players < listeners.length);
  assert.equal(players.get(listeners[0]).player.revision, 0, 'the oldest player went first');
  assert.ok(players.get(listeners.at(-1)).player.queue.length > 0);

  assert.ok(library.state.playerBytes() <= PLAYER_LIMITS.totalBytes);

  await register(players, phone, actor);
  await players.adopt(actor, { tracks: [song(1)] });
  await players.activate(actor, { deviceId: phone });
  assert.equal((await players.control(actor, { action: 'play' })).player.playhead.playing, true);
  clock.now += DEVICE_RETENTION_MS + 1;
  library.state.prune(clock.now);
  assert.equal(players.get(actor).devices.length, 1, 'devices are pruned by the players, not the store');
  await players.prune();
  assert.deepEqual(players.get(actor).devices, []);
  assert.equal(players.get(actor).player.activeDeviceId, null, 'pruning the playing device releases its player');
  assert.equal(players.get(actor).player.playhead.playing, false);
  assert.equal(players.get(actor).player.queue.length + Number(Boolean(players.get(actor).player.current)), 1, 'the player is kept');
  clock.now += PLAYER_RETENTION_MS + 1;
  library.state.prune(clock.now);
  assert.equal(players.get(actor).player.current, null);
});

test('players persist across a restart, stay out of library.json, and live in memory when the store is unavailable', async t => {
  const { players, library, open, dir } = await fixture(t);
  await register(players);
  await players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(3), position: 'end' });
  await library.close();
  const reopened = await open();
  assert.equal(reopened.players.get(actor).player.queue.length, 2);
  assert.equal(reopened.players.get(actor).devices.length, 1);
  assert.equal((await fs.readFile(path.join(dir, 'library.json'), 'utf8').catch(() => '')).includes('song1'), false);
  await reopened.close();

  // A store written by a newer release runs from memory, players included.
  const db = new DatabaseSync(path.join(dir, 'listening-state.sqlite')); db.exec('PRAGMA user_version = 999'); db.close();
  const memory = await open({ logger: { error() {}, warn() {}, log() {} } });
  assert.equal(memory.state.durable, false);
  assert.equal(memory.players.get(actor).player.current, null);
  const { player } = await memory.players.edit(actor, { op: 'add', expectedRevision: 0, tracks: songs(2), position: 'end' });
  assert.equal(player.queue.length, 1);
  assert.equal(memory.players.get(actor).player.revision, 1);
});

test('every device removal moves its listener’s snapshot version', async t => {
  const { players, clock } = await fixture(t);
  await register(players, phone, actor);
  const registered = players.get(actor).player.updatedAt;
  clock.now += DEVICE_RETENTION_MS + 1;
  await players.prune();
  const pruned = players.get(actor);
  assert.deepEqual(pruned.devices, []); assert.ok(pruned.player.updatedAt > registered, 'pruning');

  // The overall cap forgets another listener's device.
  const id = n => `e${String(n).padStart(21, '0')}`;
  await register(players, laptop, other);
  const before = players.get(other).player.updatedAt;
  for (let n = 0; n < PLAYER_LIMITS.allDevices; n++) { clock.now += 1; await register(players, id(n), String(5000 + Math.floor(n / 10))); }
  const evicted = players.get(other);
  assert.deepEqual(evicted.devices, []); assert.ok(evicted.player.updatedAt > before, 'overall eviction');
});
