import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PermissionFlagsBits } from 'discord.js';
import { PlayStats } from '../src/utils/play-stats.js';
import { MusicLibrary, trackReference } from '../src/utils/library.js';
import { fillRadioQueue, lessLikeThis, mixUrl, promoteSuggestion, pruneSuggestions, refreshSuggestions, setRadio, suggestions, takeSuggestion } from '../src/utils/radio.js';
import { nextListener, rankShared, rankedSeeds, readRoomTaste, recordTurn, sharedChannelIds, tasteListeners } from '../src/utils/room-taste.js';
import { artistKeyOf, songKey } from '../src/utils/song-identity.js';
import { track } from './fixtures.js';

const NOW = 1_800_000_000_000;
const quiet = { error() {}, log() {}, warn() {} };

const song = (id, { title = `Song ${id}`, author = `Artist ${id}` } = {}) => {
  const value = track(id, '200');
  return { ...value, info: { ...value.info, sourceName: 'youtube', title, author, duration: 200_000, isStream: false, uri: `https://www.youtube.com/watch?v=${id}` } };
};
const member = (id, { deaf = false, hidden = [] } = {}) => ({ id, user: { id, bot: false }, voice: { selfDeaf: deaf }, hidden });
const channel = id => ({ id, permissionsFor: who => ({ has: flag => flag === PermissionFlagsBits.ViewChannel && !who.hidden.includes(id) }) });

// A fake stats store: each listener's requests, top artists and early skips.
function fakeStats({ top = {}, artists = {}, skips = {}, channels = ['300'] } = {}) {
  const calls = [];
  return {
    available: true, calls,
    voiceChannelIds: () => channels,
    topTracks: (guildId, userId, scope) => { calls.push(['top', userId, scope.visibleChannelIds]); return (top[userId] || []).map(item => ({ track: trackReference(item) })); },
    topArtists: (guildId, userId) => (artists[userId] || []).map(artistKey => ({ artistKey })),
    earlySkips: (guildId, userId) => skips[userId] || [],
  };
}
const fakeLibrary = ({ favorites = {}, optedOut = [] } = {}) => ({
  favorites: id => (favorites[id] || []).map(trackReference), tasteInAutoplay: id => !optedOut.includes(id),
});

test('only present, hearing listeners who have not opted out shape the room', () => {
  const library = fakeLibrary({ optedOut: ['203'] });
  const members = [member('200'), member('201', { deaf: true }), member('202'), member('203')];
  assert.deepEqual(tasteListeners(library, members).map(item => item.id), ['200', '202']);
  assert.deepEqual(tasteListeners({ tasteInAutoplay: () => { throw new Error('bad'); } }, members), [], 'a failing preference read leaves the listener out');
});

test('plays count only from voice channels everyone present can see', () => {
  const guild = { id: '100', channels: { cache: new Map([['300', channel('300')], ['301', channel('301')]]) } };
  const stats = fakeStats({ channels: ['300', '301', '302'] });
  assert.deepEqual(sharedChannelIds(stats, guild, [member('200'), member('201')]), ['300', '301'], 'an unknown channel is never shared');
  assert.deepEqual(sharedChannelIds(stats, guild, [member('200'), member('201', { hidden: ['301'] })]), ['300'],
    'a channel hidden from one person in the room is left out, even if that person opted out');
});

test('the room reads each listener’s requests, favorites and early skips, and nothing when stats are unavailable', () => {
  const guild = { id: '100', channels: { cache: new Map([['300', channel('300')]]) } };
  const shared = song('sharedsong1', { author: 'Both Like' });
  const stats = fakeStats({ top: { 200: [song('alicetop001'), shared], 201: [shared] }, artists: { 200: ['alice artist'] }, skips: { 201: ['bob|skipped'] } });
  const library = fakeLibrary({ favorites: { 200: [song('alicefav001')], 201: [song('bobfav00001', { author: 'Both Like' })] } });
  const client = { stats, library };
  const room = readRoomTaste(client, guild, [member('200'), member('201'), member('202', { deaf: true })], NOW);
  assert.deepEqual(room.listeners.map(item => item.id), ['200', '201']);
  assert.deepEqual(room.listeners[0].seeds.map(item => item.identifier), ['alicetop001', 'alicefav001', 'sharedsong1'], 'requests and favorites interleave');
  assert.equal(room.songs.get(songKey(trackReference(shared))), 2);
  assert.ok(room.listeners[1].skipped.has('bob|skipped'));
  assert.ok(stats.calls.every(([, , channels]) => channels.join() === '300'));
  assert.deepEqual(readRoomTaste({ stats: { available: false }, library }, guild, [member('200')], NOW).listeners, []);
  const broken = { ...stats, topTracks: (guildId, userId) => { if (userId === '200') throw new Error('read failed'); return stats.topTracks(guildId, userId, { visibleChannelIds: [] }); } };
  assert.deepEqual(readRoomTaste({ stats: broken, library }, guild, [member('200'), member('201')], NOW).listeners.map(item => item.id), ['201'],
    'one failed read leaves out one listener, not the room');
});

