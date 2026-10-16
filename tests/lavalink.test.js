import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startIdleTimer,
  clearIdleTimer,
  handleTrackStart,
  handleQueueEnd,
  handleTrackError,
  handleTrackFailure,
  handleVoiceStateUpdate,
  handlePlayerDestroy,
} from '../src/lavalink.js';
import { startPresence } from '../src/utils/presence.js';
import { presentationWritePending } from '../src/utils/presentation-updates.js';
import {
  getControllerRecord,
  resetControllers,
} from '../src/utils/player-controller.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drainPresentation(guildId) {
  const deadline = Date.now() + 1000;
  while (presentationWritePending(`controller:${guildId}`) || presentationWritePending(`voice:${guildId}`)) {
    assert.ok(Date.now() < deadline, 'scheduled presentation did not drain');
    await sleep(1);
  }
}

function mockPlayer(guildId = 'g1') {
  let destroyed = 0;
  let skips = 0;
  return {
    guildId,
    textChannelId: 'c1',
    voiceChannelId: 'v1',
    paused: false,
    position: 0,
    volume: 100,
    queue: { current: track, tracks: [] },
    destroy: () => {
      destroyed += 1;
      return Promise.resolve();
    },
    skip: async (position, throwError) => {
      assert.equal(position, 0);
      assert.equal(throwError, false);
      skips += 1;
    },
    get destroyed() {
      return destroyed;
    },
    get skips() {
      return skips;
    },
  };
}

function mockClient(channel) {
  return { channels: { cache: new Map(channel ? [['c1', channel]] : []) } };
}

function mockChannel(sendImpl) {
  let sends = 0;
  let edits = 0;
  let lastPayload;
  const messages = new Map();
  return {
    messages: {
      fetch: (id) => Promise.resolve(messages.get(id) || null),
    },
    send: async (...args) => {
      lastPayload = args[0];
      sends += 1;
      if (sendImpl) return sendImpl(...args);
      const message = {
        id: `m${sends}`,
        edit: async (payload) => { lastPayload = payload; edits += 1; return message; },
      };
      messages.set(message.id, message);
      return message;
    },
    get sends() {
      return sends;
    },
    get edits() {
      return edits;
    },
    get lastPayload() { return lastPayload; },
  };
}

const track = { info: { title: 'Song', uri: 'https://youtu.be/x', artworkUrl: null } };

test.afterEach(() => {
  resetControllers();
});

test('V9: idle timer destroys player after timeout', async () => {
  const player = mockPlayer('idle-1');
  startIdleTimer(player, 10);
  await sleep(40);
  assert.equal(player.destroyed, 1);
});

test('idle disconnect clears the voice status while still connected', async () => {
  const player = mockPlayer('idle-status');
  const events = [];
  const destroy = player.destroy;
  player.destroy = () => { events.push('destroy'); return destroy(); };
  const client = mockClient(mockChannel());
  client.user = { id: 'bot' };
  client.lavalink = { getPlayer: () => player };
  client.rest = { put: async (_route, { body }) => { await sleep(5); events.push(`status:${body.status}`); } };
  startIdleTimer(player, { ms: 5, client });
  await sleep(60);
  assert.deepEqual(events, ['status:null', 'destroy']);
});

test('V9: cleared idle timer never destroys', async () => {
  const player = mockPlayer('idle-2');
  startIdleTimer(player, 10);
  clearIdleTimer('idle-2');
  await sleep(40);
  assert.equal(player.destroyed, 0);
});

test('V9: restarting idle timer does not double-destroy', async () => {
  const player = mockPlayer('idle-3');
  startIdleTimer(player, 10);
  startIdleTimer(player, 10);
  await sleep(40);
  assert.equal(player.destroyed, 1);
});

test('V9: queueEnd starts idle timer (cancellable)', () => {
  const player = mockPlayer('idle-4');
  player.queue.current = null;
  handleQueueEnd(player);
  clearIdleTimer('idle-4');
  assert.equal(player.destroyed, 0);
});

test('V10: first trackStart sends once and later starts edit the controller', async () => {
  const channel = mockChannel();
  const client = mockClient(channel);
  const player = mockPlayer('a1');
  await handleTrackStart(client, player, track);
  await drainPresentation(player.guildId);
  assert.equal(channel.sends, 1);

  const nextTrack = { info: { title: 'Next', uri: 'https://youtu.be/y' } };
  player.queue.current = nextTrack;
  await handleTrackStart(client, player, nextTrack);
  await drainPresentation(player.guildId);
  assert.equal(channel.sends, 1);
  assert.equal(channel.edits, 1);
});

test('V10: trackStart cancels pending idle destroy', async () => {
  const player = mockPlayer('a2');
  startIdleTimer(player, 15);
  await handleTrackStart(mockClient(mockChannel()), player, track);
  await sleep(50);
  assert.equal(player.destroyed, 0);
});

test('a track start preserves the existing empty-channel disconnect deadline', async () => {
  const player = mockPlayer('empty-channel-start');
  const client = mockClient(mockChannel());
  startIdleTimer(player, { ms: 15, reason: 'voice-empty', client });
  await handleTrackStart(client, player, track);
  await sleep(45);
  assert.equal(player.destroyed, 1);
});

