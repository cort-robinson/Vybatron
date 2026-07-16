import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageComponent } from '../src/utils/components.js';
import { trackIdentity } from '../src/utils/presentation.js';

function track(index) {
  return {
    info: {
      title: `Track ${index}`,
      author: 'Artist',
      duration: 60_000,
      identifier: `id-${index}`,
      uri: `https://example.com/${index}`,
    },
  };
}

function player() {
  return {
    guildId: 'guild',
    textChannelId: 'text',
    voiceChannelId: 'voice',
    paused: false,
    position: 0,
    volume: 100,
    queue: { current: track(0), tracks: [track(1), track(2)] },
    pauseCalls: 0,
    resumeCalls: 0,
    skipCalls: [],
    destroyCalls: 0,
    async pause() { this.paused = true; this.pauseCalls += 1; },
    async resume() { this.paused = false; this.resumeCalls += 1; },
    async skip(index) { this.skipCalls.push(index); },
    async destroy() { this.destroyCalls += 1; },
  };
}

function interaction(customId, currentPlayer, { voice = 'voice', values = [] } = {}) {
  const calls = [];
  const result = {
    customId,
    guildId: 'guild',
    channelId: 'text',
    user: { username: 'listener' },
    member: { voice: { channel: voice ? { id: voice } : null } },
    client: { lavalink: { getPlayer: () => currentPlayer } },
    message: { edit: async (payload) => { calls.push(['message.edit', payload]); } },
    values,
    deferred: false,
    replied: false,
    isButton: () => !customId.includes(':jump:'),
    isStringSelectMenu: () => customId.includes(':jump:'),
    async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
    async followUp(payload) { calls.push(['followUp', payload]); },
    async update(payload) { this.replied = true; calls.push(['update', payload]); },
    async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); },
    async editReply(payload) { calls.push(['editReply', payload]); },
    calls,
  };
  return result;
}

test('controller toggle rechecks voice authorization', async () => {
  const p = player();
  const wrongVoice = interaction('player:v1:toggle', p, { voice: 'other' });
  await handleMessageComponent(wrongVoice);
  assert.equal(p.pauseCalls, 0);
  assert.equal(wrongVoice.calls[0][0], 'reply');

  const allowed = interaction('player:v1:toggle', p);
  await handleMessageComponent(allowed);
  assert.equal(p.pauseCalls, 1);
  assert.deepEqual(allowed.calls.map(([name]) => name), ['deferUpdate', 'followUp']);

  const paused = player();
  paused.paused = true;
  const resume = interaction('player:v1:toggle', paused);
  await handleMessageComponent(resume);
  assert.equal(paused.resumeCalls, 1);
});

test('skip and stop handle empty and active queue states safely', async () => {
  const empty = player();
  empty.queue.tracks = [];
  const skip = interaction('player:v1:skip', empty);
  await handleMessageComponent(skip);
  assert.equal(empty.skipCalls.length, 0);
  assert.match(skip.calls[0][1].content, /No queued track/i);

  const active = player();
  const stop = interaction('player:v1:stop', active);
  await handleMessageComponent(stop);
  assert.equal(active.destroyCalls, 1);
  assert.deepEqual(stop.calls.map(([name]) => name), ['deferUpdate', 'followUp']);
});

test('view queue and pagination are available without the control guard', async () => {
  const p = player();
  const view = interaction('player:v1:queue', p, { voice: null });
  await handleMessageComponent(view);
  assert.equal(view.calls[0][0], 'reply');
  assert.equal(view.calls[0][1].embeds[0].data.title, 'Queue');

  const page = interaction('queue:v1:page:1', p, { voice: null });
  await handleMessageComponent(page);
  assert.equal(page.calls[0][0], 'update');
});

test('stale player controls disable themselves and explain the ended session', async () => {
  const stale = interaction('player:v1:toggle', null);
  await handleMessageComponent(stale);
  assert.deepEqual(stale.calls.map(([name]) => name), ['message.edit', 'reply']);
  assert.deepEqual(stale.calls[0][1].components, []);
  assert.match(stale.calls[1][1].content, /session has ended/i);
});

test('queue jumps reject stale identities and accept a current selection', async () => {
  const p = player();
  const stale = interaction('queue:v1:jump:0', p, { values: ['1:stalehash'] });
  await handleMessageComponent(stale);
  assert.deepEqual(stale.calls.map(([name]) => name), ['update', 'followUp']);
  assert.equal(p.skipCalls.length, 0);
  assert.match(stale.calls[1][1].content, /queue changed/i);

  const value = `2:${trackIdentity(p.queue.tracks[1])}`;
  const current = interaction('queue:v1:jump:0', p, { values: [value] });
  await handleMessageComponent(current);
  assert.deepEqual(p.skipCalls, [2]);
  assert.deepEqual(current.calls.map(([name]) => name), ['deferUpdate', 'editReply', 'followUp']);
});
