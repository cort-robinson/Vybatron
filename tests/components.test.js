import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageComponent, handleModalSubmit } from '../src/utils/components.js';
import { createOrUpdate, resetControllers } from '../src/utils/player-controller.js';
import { trackIdentity } from '../src/utils/presentation.js';
import { historySessionKey } from '../src/utils/history.js';
import { showStatus } from '../src/utils/player-controller.js';
import { guardedMutation } from '../src/utils/requests.js';

function track(index) {
  return {
    info: {
      title: `Track ${index}`,
      author: 'Artist',
      duration: 60_000,
      isSeekable: true,
      identifier: `id-${index}`,
      uri: `https://example.com/${index}`,
    },
  };
}

function player() {
  const result = {
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
    stopPlayingCalls: 0,
    shuffleCalls: 0,
    repeatMode: 'off',
    seekCalls: [],
    destroyCalls: 0,
    async pause() { this.paused = true; this.pauseCalls += 1; },
    async resume() { this.paused = false; this.resumeCalls += 1; },
    async skip(index) { this.skipCalls.push(index); },
    async stopPlaying() { this.stopPlayingCalls += 1; },
    async setRepeatMode(mode) { this.repeatMode = mode; },
    async seek(position) { this.position = position; this.seekCalls.push(position); },
    async destroy() { this.destroyCalls += 1; },
  };
  result.queue.shuffle = async () => { result.shuffleCalls += 1; };
  return result;
}

function interaction(customId, currentPlayer, { voice = 'voice', values = [], timestamp = '0:30' } = {}) {
  const calls = [];
  const result = {
    customId,
    guildId: 'guild',
    channelId: 'text',
    user: { id: 'listener-id', username: 'listener' },
    member: { voice: { channel: voice ? { id: voice } : null } },
    client: { lavalink: { getPlayer: () => currentPlayer } },
    message: { edit: async (payload) => { calls.push(['message.edit', payload]); } },
    values,
    fields: { getTextInputValue: () => timestamp },
    deferred: false,
    replied: false,
    isButton: () => !customId.includes(':jump:'),
    isStringSelectMenu: () => customId.includes(':jump:'),
    async reply(payload) { this.replied = true; calls.push(['reply', payload]); },
    async followUp(payload) { calls.push(['followUp', payload]); },
    async update(payload) { this.replied = true; calls.push(['update', payload]); },
    async deferUpdate() { this.deferred = true; calls.push(['deferUpdate']); },
    async deferReply(payload) { this.deferred = true; calls.push(['deferReply', payload]); },
    async editReply(payload) { calls.push(['editReply', payload]); },
    async showModal(payload) { this.replied = true; calls.push(['showModal', payload]); },
    calls,
  };
  return result;
}

test.afterEach(resetControllers);

test('controller toggle rechecks voice authorization', async () => {
  const p = player();
  const wrongVoice = interaction('player:v1:toggle', p, { voice: 'other' });
  await handleMessageComponent(wrongVoice);
  assert.equal(p.pauseCalls, 0);
  assert.equal(wrongVoice.calls[0][0], 'reply');

  const allowed = interaction('player:v1:toggle', p);
  await handleMessageComponent(allowed);
  assert.equal(p.pauseCalls, 1);
  assert.deepEqual(allowed.calls.map(([name]) => name), ['deferUpdate']);

  const paused = player();
  paused.paused = true;
  const resume = interaction('player:v1:toggle', paused);
  await handleMessageComponent(resume);
  assert.equal(paused.resumeCalls, 1);
});

test('skip and confirmed stop handle empty and active queue states safely', async () => {
  const empty = player();
  empty.queue.tracks = [];
  const skip = interaction('player:v1:skip', empty);
  await handleMessageComponent(skip);
  assert.equal(empty.skipCalls.length, 0);
  assert.equal(empty.stopPlayingCalls, 1);
  assert.deepEqual(skip.calls.map(([name]) => name), ['deferUpdate']);

  const active = player();
  const stop = interaction('player:v1:stop', active);
  await handleMessageComponent(stop);
  assert.equal(active.destroyCalls, 0);
  assert.equal(stop.calls[0][0], 'reply');

  const confirm = interaction('player:v1:stop-confirm', active);
  await handleMessageComponent(confirm);
  assert.equal(active.destroyCalls, 1);
  assert.deepEqual(confirm.calls.map(([name]) => name), ['update', 'followUp']);
});

test('shuffle, loop, and refresh buttons update the shared controller', async () => {
  const p = player();
  const shuffle = interaction('player:v1:shuffle', p);
  await handleMessageComponent(shuffle);
  assert.equal(p.shuffleCalls, 1);
  assert.deepEqual(shuffle.calls.map(([name]) => name), ['deferUpdate']);

  const loop = interaction('player:v1:loop', p);
  await handleMessageComponent(loop);
  assert.equal(p.repeatMode, 'track');
  assert.deepEqual(loop.calls.map(([name]) => name), ['deferUpdate']);

  const refresh = interaction('player:v1:refresh', p, { voice: null });
  await handleMessageComponent(refresh);
  assert.deepEqual(refresh.calls.map(([name]) => name), ['deferUpdate']);
});

