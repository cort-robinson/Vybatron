import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startIdleTimer,
  clearIdleTimer,
  handleTrackStart,
  handleQueueEnd,
  handleTrackError,
  handleTrackFailure,
} from '../src/lavalink.js';
import {
  getControllerRecord,
  resetControllers,
} from '../src/utils/player-controller.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  handleQueueEnd(player);
  clearIdleTimer('idle-4');
  assert.equal(player.destroyed, 0);
});

test('V10: first trackStart sends once and later starts edit the controller', async () => {
  const channel = mockChannel();
  const client = mockClient(channel);
  const player = mockPlayer('a1');
  await handleTrackStart(client, player, track);
  assert.equal(channel.sends, 1);

  const nextTrack = { info: { title: 'Next', uri: 'https://youtu.be/y' } };
  player.queue.current = nextTrack;
  await handleTrackStart(client, player, nextTrack);
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
  handleQueueEnd(client, player);
  await sleep(10);
  assert.match(JSON.stringify(channel.lastPayload), /Playback Unavailable/);
  assert.doesNotMatch(JSON.stringify(channel.lastPayload), /Queue Finished/);
  await handleTrackStart(client, player, track);
  handleQueueEnd(client, player);
  await sleep(10);
  assert.match(JSON.stringify(channel.lastPayload), /Queue Finished/);
  clearIdleTimer(player.guildId);
});
