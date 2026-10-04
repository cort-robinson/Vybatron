import test from 'node:test';
import assert from 'node:assert/strict';
import { fairOrder, enqueueTracks, resolveReferences } from '../src/utils/enqueue.js';
import { recordSkipVote, voteToSkip } from '../src/utils/voting.js';
import { validatePlaybackQuery } from '../src/utils/search.js';
import { requireUserVoice, requireControl } from '../src/utils/guards.js';
import { track } from './fixtures.js';

test('fair queue alternates listeners and keeps each person’s requested order', () => {
  const songs = [track('aaaaaaaaaaa', '1'), track('bbbbbbbbbbb', '1'), track('ccccccccccc', '2'), track('ddddddddddd', '2'), track('eeeeeeeeeee', '3')];
  const ordered = fairOrder(songs, '1');
  assert.deepEqual(ordered.map(t => t.info.identifier), ['ccccccccccc', 'eeeeeeeeeee', 'aaaaaaaaaaa', 'ddddddddddd', 'bbbbbbbbbbb']);
  assert.equal(songs[0].info.identifier, 'aaaaaaaaaaa');
  assert.deepEqual(fairOrder([songs[2], songs[1], songs[4]], '1').map(t => t.requester.id), ['2', '3', '1']);
});

test('playlist overflow rejects before any queue is changed', async () => {
  const player = { guildId: '100', queue: { tracks: Array.from({ length: 500 }, () => track()), add: () => assert.fail('must not add') } };
  await assert.rejects(enqueueTracks({}, player, track()), /at most 500/);
  assert.equal(player.queue.tracks.length, 500);
});

test('saved mix resolution preserves order, skips missing tracks and rejects changed identifiers', async () => {
  let calls = 0; let active = 0; let maxActive = 0;
  const references = Array.from({ length: 9 }, (_, i) => ({ sourceName: 'youtube', identifier: String(i).padStart(11, '0'), uri: `https://youtu.be/${String(i).padStart(11, '0')}` }));
  const player = { async search({ query }) {
    active++; maxActive = Math.max(maxActive, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const id = query.split('/').at(-1);
    return { tracks: id.endsWith('3') ? [] : [track(id.endsWith('4') ? 'wrong000000' : id)] };
  } };
  const result = await resolveReferences(player, references, { id: '200' });
  assert.equal(calls, 9); assert.ok(maxActive <= 4);
  assert.deepEqual(result.tracks.map(t => t.info.identifier), references.filter((_, i) => ![3, 4].includes(i)).map(r => r.identifier));
  assert.equal(result.missing.length, 2);
});

test('hung saved-source lookups time out without late queue writes', async () => {
  const player = { search: () => new Promise(() => {}) };
  const result = await resolveReferences(player, [{ uri: 'https://youtu.be/abcdefghijk' }], { id: '200' }, { timeoutMs: 5 });
  assert.equal(result.tracks.length, 0); assert.equal(result.missing.length, 1);
});

test('votes are unique, scoped to current track, pruned after departures, and require a majority', async () => {
  let skipped = 0;
  const player = { queue: { current: track(), tracks: [track('lmnopqrstuv')] }, skip: async () => { skipped++; } };
  assert.equal(recordSkipVote(player, '1', ['1', '2', '3']).needed, 2);
  assert.equal(recordSkipVote(player, '1', ['1', '2', '3']).duplicate, true);
  assert.equal(recordSkipVote(player, '9', ['1', '2', '3']).error.includes('Join'), true);
  const pruned = recordSkipVote(player, '2', ['2', '3', '4']);
  assert.equal(pruned.count, 1); assert.equal(pruned.passed, false);
  assert.equal((await voteToSkip(player, '3', ['2', '3', '4'])).passed, true);
  assert.equal(skipped, 1);
  player.queue.current = track('lmnopqrstuv');
  assert.equal(recordSkipVote(player, '2', ['2', '3', '4']).count, 1);
});

test('source input accepts catalog/search intent and blocks arbitrary network paths', () => {
  for (const query of ['tame impala loser', 'autocomplete:200:123456abcdef', 'https://open.spotify.com/track/abc', 'https://music.youtube.com/playlist?list=PL123', 'https://artist.bandcamp.com/track/song']) assert.equal(validatePlaybackQuery(query), null);
  for (const query of ['http://127.0.0.1:2333/admin', 'https://evil.youtube.com/watch?v=abcdefghijk', 'file:///etc/passwd', 'https://secret:password@youtube.com/watch?v=abcdefghijk', 'link:https://127.0.0.1/admin', 'ytsearch:https://127.0.0.1/admin', 'uri:file:///etc/passwd']) assert.equal(typeof validatePlaybackQuery(query), 'string');
});

test('cross-channel add requests and non-DJ controls fail while favorites/votes remain accessible', async () => {
  const player = { voiceChannelId: '300' }; const replies = [];
  const interaction = { guildId: '100', member: { voice: { channel: { id: '301' } }, roles: { cache: new Map() } }, client: { lavalink: { getPlayer: () => player }, library: { settings: () => ({ djRoleId: '500' }) } }, reply: async p => { replies.push(p.content); } };
  assert.equal(await requireUserVoice(interaction), null);
  interaction.member.voice.channel.id = '300';
  assert.equal(await requireControl(interaction), null);
  assert.equal(await requireControl(interaction, { checkDJ: false }), player);
  assert.equal(replies.length, 2);
});