test('seek button enforces voice access and opens a track-bound modal', async () => {
  const p = player();
  const denied = interaction('player:v1:seek', p, { voice: 'other' });
  await handleMessageComponent(denied);
  assert.equal(denied.calls[0][0], 'reply');

  const allowed = interaction('player:v1:seek', p);
  await handleMessageComponent(allowed);
  assert.equal(allowed.calls[0][0], 'showModal');
  assert.match(allowed.calls[0][1].data.custom_id, /^player:v1:seek-submit:[a-f0-9]{12}$/);
});

test('seek modal rejects stale tracks and seeks the current track', async () => {
  const p = player();
  const identity = trackIdentity(p.queue.current);
  const valid = interaction(`player:v1:seek-submit:${identity}`, p, { timestamp: '0:30' });
  await handleModalSubmit(valid);
  assert.deepEqual(p.seekCalls, [30_000]);
  assert.deepEqual(valid.calls.map(([name]) => name), ['deferReply', 'editReply']);

  const stale = interaction('player:v1:seek-submit:000000000000', p);
  await handleModalSubmit(stale);
  assert.deepEqual(p.seekCalls, [30_000]);
  assert.equal(stale.calls[0][0], 'reply');

  const racedIdentity = trackIdentity(p.queue.current);
  const raced = interaction(`player:v1:seek-submit:${racedIdentity}`, p);
  raced.deferReply = async function deferReply(payload) {
    this.deferred = true;
    this.calls.push(['deferReply', payload]);
    p.queue.current = track(9);
  };
  await handleModalSubmit(raced);
  assert.deepEqual(p.seekCalls, [30_000]);
  assert.match(raced.calls[1][1].content, /track changed/i);

  p.queue.current.info.isStream = true;
  const streamIdentity = trackIdentity(p.queue.current);
  const stream = interaction(`player:v1:seek-submit:${streamIdentity}`, p);
  await handleModalSubmit(stream);
  assert.deepEqual(stream.calls.map(([name]) => name), ['deferReply', 'editReply']);
  assert.match(stream.calls[1][1].content, /does not support seeking/i);
});

test('view queue and pagination are available without the control guard', async () => {
  const p = player();
  const view = interaction('player:v1:queue', p, { voice: null });
  await handleMessageComponent(view);
  assert.equal(view.calls[0][0], 'reply');
  assert.equal(view.calls[0][1].embeds[0].data.title, 'Queue');

  const page = interaction('queue:v1:page:1:next', p, { voice: null });
  await handleMessageComponent(page);
  assert.equal(page.calls[0][0], 'update');

  const legacyPage = interaction('queue:v1:page:0', p, { voice: null });
  await handleMessageComponent(legacyPage);
  assert.equal(legacyPage.calls[0][0], 'update');
});

test('owned queue pagination rejects other users', async () => {
  const p = player();
  const denied = interaction('queue:v2:page:owner-id:1:next', p, { voice: null });
  await handleMessageComponent(denied);
  assert.equal(denied.calls[0][0], 'reply');
  assert.match(denied.calls[0][1].content, /Only the person/i);

  const allowed = interaction('queue:v2:page:listener-id:1:next', p, { voice: null });
  await handleMessageComponent(allowed);
  assert.equal(allowed.calls[0][0], 'update');
});

test('stale player controls disable themselves and explain the ended session', async () => {
  const stale = interaction('player:v1:toggle', null);
  await handleMessageComponent(stale);
  assert.deepEqual(stale.calls.map(([name]) => name), ['reply', 'message.edit']);
  assert.deepEqual(stale.calls[1][1].components, []);
  assert.match(stale.calls[0][1].content, /session has ended/i);
});

test('an orphaned public controller cannot control the active session', async () => {
  const p = player();
  const controllerClient = {
    channels: {
      cache: new Map([['text', { send: async () => ({ id: 'active-controller' }) }]]),
    },
  };
  await createOrUpdate(controllerClient, p);

  const stale = interaction('player:v1:toggle', p);
  stale.message.id = 'orphaned-controller';
  await handleMessageComponent(stale);

  assert.equal(p.pauseCalls, 0);
  assert.deepEqual(stale.calls.map(([name]) => name), ['reply', 'message.edit']);
  assert.match(stale.calls[0][1].content, /no longer active/i);

  const active = interaction('player:v1:toggle', p);
  active.message.id = 'active-controller';
  await handleMessageComponent(active);
  assert.equal(p.pauseCalls, 1);
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
  assert.deepEqual(current.calls.map(([name]) => name), ['deferUpdate', 'editReply']);
});