test('repeated unrelated voice events do not restart the empty-channel deadline', async () => {
  const player = mockPlayer('empty-channel-repeat');
  const client = mockClient(mockChannel());
  client.lavalink = { getPlayer: () => player };
  const oldState = { guild: { id: player.guildId, channels: { cache: new Map([['v1', {
    members: { filter: () => ({ size: 0 }) },
  }]]) } } };
  startIdleTimer(player, { ms: 15, reason: 'voice-empty', client });
  handleVoiceStateUpdate(client, oldState);
  handleVoiceStateUpdate(client, oldState);
  await sleep(45);
  assert.equal(player.destroyed, 1);
});

test('the bot leaves one minute after being moved into an empty voice channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = mockPlayer('empty-channel-move');
  const client = mockClient(mockChannel());
  client.lavalink = { getPlayer: () => player };
  const guild = { id: player.guildId, channels: { cache: new Map([
    ['v1', { members: { filter: () => ({ size: 1 }) } }],
    ['v2', { members: { filter: () => ({ size: 0 }) } }],
  ]) } };
  try {
    handleVoiceStateUpdate(client, { guild }, 'v2');
    t.mock.timers.tick(59_000);
    assert.equal(player.destroyed, 0);
    t.mock.timers.tick(1_000);
    // The voice status clear settles before the disconnect.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(player.destroyed, 1);
  } finally {
    clearIdleTimer(player.guildId);
  }
});

test('a listener joining an empty queue does not cancel queue-idle disconnect', async () => {
  const player = mockPlayer('queue-empty-join');
  player.queue.current = null;
  const client = mockClient(mockChannel());
  client.lavalink = { getPlayer: () => player };
  const oldState = { guild: { id: player.guildId, channels: { cache: new Map([['v1', {
    members: { filter: () => ({ size: 1 }) },
  }]]) } } };
  startIdleTimer(player, { ms: 15, reason: 'queue-empty', client });
  handleVoiceStateUpdate(client, oldState);
  await sleep(45);
  assert.equal(player.destroyed, 1);
});

test('V5: trackStart with missing channel resolves safely', async () => {
  await assert.doesNotReject(handleTrackStart(mockClient(null), mockPlayer('a3'), track));
});

test('V5: failed send does not throw or reject unhandled', async () => {
  const channel = mockChannel(() => Promise.reject(new Error('boom')));
  await assert.doesNotReject(handleTrackStart(mockClient(channel), mockPlayer('a4'), track));
});

test('track failures are carried into the controller record', async () => {
  const player = mockPlayer('a5');
  await handleTrackStart(mockClient(mockChannel()), player, track);
  handleTrackFailure(player, { info: { title: 'Broken track' } });
  assert.match(getControllerRecord('a5').notice, /Couldn.*play Broken track; skipped/);
});

test('protocol track errors recover to the next queue entry', async () => {
  const player = mockPlayer('error-recovery');
  await handleTrackError(player, track, { type: 'TrackExceptionEvent' }, { error: () => {} });
  assert.equal(player.skips, 1);
});

test('a failed final track displays playback unavailable instead of queue finished', async () => {
  const player = mockPlayer('failed-last');
  const channel = mockChannel();
  const client = mockClient(channel);
  await handleTrackStart(client, player, track);
  handleTrackFailure(player, track);
  player.queue.current = null;
  handleQueueEnd(client, player);
  await sleep(10);
  assert.match(JSON.stringify(channel.lastPayload), /Playback Unavailable/);
  assert.doesNotMatch(JSON.stringify(channel.lastPayload), /Queue Finished/);
  player.queue.current = track;
  await handleTrackStart(client, player, track);
  player.queue.current = null;
  handleQueueEnd(client, player);
  await sleep(10);
  assert.match(JSON.stringify(channel.lastPayload), /Queue Finished/);
  clearIdleTimer(player.guildId);
});

test('late teardown cleans the old watcher while keeping replacement presence, voice status and idle deadline', async () => {
  const old = mockPlayer('replacement-destroy');
  const replacement = mockPlayer(old.guildId);
  const client = mockClient(mockChannel());
  const invalidated = [];
  const removed = [];
  const presence = [];
  const statuses = [];
  client.user = { setPresence: (payload) => presence.push(payload) };
  client.rest = { put: async (_route, options) => statuses.push(options.body.status) };
  client.lavalink = {
    getPlayer: () => replacement,
    playbackRecovery: { started: () => {}, invalidate: (player) => invalidated.push(player) },
    playbackWatchdog: { trackStarted: () => {}, remove: (player) => removed.push(player) },
  };
  const stopPresence = startPresence(client);
  try {
    await handleTrackStart(client, replacement, track);
    startIdleTimer(replacement, { ms: 20, reason: 'voice-empty', client });
    const presenceCount = presence.length;
    const statusCount = statuses.length;
    handlePlayerDestroy(client, old);
    assert.deepEqual(invalidated, [old]);
    assert.deepEqual(removed, [old]);
    assert.equal(presence.length, presenceCount);
    assert.equal(statuses.length, statusCount);
    assert.equal(getControllerRecord(old.guildId).player, replacement);
    await sleep(60);
    assert.equal(replacement.destroyed, 1, 'the old cleanup must not clear the replacement deadline');
  } finally {
    clearIdleTimer(replacement.guildId);
    stopPresence();
  }
});
