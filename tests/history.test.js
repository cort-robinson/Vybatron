import test from 'node:test';
import assert from 'node:assert/strict';
import { Queue, QueueSaver } from 'lavalink-client';
import { buildHistoryPayload, historySessionKey, replayHistoryTrack } from '../src/utils/history.js';
import { trackIdentity } from '../src/utils/presentation.js';
import { execute as replayCommand } from '../src/commands/replay.js';

function track(id = 'recent') {
  return {
    encoded: `encoded-${id}`,
    info: { title: id, author: 'Artist', identifier: id, duration: 60_000, sourceName: 'youtube' },
    requester: { id: 'original-listener', username: 'Original listener' },
    pluginInfo: { clientData: { previousTrack: true } },
  };
}

function fixture() {
  const player = {
    guildId: 'history-guild', voiceChannelId: 'voice', playing: true, paused: false,
    queue: new Queue('history-guild', { current: track('current'), previous: [track('recent'), track('older')], tracks: [track('upcoming')] }, new QueueSaver()),
    playCalls: 0,
    async play() { this.playCalls += 1; this.queue.current = this.queue.tracks.shift(); this.playing = true; },
  };
  return player;
}

test('history reads the native previous queue and replay adds a clone next without interrupting playback', async () => {
  const player = fixture();
  const original = player.queue.previous[0];
  const current = player.queue.current;
  const result = await replayHistoryTrack(player, 1, trackIdentity(original));
  assert.equal(player.playCalls, 0);
  assert.equal(player.queue.current, current);
  assert.notEqual(result.track, original);
  assert.equal(result.track.requester, original.requester);
  assert.equal(player.queue.tracks[0], result.track);
  assert.equal(player.queue.tracks[1].info.title, 'upcoming');
  assert.equal(player.queue.previous.length, 2);
  assert.equal(original.pluginInfo.clientData.previousTrack, true);
  assert.equal(result.track.pluginInfo.clientData.previousTrack, undefined);
});

test('replay refuses stale history and starts an idle session safely', async () => {
  const player = fixture();
  const before = player.queue.tracks.length;
  assert.match((await replayHistoryTrack(player, 1, '000000000000')).error, /History changed/);
  assert.match((await replayHistoryTrack(player, 100)).error, /History changed/);
  assert.match((await replayHistoryTrack(player, -1)).error, /Choose/);
  assert.equal(player.queue.tracks.length, before);
  player.queue.current = null;
  player.playing = false;
  const result = await replayHistoryTrack(player, 2);
  assert.equal(result.started, true);
  assert.equal(player.playCalls, 1);
  assert.equal(player.queue.current.info.title, 'older');
});

test('history replay obeys the shared queue limit without dropping existing tracks', async () => {
  const player = fixture();
  player.queue.tracks = Array.from({ length: 500 }, (_, index) => track(String(index)));
  const result = await replayHistoryTrack(player, 1);
  assert.match(result.error, /at most 500/);
  assert.equal(player.queue.tracks.length, 500);
  assert.equal(player.queue.tracks[0].info.title, '0');
});

test('history views are bounded, mention-safe, and bound to their player session', () => {
  const player = fixture();
  player.queue.previous = Array.from({ length: 25 }, (_, index) => ({
    ...track(String(index)), info: { ...track().info, title: `**@everyone**${'🎵'.repeat(400)}`, author: 'A'.repeat(500) },
  }));
  const payload = buildHistoryPayload(player, 0, 'owner');
  const json = payload.embeds[0].toJSON();
  assert.ok(json.description.length <= 4096);
  assert.ok(json.description.includes('@\u200b'));
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.equal(payload.components[1].components[0].options.length, 8);
  assert.ok(payload.components[1].components[0].options[0].data.label.length <= 100);
  assert.ok(payload.components.flatMap((row) => row.components).every((component) => component.data.custom_id.length <= 100));
  assert.equal(historySessionKey(player), historySessionKey(player));
  assert.notEqual(historySessionKey(player), historySessionKey(fixture()));
  const last = buildHistoryPayload(player, 1000, 'owner');
  assert.equal(last.components[1].components[0].options.length, 1);
  assert.equal(buildHistoryPayload(null).components.length, 0);
});

test('/replay rechecks history after deferring and enforces voice authorization', async () => {
  const player = fixture();
  const calls = [];
  const interaction = {
    guildId: 'guild', user: { id: 'listener' }, options: { getInteger: () => 1 },
    member: { voice: { channel: { id: 'voice' } } },
    client: { lavalink: { getPlayer: () => player } },
    async reply(payload) { calls.push(['reply', payload]); },
    async deferReply() { calls.push(['deferReply']); player.queue.previous.unshift(track('newer')); },
    async editReply(payload) { calls.push(['editReply', payload]); },
  };
  const before = player.queue.tracks.length;
  await replayCommand(interaction);
  assert.equal(player.queue.tracks.length, before);
  assert.deepEqual(calls.map(([name]) => name), ['deferReply', 'editReply']);
  assert.match(calls[1][1].content, /History changed/);
  interaction.member.voice.channel.id = 'other';
  calls.length = 0;
  await replayCommand(interaction);
  assert.equal(calls[0][0], 'reply');
  assert.match(calls[0][1].content, /voice channel/);
});
