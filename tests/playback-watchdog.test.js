import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackWatchdog } from '../src/playback-watchdog.js';

function fixture() {
  let time = 0;
  const stalls = [];
  const track = { info: { duration: 200_000, isStream: false } };
  const player = { queue: { current: track }, lastPosition: 0, playing: true, paused: false,
    connected: true, node: { connected: true }, voiceState: {} };
  Object.defineProperty(player, 'position', { get: () => time });
  const watchdog = createPlaybackWatchdog({ now: () => time, onStall: (...args) => stalls.push(args) });
  watchdog.trackStarted(player);
  function sample(at, position = player.lastPosition) {
    time = at;
    player.lastPosition = position;
    watchdog.observe(player);
    watchdog.tick();
  }
  return { player, watchdog, stalls, sample, at: (at) => { time = at; } };
}

test('a frozen reported position triggers one recovery despite an extrapolated position advancing', () => {
  const f = fixture();
  f.sample(10_000);
  f.sample(30_000);
  assert.equal(f.stalls.length, 0); // Startup buffering has its own grace window.
  f.sample(40_000);
  f.sample(45_000);
  assert.equal(f.player.position, 45_000);
  assert.equal(f.stalls.length, 1);
});

test('real progress resets the stall baseline', () => {
  const f = fixture();
  f.sample(20_000, 1000);
  f.sample(40_000, 10_000);
  f.sample(60_000, 20_000);
  assert.equal(f.stalls.length, 0);
  f.sample(90_000, 20_000);
  assert.equal(f.stalls.length, 1);
});

test('only confirmed forward progress may clear playback-failure monitoring', () => {
  const f = fixture();
  assert.equal(f.watchdog.observe(f.player), false);
  f.player.lastPosition = 5000;
  assert.equal(f.watchdog.observe(f.player), true);
  assert.equal(f.watchdog.observe(f.player), false);
  f.player.lastPosition = 1000;
  assert.equal(f.watchdog.observe(f.player), false);
  f.player.paused = true;
  f.player.lastPosition = 10_000;
  assert.equal(f.watchdog.observe(f.player), false);
});

test('paused, disconnected, muted, suppressed, and live players do not false-positive', () => {
  for (const mutate of [
    (player) => { player.paused = true; },
    (player) => { player.connected = false; },
    (player) => { player.node.connected = false; },
    (player) => { player.voiceState.serverMute = true; },
    (player) => { player.voiceState.suppress = true; },
    (player) => { player.queue.current.info.isStream = true; },
  ]) {
    const f = fixture();
    mutate(f.player);
    f.sample(10_000);
    f.sample(80_000);
    f.sample(120_000);
    assert.equal(f.stalls.length, 0);
  }
});

test('missing updates are not interpreted as a stalled audio stream', () => {
  const f = fixture();
  f.sample(10_000);
  f.sample(20_000);
  f.at(80_000);
  f.watchdog.tick();
  assert.equal(f.stalls.length, 0);
});

test('a seek and resume grant time to rebuild source buffers', () => {
  const f = fixture();
  f.sample(20_000, 40_000);
  f.sample(40_000, 10_000); // Backward seek.
  f.sample(45_000, 10_000);
  assert.equal(f.stalls.length, 0);
  f.player.paused = true;
  f.sample(70_000);
  f.player.paused = false;
  f.watchdog.touch(f.player);
  f.sample(75_000);
  assert.equal(f.stalls.length, 0);
  f.sample(100_000);
  assert.equal(f.stalls.length, 1);
});

test('new tracks and replay attempt tokens reset the startup window', () => {
  const f = fixture();
  f.sample(10_000);
  f.sample(40_000);
  assert.equal(f.stalls.length, 1);
  f.player.queue.current.userData = { vybertronPlaybackAttempt: 'next-attempt' };
  f.sample(45_000);
  f.sample(60_000);
  assert.equal(f.stalls.length, 1);
  f.sample(85_000);
  assert.equal(f.stalls.length, 2);
});

test('removal and shutdown release watchdog tracking and interval resources', () => {
  let tick;
  let cleared = 0;
  const watchdog = createPlaybackWatchdog({ timers: { setInterval: (callback) => { tick = callback; return 1; },
    clearInterval: () => { cleared += 1; } } });
  watchdog.start();
  watchdog.start();
  assert.equal(typeof tick, 'function');
  watchdog.stop();
  watchdog.stop();
  assert.equal(cleared, 1);
});
