import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { ATTEMPT_KEY } from '../src/playback-recovery.js';

// Lavalink reports where a song is; the fixture's node answers like a song still loading until `moving`.
function loadingNode(f) {
  const state = { position: 0, moving: false, calls: 0 };
  f.node.fetchPlayer = async () => {
    state.calls += 1;
    if (state.moving) state.position += 300;
    return { track: { info: { identifier: f.player.queue.current?.info?.identifier } }, state: { position: state.position } };
  };
  return state;
}

test('a fresh song’s position holds still in Discord until Lavalink reports its audio moving', async t => {
  const f = await portalFixture(t, { owner: { id: '202' } });
  const lavalink = loadingNode(f);
  // The last report from the song before, which lavalink-client keeps until Lavalink's next update.
  f.player.lastPosition = 0; f.player.lastPositionChange = Date.now();
  await f.player.play({ clientTrack: track('lmnopqrstuv') });
  await delay(700);
  let session = (await f.request('', { actor: '202' })).body.session;
  assert.equal(session.status, 'playing');
  assert.equal(session.starting, true);
  assert.equal(session.positionMs, 0, 'the clock does not run while the song loads');
  assert.ok(lavalink.calls >= 2);

  lavalink.moving = true;
  await delay(700);
  session = (await f.request('', { actor: '202' })).body.session;
  assert.equal(session.starting, false);
  assert.ok(session.positionMs > 0 && session.positionMs < 1500, `positionMs ${session.positionMs}`);
  const calls = lavalink.calls; await delay(600);
  assert.equal(lavalink.calls, calls, 'polling stops once the song moves');
});

test('a held position Lavalink corrects changes the revision, so the page hears about it', async t => {
  const f = await portalFixture(t, { owner: { id: '202' } });
  const lavalink = loadingNode(f);
  // A stale place from the song before, until Lavalink is asked about the new one.
  f.node.fetchPlayer = async () => { await delay(400); lavalink.calls += 1; return { track: { info: { identifier: f.player.queue.current?.info?.identifier } }, state: { position: 0 } }; };
  await f.player.play({ clientTrack: track('lmnopqrstuv'), position: 95_000 });
  const before = (await f.request('', { actor: '202' })).body;
  assert.equal(before.session.positionMs, 95_000);
  await delay(600);
  const after = (await f.request('', { actor: '202' })).body;
  assert.equal(after.session.starting, true);
  assert.equal(after.session.positionMs, 0);
  assert.notEqual(after.revision, before.revision);
});

test('a song already playing when the portal first sees it keeps its running position', async t => {
  const f = await portalFixture(t, { owner: { id: '202' } });
  loadingNode(f);
  f.player.lastPosition = 10_000; f.player.lastPositionChange = Date.now() - 2000;
  const session = (await f.request('', { actor: '202' })).body.session;
  assert.equal(session.starting, false);
  assert.ok(Math.abs(session.positionMs - 12_000) < 150, `positionMs ${session.positionMs}`);
});

test('a copy from another source starts by its attempt token, though Lavalink names it by its URL', async t => {
  const f = await portalFixture(t, { owner: { id: '202' } });
  let position = 0; let calls = 0;
  f.node.fetchPlayer = async () => {
    calls += 1; position += 300;
    const current = f.player.queue.current;
    return { track: { info: { identifier: 'https://cdn.example/song.flac' }, userData: { [ATTEMPT_KEY]: current?.userData?.[ATTEMPT_KEY] } },
      state: { position } };
  };
  f.player.lastPosition = 0; f.player.lastPositionChange = Date.now();
  const copy = track('lmnopqrstuv');
  copy.userData = { ...copy.userData, [ATTEMPT_KEY]: 'attempt-1' };
  await f.player.play({ clientTrack: copy });
  await delay(900);
  const session = (await f.request('', { actor: '202' })).body.session;
  assert.equal(session.starting, false);
  const settled = calls; await delay(600);
  assert.equal(calls, settled, 'polling stops once the copy moves');
});
