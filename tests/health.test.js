import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startHealthServer } from '../src/health.js';
import { acquirePlaybackRequest, maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';
import { loadCommands } from '../src/commands/index.js';
import { recordPlaybackFailure } from '../src/utils/playback-health.js';

test('health reports outages and recovery over HTTP without exposing private client state', async () => {
  let discordReady = false;
  const node = { connected: false, authorization: 'private-password' };
  const client = {
    isReady: () => discordReady,
    token: 'private-token',
    lavalink: { nodeManager: { nodes: new Map([['main', node]]) } },
  };
  const server = startHealthServer(client, { port: 0 });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/health`)).status, 503);
    discordReady = true;
    assert.equal((await fetch(`${url}/health`)).status, 503);
    node.connected = true;
    const healthy = await fetch(`${url}/health`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ready: true, discordReady: true, audioReady: true, draining: false });
    recordPlaybackFailure(client, { info: { sourceName: 'youtube', identifier: 'RYnFIRc0k6E' } });
    const playback = await (await fetch(`${url}/playback`)).json();
    assert.equal(playback.failures[0].identifier, 'RYnFIRc0k6E');
    assert.doesNotMatch(JSON.stringify(playback), /private/);
    discordReady = false;
    assert.equal((await fetch(`${url}/health`)).status, 503);
    assert.equal((await fetch(`${url}/anything-else`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('readiness, liveness, diagnostics, and shutdown report distinct states with strict HTTP methods', async () => {
  const node = { connected: false };
  const client = {
    isReady: () => false,
    runtimeState: { draining: false },
    token: 'private-token',
    lavalink: { nodeManager: { nodes: new Map([['main', node]]) },
      players: new Map([['private-guild', { paused: true, queue: { tracks: [{ title: 'private-track' }] } }]]) },
  };
  const server = startHealthServer(client, { port: 0 });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/ready`)).status, 503);
    assert.deepEqual(await (await fetch(`${url}/live`)).json(), { alive: true });
    const status = await (await fetch(`${url}/status`)).json();
    assert.equal(status.players, 1);
    assert.equal(status.paused, 1);
    assert.equal(status.queuedTracks, 1);
    assert.doesNotMatch(JSON.stringify(status), /private/);
    assert.equal((await fetch(`${url}/health`, { method: 'HEAD' })).status, 503);
    assert.equal((await fetch(`${url}/health`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/maintenance/begin`)).status, 405);
    client.runtimeState.draining = true;
    setMaintenance(client, true);
    assert.equal((await fetch(`${url}/live`)).status, 503);
    assert.equal((await fetch(`${url}/maintenance/end`, { method: 'POST' })).status, 409);
    assert.equal(maintenanceStatus(client).active, true);
    client.isReady = () => { throw new Error('private upstream detail'); };
    const failure = await fetch(`${url}/health`);
    assert.equal(failure.status, 503);
    assert.deepEqual(await failure.json(), { error: 'health_unavailable' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('maintenance drains in-flight requests and protects active, paused, and queued music', async () => {
  const players = new Map();
  const client = { isReady: () => true, lavalink: { players } };
  const release = acquirePlaybackRequest(client);
  const server = startHealthServer(client, { port: 0 });
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/maintenance`;
  try {
    const begin = await fetch(`${url}/begin`, { method: 'POST' });
    assert.deepEqual(await begin.json(), { active: true, inFlight: 1, busy: false });
    assert.equal(acquirePlaybackRequest(client), null);
    release();
    release();
    assert.equal(maintenanceStatus(client).inFlight, 0);
    for (const player of [{ playing: true }, { paused: true }, { queue: { current: {} } }, { queue: { tracks: [{}] } }]) {
      players.set('private-guild', player);
      assert.deepEqual(await (await fetch(url)).json(), { active: true, inFlight: 0, busy: true });
    }
    players.clear();
    await fetch(`${url}/end`, { method: 'POST' });
    assert.deepEqual(maintenanceStatus(client), { active: false, inFlight: 0, busy: false });
    acquirePlaybackRequest(client)();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a crashed updater cannot leave playback disabled indefinitely', (t) => {
  const client = {};
  t.mock.method(Date, 'now', () => 1000);
  setMaintenance(client, true);
  assert.equal(acquirePlaybackRequest(client), null);
  Date.now.mock.mockImplementation(() => 1000 + 15 * 60_000);
  const release = acquirePlaybackRequest(client);
  assert.equal(typeof release, 'function');
  release();
});

test('slash command routing refuses new playback during maintenance and releases requests afterward', async () => {
  let handler;
  const client = { on: (name, callback) => { handler = callback; } };
  await loadCommands(client);
  for (const commandName of ['play', 'playnext']) {
    let message;
    const interaction = {
      client, commandName,
      guildId: '123456789012345678',
      options: {},
      isAutocomplete: () => false, isMessageComponent: () => false,
      isModalSubmit: () => false, isChatInputCommand: () => true,
      // Once maintenance ends, the real command exits through its voice guard.
      member: { voice: {} },
      reply: async (payload) => { message = payload; },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async (payload) => { message = payload; },
      followUp: async (payload) => { message = payload; },
    };
    setMaintenance(client, true);
    await handler(interaction);
    assert.match(message.content, /briefly updating/);
    assert.equal(maintenanceStatus(client).inFlight, 0);
    setMaintenance(client, false);
    await handler(interaction);
    assert.doesNotMatch(JSON.stringify(message), /briefly updating/);
    assert.match(message.content, /Join a voice channel/);
    assert.equal(maintenanceStatus(client).inFlight, 0);
  }
});
