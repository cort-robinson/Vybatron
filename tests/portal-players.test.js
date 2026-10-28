import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture } from './portal-fixtures.js';

const phone = 'phonephonephonephone01';
const song = n => ({ id: `song${n}`, title: `Song ${n}`, author: 'Artist', uri: `https://www.youtube.com/watch?v=${String(n).padStart(11, '0')}`,
  source: 'youtube', durationMs: 200_000, artworkUrl: null, isStream: false });

async function fixture(t) {
  const f = await portalFixture(t, { idle: true });
  const player = (body, actor = '200') => f.request(`/v1/users/${actor}/player`, { body, actor });
  const devices = (body, actor = '200') => f.request(`/v1/users/${actor}/devices`, { body, actor });
  const read = (actor = '200') => f.request(`/v1/users/${actor}/player`, { actor });
  return { ...f, player, devices, read };
}

test('the bridge serves each listener their own player and devices', async t => {
  const f = await fixture(t);
  const empty = await f.read();
  assert.equal(empty.status, 200);
  assert.equal(empty.body.player.current, null); assert.deepEqual(empty.body.devices, []);

  const registered = await f.devices({ op: 'register', deviceId: phone, name: 'Phone', kind: 'android', sessionRef: 'session-a' });
  assert.equal(registered.status, 200); assert.equal(registered.body.devices[0].name, 'Phone');
  assert.equal(JSON.stringify(registered.body).includes('session-a'), false, 'the session reference never leaves the store');
  const added = await f.player({ op: 'add', expectedRevision: 0, tracks: [song(1), song(2)], position: 'end', guildId: '100' });
  assert.equal(added.status, 200); assert.equal(added.body.player.guildId, '100'); assert.equal(added.body.player.queue.length, 1);
  const active = await f.player({ op: 'activate', deviceId: phone });
  assert.equal(active.body.player.activeDeviceId, phone);

  // Another listener sees none of it, and can't act on it.
  const other = await f.read('201');
  assert.equal(other.body.player.current, null); assert.deepEqual(other.body.devices, []);
  assert.equal((await f.player({ op: 'activate', deviceId: phone }, '201')).body.error.code, 'unknown_device');
  assert.equal((await f.player({ op: 'report', deviceId: phone, generation: 1, seq: 1, volume: 5 }, '201')).body.error.code, 'replaced');
  assert.equal((await f.read()).body.player.volume, 100);

  // Refusals carry the current player.
  const stale = await f.player({ op: 'clear', expectedRevision: 0 });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'stale'); assert.equal(stale.body.player.revision, 1);
  const replaced = await f.player({ op: 'report', deviceId: phone, generation: 0, seq: 1, volume: 5 });
  assert.equal(replaced.status, 409); assert.equal(replaced.body.error.code, 'replaced'); assert.equal(replaced.body.player.generation, 1);
  assert.equal((await f.player({ op: 'dance' })).status, 400);
  assert.equal((await f.devices({ op: 'activate', deviceId: phone })).status, 400, 'device operations and player operations are separate');
  assert.equal((await f.player({ op: 'add', expectedRevision: 1, tracks: [{ ...song(3), uri: 'http://insecure.example/' }], position: 'end' })).body.error.code, 'invalid_input');
});

test('changing the server a player plays through requires membership there', async t => {
  const f = await fixture(t);
  await f.devices({ op: 'register', deviceId: phone, name: 'Phone', kind: 'browser', sessionRef: 'session-a' }, '900');
  const outsider = await f.player({ op: 'add', expectedRevision: 0, tracks: [song(1)], position: 'end', guildId: '100' }, '900');
  assert.equal(outsider.status, 403); assert.equal(outsider.body.error.code, 'membership_required');
  assert.equal((await f.player({ op: 'activate', deviceId: phone, guildId: '100' }, '900')).status, 403);
  assert.equal((await f.player({ op: 'adopt', tracks: [song(1)], guildId: '100' }, '900')).status, 403);
  // Without a server the player is still theirs to use.
  assert.equal((await f.player({ op: 'add', expectedRevision: 0, tracks: [song(1)], position: 'end' }, '900')).status, 200);
  assert.equal((await f.player({ op: 'add', expectedRevision: 1, tracks: [song(2)], position: 'end', guildId: '999' })).status, 404);
  assert.equal((await f.read('900')).body.player.guildId, null);
});

test('player requests need the bridge secret and fit the body limit', async t => {
  const f = await fixture(t);
  const unauthenticated = await fetch(`${f.origin}/v1/users/200/player`);
  assert.equal(unauthenticated.status, 401);
  const tooLarge = await f.player({ op: 'adopt', tracks: Array.from({ length: 50 }, (_, n) => ({ ...song(n), title: 'x'.repeat(400) })) });
  assert.equal(tooLarge.status, 400); assert.equal(tooLarge.body.error.code, 'body_limit');
  assert.equal((await f.request('/v1/users/not-a-user/player', {})).status, 404);
  assert.equal((await f.request('/v1/users/200/devices', {})).status, 400, 'devices are listed with the player');
});
