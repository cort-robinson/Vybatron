import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startIdleTimer,
  clearIdleTimer,
  handleTrackStart,
  handleQueueEnd,
} from '../src/lavalink.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockPlayer(guildId = 'g1') {
  let destroyed = 0;
  return {
    guildId,
    textChannelId: 'c1',
    destroy: () => {
      destroyed += 1;
      return Promise.resolve();
    },
    get destroyed() {
      return destroyed;
    },
  };
}

function mockClient(channel) {
  return { channels: { cache: new Map(channel ? [['c1', channel]] : []) } };
}

function mockChannel(sendImpl) {
  let sends = 0;
  return {
    send: (...args) => {
      sends += 1;
      return sendImpl ? sendImpl(...args) : Promise.resolve();
    },
    get sends() {
      return sends;
    },
  };
}

const track = { info: { title: 'Song', uri: 'https://youtu.be/x', artworkUrl: null } };

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

test('V10: trackStart sends exactly one embed', () => {
  const channel = mockChannel();
  const client = mockClient(channel);
  handleTrackStart(client, mockPlayer('a1'), track);
  assert.equal(channel.sends, 1);
});

test('V10: trackStart cancels pending idle destroy', async () => {
  const player = mockPlayer('a2');
  startIdleTimer(player, 15);
  handleTrackStart(mockClient(mockChannel()), player, track);
  await sleep(50);
  assert.equal(player.destroyed, 0);
});

test('V5: trackStart with missing channel does not throw', () => {
  assert.doesNotThrow(() => handleTrackStart(mockClient(null), mockPlayer('a3'), track));
});

test('V5: failed send does not throw or reject unhandled', async () => {
  const channel = mockChannel(() => Promise.reject(new Error('boom')));
  assert.doesNotThrow(() => handleTrackStart(mockClient(channel), mockPlayer('a4'), track));
  await sleep(10);
});