test('history replay is owner-bound, session-bound, voice-guarded, and stale-safe', async () => {
  const p = player();
  p.queue.previous = [track(3), track(4)];
  p.playing = true;
  p.queue.add = async (track, position) => { p.queue.tracks.splice(position, 0, track); };
  const session = historySessionKey(p);
  const customId = `history:v2:replay:listener-id:${session}:0`;
  const value = `1:${trackIdentity(p.queue.previous[0])}`;
  function selection({ voice = 'voice', selected = value } = {}) {
    const result = interaction(customId, p, { voice, values: [selected] });
    result.isStringSelectMenu = () => true;
    result.isButton = () => false;
    return result;
  }
  const wrongVoice = selection({ voice: 'other' });
  await handleMessageComponent(wrongVoice);
  assert.equal(p.queue.tracks.length, 2);
  assert.match(wrongVoice.calls[0][1].content, /voice channel/);

  const otherOwner = selection();
  otherOwner.user.id = 'another-listener';
  await handleMessageComponent(otherOwner);
  assert.match(otherOwner.calls[0][1].content, /Only the person/);

  const stale = selection({ selected: '1:000000000000' });
  await handleMessageComponent(stale);
  assert.equal(p.queue.tracks.length, 2);
  assert.deepEqual(stale.calls.map(([name]) => name), ['deferUpdate', 'editReply', 'followUp']);
  assert.match(stale.calls.at(-1)[1].content, /History changed/);

  const allowed = selection();
  await handleMessageComponent(allowed);
  assert.equal(p.queue.tracks.length, 3);
  assert.equal(p.queue.tracks[0].info.title, 'Track 3');
  assert.match(allowed.calls.at(-1)[1].content, /replay next/);

  const oldSession = selection();
  oldSession.client.lavalink.getPlayer = () => player();
  await handleMessageComponent(oldSession);
  assert.deepEqual(oldSession.calls.map(([name]) => name), ['update', 'followUp']);
  assert.match(oldSession.calls.at(-1)[1].content, /session has ended/);
});

test('help navigation stays private to its owner without requiring voice access', async () => {
  const allowed = interaction('help:v2:topic:listener-id', null, { voice: null, values: ['sources'] });
  allowed.isStringSelectMenu = () => true;
  allowed.isButton = () => false;
  await handleMessageComponent(allowed);
  assert.equal(allowed.calls[0][0], 'update');
  assert.match(allowed.calls[0][1].embeds[0].data.title, /Sources/);
  const denied = interaction('help:v2:topic:owner', null, { values: ['library'] });
  denied.isStringSelectMenu = () => true;
  await handleMessageComponent(denied);
  assert.match(denied.calls[0][1].content, /Only the person/);
});

test('favorite buttons reject changed tracks and listeners outside the bot voice channel', async () => {
  const p = player();
  const validId = `player:v2:favorite:${trackIdentity(p.queue.current)}`;
  const denied = interaction(validId, p, { voice: 'other' });
  await handleMessageComponent(denied);
  assert.match(denied.calls[0][1].content, /voice channel/);
  const stale = interaction('player:v2:favorite:000000000000', p);
  await handleMessageComponent(stale);
  assert.match(stale.calls[0][1].content, /track changed/);
});

test('favorite integration saves for a non-DJ listener after an early component acknowledgement', async () => {
  const p = player();
  p.queue.current.info.sourceName = 'youtube';
  p.queue.current.info.uri = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const i = interaction(`player:v2:favorite:${trackIdentity(p.queue.current)}`, p);
  const favorites = [];
  i.client.library = {
    settings: () => ({ djRoleId: 'dj-role' }),
    async updateFavorites(userId, mutate) { return mutate(favorites); },
  };
  i.member.roles = { cache: new Map() };
  i.isMessageComponent = () => true;
  i.isModalSubmit = () => false;
  await guardedMutation(i, handleMessageComponent, { playback: false });
  assert.equal(favorites.length, 1);
  assert.equal(favorites[0].uri, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.deepEqual(i.calls.map(([name]) => name), ['deferUpdate', 'followUp']);
  assert.match(i.calls.at(-1)[1].content, /Saved/);

  const control = interaction('player:v1:toggle', p);
  control.client.library = i.client.library;
  control.member.roles = i.member.roles;
  await handleMessageComponent(control);
  assert.equal(p.pauseCalls, 0);
  assert.match(control.calls[0][1].content, /DJ role/);
});

test('recovery also rejects stale transport and seek submissions at the handler boundary', async () => {
  const p = player();
  const i = interaction('player:v1:toggle', p);
  await showStatus(i.client, p, 'recovering', 'Reconnecting.');
  await handleMessageComponent(i);
  assert.equal(p.pauseCalls, 0);
  assert.match(i.calls[0][1].content, /reconnecting/);
  const modal = interaction(`player:v1:seek-submit:${trackIdentity(p.queue.current)}`, p);
  await handleModalSubmit(modal);
  assert.equal(p.seekCalls.length, 0);
  assert.match(modal.calls[0][1].content, /reconnecting/);
});