test('turns go to the least-served listener, and someone new is heard next without taking every pick', () => {
  const room = { listeners: [{ id: '200' }, { id: '201' }] };
  const turns = new Map();
  const order = [];
  for (let index = 0; index < 4; index++) { const next = nextListener(room, turns); order.push(next.id); recordTurn(turns, next.id, index); }
  assert.deepEqual(order, ['200', '201', '200', '201']);
  room.listeners.push({ id: '202' });
  const later = [];
  for (let index = 4; index < 7; index++) { const next = nextListener(room, turns); later.push(next.id); recordTurn(turns, next.id, index); }
  assert.deepEqual(later, ['202', '200', '201'], 'a late arrival starts level with the others');
  assert.equal(nextListener({ listeners: [] }, turns), null);
});

test('songs and artists shared by people in the room come first', () => {
  const a = trackReference(song('aaaaaaaaaaa')); const b = trackReference(song('bbbbbbbbbbb'));
  const room = { listeners: [{}, {}], songs: new Map([[songKey(b), 2]]), artists: new Map([[artistKeyOf('Artist cccccccccc'), 2], [artistKeyOf('Artist aaaaaaaaaa'), 1]]) };
  assert.deepEqual(rankedSeeds({ seeds: [a, b] }, room).map(item => item.identifier), ['bbbbbbbbbbb', 'aaaaaaaaaaa']);
  const candidates = [song('aaaaaaaaaa'), song('cccccccccc')];
  assert.deepEqual(rankShared(candidates, room).map(item => item.info.identifier), ['cccccccccc', 'aaaaaaaaaa'], 'only artists two people like move up');
  assert.deepEqual(rankShared(candidates, { ...room, listeners: [{}] }), candidates, 'one listener keeps relevance order');
});

// A session with two listeners in voice and the real autoplay engine.
function session({ mixes, top = {}, favorites = {}, optedOut = [], skips = {}, members = [member('200'), member('201')], onSearch, channels = { 300: channel('300') } }) {
  const requests = [];
  const player = {
    guildId: '100', voiceChannelId: '300', playing: false, paused: false,
    queue: { current: null, previous: [song('roomseed001')], tracks: [], async add(tracks) { this.tracks.push(...tracks); }, async splice() {} },
    async search({ query }) { requests.push(query); const id = query.match(/list=RD([\w-]{11})/)?.[1]; onSearch?.(id); return mixes[id] || { loadType: 'error', tracks: [] }; },
  };
  const voice = { members: new Map(members.map(item => [item.id, item])) };
  const guild = { id: '100', channels: { cache: new Map(Object.entries({ ...channels, 300: Object.assign(voice, channels[300]) })) } };
  const library = { ...fakeLibrary({ favorites, optedOut }), settings: () => ({ autoplay: 'on' }), readGuild: () => ({ history: [] }) };
  const client = { user: { id: '999' }, library, stats: fakeStats({ top, skips, channels: Object.keys(channels) }), lavalink: { getPlayer: () => player }, guilds: { cache: new Map([['100', guild]]) } };
  return { player, client, voice, requests, optedOut };
}
const mix = (...ids) => ({ loadType: 'playlist', tracks: ids.map(id => song(id)) });

