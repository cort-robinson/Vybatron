import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installRuntime, publicError } from '../src/runtime.js';
import { acquirePlaybackRequest } from '../src/utils/maintenance.js';
import { setSleepTimer, sleepTimer } from '../src/utils/sleep-timer.js';

function fixture(options = {}) {
  const events = [];
  const logs = [];
  const exits = [];
  const processObject = new EventEmitter();
  const server = Object.assign(new EventEmitter(), {
    listening: true,
    close: (callback) => { events.push('health'); callback(); },
    closeAllConnections: () => {},
  });
  const client = {
    library: { close: async () => { events.push('library'); } },
    lavalink: { playbackWatchdog: { stop: () => events.push('watchdog') },
      players: new Map([['guild', {}]]),
      playbackRecovery: { invalidate: () => events.push('invalidate') },
      nodeManager: { nodes: new Map([['main', { connected: true }]]),
      disconnectAll: async (...args) => { assert.deepEqual(args, [false, false]); events.push('audio'); } } },
    destroy: async () => { events.push('discord'); },
  };
  const runtime = installRuntime(client, {
    server, processObject, exit: (code) => exits.push(code),
    logger: { info: (line) => logs.push(line), error: (line) => logs.push(line) },
    stopPresence: () => events.push('presence'), ...options,
  });
  return { client, server, runtime, events, logs, exits, processObject };
}

test('shutdown gates playback immediately, flushes persistence before transport, and runs once', async () => {
  const f = fixture();
  f.processObject.emit('SIGTERM');
  f.processObject.emit('SIGINT');
  assert.equal(f.client.runtimeState.draining, true);
  assert.equal(acquirePlaybackRequest(f.client), null);
  await f.runtime.shutdown();
  assert.deepEqual(f.events, ['watchdog', 'invalidate', 'library', 'presence', 'audio', 'discord', 'health']);
  assert.deepEqual(f.exits, [0]);
  assert.equal(f.processObject.listenerCount('SIGTERM'), 0);
  assert.equal(f.server.listenerCount('error'), 0);
});

test('shutdown cancels sleep timers before it drains, so a restart keeps the checkpoint', async () => {
  const f = fixture();
  const player = f.client.lavalink.players.get('guild');
  let fired = 0;
  setSleepTimer(player, { afterTrack: true, onFire: () => { fired++; } });
  const release = acquirePlaybackRequest(f.client);
  const shuttingDown = f.runtime.shutdown();
  assert.equal(sleepTimer(player), null, 'cancelled while requests still drain');
  release();
  await shuttingDown;
  assert.equal(fired, 0);
});

test('shutdown waits for in-flight requests before closing their persistence store', async () => {
  const f = fixture();
  const release = acquirePlaybackRequest(f.client);
  const shuttingDown = f.runtime.shutdown();
  assert.deepEqual(f.events, ['watchdog', 'invalidate']);
  release();
  await shuttingDown;
  assert.equal(f.events[2], 'library');
  assert.deepEqual(f.exits, [0]);
});

test('graceful restart flushes its checkpoint before leaving voice and removing resumable remote players', async () => {
  const f = fixture();
  const current = { title: 'checkpoint track', position: 12_000 };
  let saved;
  const player = { current, async destroy(reason) {
    assert.equal(reason, 'shutdown-disconnect');
    assert.equal(saved, current);
    assert.equal(f.client.runtimeState.draining, true);
    f.events.push('voice');
    this.current = null;
  } };
  f.client.lavalink.players.set('guild', player);
  f.client.library.close = async () => { saved = player.current; f.events.push('library'); };
  await f.runtime.shutdown();
  assert.deepEqual(f.events, ['watchdog', 'invalidate', 'library', 'presence', 'voice', 'audio', 'discord', 'health']);
  assert.equal(saved.position, 12_000);
  assert.equal(player.current, null);
  assert.deepEqual(f.exits, [0]);
});

test('fatal errors stop the unhealthy process without leaking upstream error text', async () => {
  const f = fixture();
  const error = Object.assign(new Error('private-token https://signed.example'), { code: 'ECONNRESET' });
  f.processObject.emit('uncaughtException', error);
  await f.runtime.shutdown();
  assert.deepEqual(f.exits, [1]);
  assert.doesNotMatch(f.logs.join('\n'), /private-token|signed\.example/);
  assert.ok(f.logs.some((line) => line.includes('ECONNRESET')));
  assert.deepEqual(publicError({ name: 'PRIVATE_TOKEN', code: 'PRIVATE_TOKEN' }), { type: 'Error' });
});

test('a failed cleanup still closes transports and produces a failing exit code', async () => {
  const f = fixture();
  f.client.library.close = async () => { throw new Error('private persistence path'); };
  await f.runtime.shutdown();
  assert.deepEqual(f.events, ['watchdog', 'invalidate', 'presence', 'audio', 'discord', 'health']);
  assert.deepEqual(f.exits, [1]);
  assert.doesNotMatch(f.logs.join('\n'), /private persistence/);
});

test('a stalled cleanup has a hard deadline so Docker can recover the process', async () => {
  const f = fixture({ timeoutMs: 40 });
  f.client.library.close = () => new Promise(() => {});
  await f.runtime.shutdown();
  assert.deepEqual(f.exits, [1]);
  assert.ok(f.logs.some((line) => JSON.parse(line).event === 'shutdown_timeout'));
});

test('a health listener failure is fatal and cannot leave a running unmonitored bot', async () => {
  const f = fixture();
  f.server.emit('error', Object.assign(new Error('private host'), { code: 'EADDRINUSE' }));
  await f.runtime.shutdown();
  assert.deepEqual(f.exits, [1]);
  assert.ok(f.logs.some((line) => JSON.parse(line).event === 'health_server_failed'));
});