test('autoplay takes turns seeding from each listener in the room', async () => {
  const f = session({
    top: { 200: [song('aliceseed01')], 201: [song('bobseed0001')] },
    mixes: { aliceseed01: mix('alicepick01', 'alicepick02'), bobseed0001: mix('bobpick0001', 'bobpick0002'), roomseed001: mix('roompick001') },
  });
  setRadio(f.player, null);
  await refreshSuggestions(f.player, f.client, { random: () => 0, now: () => NOW });
  assert.deepEqual(suggestions(f.player).map(item => item.info.identifier), ['alicepick01', 'bobpick0001', 'alicepick02']);
  assert.deepEqual(f.requests.slice(0, 2), [mixUrl('aliceseed01'), mixUrl('bobseed0001')]);
  assert.ok(suggestions(f.player).every(item => item.requester.id === '999'), 'picks stay autoplay picks for play statistics');
});

test('picks for someone who leaves are dropped, and an opted-out listener never seeds', async () => {
  const f = session({
    top: { 200: [song('aliceseed01')], 201: [song('bobseed0001')] }, optedOut: ['201'],
    mixes: { aliceseed01: mix('alicepick01', 'alicepick02', 'alicepick03'), bobseed0001: mix('bobpick0001'), roomseed001: mix('roompick001') },
  });
  await refreshSuggestions(f.player, f.client, { random: () => 0, now: () => NOW });
  assert.ok(!f.requests.includes(mixUrl('bobseed0001')), 'opted-out taste is never read into a pick');
  assert.deepEqual(suggestions(f.player).map(item => item.info.identifier), ['alicepick01', 'alicepick02', 'alicepick03']);
  f.voice.members.delete('200');
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.deepEqual(f.player.queue.tracks.map(item => item.info.identifier), ['roompick001'], 'their prepared picks left with them');
});

test('a present listener’s early skips stay out, and less like this retires a taste seed', async () => {
  const skipped = song('skipped0001');
  const f = session({
    top: { 200: [song('aliceseed01'), song('aliceseed02')] }, skips: { 200: [songKey(trackReference(skipped))] }, members: [member('200')],
    mixes: { aliceseed01: { loadType: 'playlist', tracks: [skipped, song('keeppick001')] }, aliceseed02: mix('otherpick01') },
  });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'keeppick001');
  lessLikeThis(f.player, f.player.queue.tracks[0]);
  lessLikeThis(f.player, song('anotherpick'), 'youtube:aliceseed01');
  f.player.queue.tracks.length = 0; f.requests.length = 0;
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.equal(f.requests[0], mixUrl('aliceseed02'), 'a seed with two strikes is retired');
});

test('without stats or listeners with history, autoplay follows the room as before', async () => {
  const f = session({ mixes: { roomseed001: mix('roompick001') } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.deepEqual(f.requests, [mixUrl('roomseed001')]);
});

test('the library stores only opt-outs, and older documents read as opted in', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-taste-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'library.json');
  await fs.writeFile(file, JSON.stringify({ version: 2, guilds: {}, favorites: {}, favoriteOverflow: {} }));
  const library = await new MusicLibrary(file, { logger: quiet }).open();
  t.after(() => library.close?.());
  assert.equal(library.tasteInAutoplay('200'), true);
  await library.setTasteInAutoplay('200', false);
  assert.equal(library.tasteInAutoplay('200'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).tasteOptOut, { 200: true });
  await library.setTasteInAutoplay('200', true);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).tasteOptOut, undefined, 'opting back in leaves no trace');
  for (const tasteOptOut of [[], { 200: false }, { nope: true }]) {
    await fs.writeFile(file, JSON.stringify({ version: 2, guilds: {}, favorites: {}, favoriteOverflow: {}, tasteOptOut }));
    await assert.rejects(new MusicLibrary(file, { logger: quiet, statePath: path.join(directory, `state-${Math.random()}.sqlite`) }).open(), /autoplay taste|Discord ID/);
  }
});

test('early skips are read per listener, newest first, from visible channels only', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-skips-'));
  const stats = await new PlayStats(path.join(directory, 'stats.sqlite'), { now: () => NOW, logger: quiet, flushDelayMs: 1 }).open();
  t.after(async () => { stats.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const play = (id, { requesterId = '200', voiceChannelId = '300', skipped = true, playedAt = NOW } = {}) => stats.finish(stats.begin({ guildId: '100', voiceChannelId,
    track: song(id), requesterKind: 'user', requesterId, playedAt }), { playedMs: 5_000, skipped, completed: !skipped });
  play('oldskip0001', { playedAt: NOW - 2000 }); play('newskip0001', { playedAt: NOW - 1000 }); play('kept0000001', { skipped: false });
  play('hidden00001', { voiceChannelId: '301' }); play('otheruser01', { requesterId: '201' });
  assert.deepEqual(stats.earlySkips('100', '200', { visibleChannelIds: ['300'] }), ['newskip0001', 'oldskip0001'].map(id => songKey(trackReference(song(id)))));
  assert.deepEqual(stats.earlySkips('100', 'not-an-id', { visibleChannelIds: ['300'] }), []);
});

test('/radio mytaste changes only the caller’s preference, without voice or DJ access', async () => {
  const { execute, data } = await import('../src/commands/radio.js');
  const { commandMutationPolicy } = await import('../src/utils/requests.js');
  const saved = []; const replies = [];
  const interaction = (enabled) => ({
    user: { id: '200' }, guildId: '100', member: { voice: { channel: null } },
    options: { getSubcommand: () => 'mytaste', getBoolean: () => enabled, getInteger: () => null },
    client: { library: { setTasteInAutoplay: async (id, value) => saved.push([id, value]) }, lavalink: { getPlayer: () => undefined } },
    reply: async message => replies.push(message.content),
  });
  await execute(interaction(false));
  await execute(interaction(true));
  assert.deepEqual(saved, [['200', false], ['200', true]]);
  assert.match(replies[0], /won’t use your taste/);
  assert.match(replies[1], /take turns with your taste/);
  assert.ok(data.toJSON().options.some(option => option.name === 'mytaste'));
  assert.equal(commandMutationPolicy('radio', 'mytaste').playback, false, 'a preference write takes no playback lease');
});

test('a pick whose listener opts out or leaves during the lookup never plays, and costs them no turn', async () => {
  const optedOut = [];
  const f = session({ optedOut, members: [member('200')], top: { 200: [song('aliceseed01')] },
    mixes: { aliceseed01: mix('alicepick01'), roomseed001: mix('roompick001') }, onSearch: id => { if (id === 'aliceseed01') optedOut.push('200'); } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.deepEqual(f.player.queue.tracks.map(item => item.info.identifier), ['roompick001']);
  const g = session({ members: [member('200')], top: { 200: [song('aliceseed01')] }, mixes: { aliceseed01: mix('alicepick01', 'alicepick02') },
    onSearch: () => g.voice.members.clear() });
  g.player.queue.current = song('playing0001');
  await refreshSuggestions(g.player, g.client, { random: () => 0, now: () => NOW });
  assert.deepEqual(suggestions(g.player), [], 'a refresh keeps nothing picked for someone who left');
});

test('prepared picks drop when someone joins who cannot see a channel their taste came from', async () => {
  const f = session({ members: [member('200')], top: { 200: [song('aliceseed01')] }, channels: { 300: channel('300'), 301: channel('301') },
    mixes: { aliceseed01: mix('alicepick01', 'alicepick02', 'alicepick03') } });
  f.player.queue.current = song('playing0001');
  await refreshSuggestions(f.player, f.client, { random: () => 0, now: () => NOW });
  assert.equal(suggestions(f.player).length, 3);
  pruneSuggestions(f.player, f.client);
  assert.equal(suggestions(f.player).length, 3, 'the same audience keeps its picks');
  f.optedOut.push('202');
  f.voice.members.set('202', member('202', { hidden: ['301'] }));
  pruneSuggestions(f.player, f.client);
  assert.deepEqual(suggestions(f.player), [], 'an opted-out newcomer still narrows what taste may be read from');
});

test('promoting a pick made for someone who left is refused', async () => {
  const f = session({ members: [member('200')], top: { 200: [song('aliceseed01')] }, mixes: { aliceseed01: mix('alicepick01') } });
  f.player.queue.current = song('playing0001');
  await refreshSuggestions(f.player, f.client, { random: () => 0, now: () => NOW });
  f.voice.members.clear();
  assert.equal(await promoteSuggestion(f.player, f.client, takeSuggestion(f.player, 0)), false);
  assert.equal(f.player.queue.tracks.length, 0);
});

test('a present listener with nothing to seed from still keeps their early skips out', async () => {
  const skipped = song('skipped0001');
  const f = session({ members: [member('200'), member('201')], top: { 200: [song('aliceseed01')] }, skips: { 201: [songKey(trackReference(skipped))] },
    mixes: { aliceseed01: { loadType: 'playlist', tracks: [skipped, song('keeppick001')] } } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0, now: () => NOW }), true);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'keeppick001');
});
