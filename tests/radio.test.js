import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoplayActive, chooseSeeds, dismissSuggestion, fillRadioQueue, isAutoplayTrack, lessLikeThis, mixUrl, nearKeys,
  radioState, refreshSuggestions, setRadio, suggestions,
} from '../src/utils/radio.js';
import { skipCurrent } from '../src/utils/operations.js';
import { maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';
import { MusicLibrary, trackReference } from '../src/utils/library.js';
import { track } from './fixtures.js';

const song = (id, { title = `Song ${id}`, author = `Artist ${id}`, duration = 200_000, isStream = false, requester = '200', source = 'youtube' } = {}) => {
  const value = track(id, requester);
  return { ...value, info: { ...value.info, sourceName: source, title, author, duration, isStream, uri: `https://www.youtube.com/watch?v=${id}` } };
};
const mixOf = ids => ({ loadType: 'playlist', tracks: ids.map(id => typeof id === 'string' ? song(id) : id) });

// A fake session: the search stub answers YouTube mixes by seed id, falling back
// to `fallback` for searches. Every request is recorded for assertions.
function fixture({ mixes = {}, fallback = { tracks: [] }, history = [], mode, previous, members } = {}) {
  const current = song('seed0000000');
  const requests = [];
  const player = {
    guildId: '100', voiceChannelId: '300', playing: false, paused: false,
    queue: { current: null, previous: previous || [current], tracks: [], async add(tracks) { this.tracks.push(...tracks); }, async splice() {} },
    async search({ query }) {
      requests.push(query);
      const id = query.match(/list=RD([\w-]{11})/)?.[1];
      if (id) { if (mixes[id] instanceof Error) throw mixes[id]; return mixes[id] || { loadType: 'error', tracks: [] }; }
      if (fallback instanceof Error) throw fallback;
      return typeof fallback === 'function' ? fallback(query) : fallback;
    },
    async skip() { this.queue.current = this.queue.tracks.shift() || null; },
    async stopPlaying(clear, autoplay) { this.stopped = { clear, autoplay }; this.queue.current = null; },
  };
  const channel = { members: new Map(members || [['200', { user: { bot: false }, voice: {} }]]) };
  const library = { settings: () => ({ autoplay: mode || 'off' }), readGuild: () => ({ history }) };
  const client = { user: { id: '999', username: 'Vybertron' }, library, lavalink: { getPlayer: () => player },
    guilds: { cache: new Map([['100', { channels: { cache: new Map([['300', channel]]) } }]]) } };
  return { player, client, current, channel, requests };
}

test('autoplay follows the server setting, with /radio as a per-session override', () => {
  for (const [mode, override, expected] of [['off', null, false], ['on', null, true], ['listening', null, true], ['on', false, false], ['off', true, true]]) {
    const f = fixture({ mode });
    if (override !== null) setRadio(f.player, override);
    assert.equal(autoplayActive(f.client, f.player), expected, `${mode}/${override}`);
  }
});

test('mix picks skip the seed, streams, too-short/too-long tracks, and play as the bot only after the human queue', async () => {
  const f = fixture({ mixes: { seed0000000: mixOf(['seed0000000', song('live0000000', { isStream: true }), song('short000000', { duration: 20_000 }),
    song('long0000000', { duration: 16 * 60_000 }), 'fresh000001']) } });
  assert.equal(await fillRadioQueue(f.player, f.current, f.client), false, 'autoplay is off by default');
  assert.equal(f.requests.length, 0);
  setRadio(f.player, true, f.current);
  f.player.queue.tracks.push(song('human000001'));
  assert.equal(await fillRadioQueue(f.player, f.current, f.client), false, 'a queued human song blocks insertion');
  f.player.queue.tracks.length = 0;
  assert.equal(await fillRadioQueue(f.player, f.current, f.client, { random: () => 0 }), true);
  assert.deepEqual(f.requests, [mixUrl('seed0000000')]);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'fresh000001');
  assert.equal(f.player.queue.tracks[0].requester.id, '999');
  assert.ok(isAutoplayTrack(f.player, f.player.queue.tracks[0]));
  assert.equal(maintenanceStatus(f.client).inFlight, 0);
});

test('suggestions wait outside the queue, so songs people add always play first', async () => {
  const f = fixture({ mode: 'on', mixes: { seed0000000: mixOf(['sugg0000001', 'sugg0000002', 'sugg0000003', 'sugg0000004']) } });
  f.player.queue.current = f.current; f.player.queue.previous = [];
  await refreshSuggestions(f.player, f.client, { random: () => 0 });
  assert.equal(suggestions(f.player).length, 3);
  assert.equal(f.player.queue.tracks.length, 0, 'suggestions never enter player.queue early');
  f.player.queue.tracks.push(song('human000001'));
  await skipCurrent(f.player, f.client);
  assert.equal(f.player.queue.current.info.identifier, 'human000001', 'a human song added later still plays next');
  assert.equal(suggestions(f.player).length, 3);
  await skipCurrent(f.player, f.client);
  assert.equal(f.player.queue.current.requester.id, '999', 'with the human queue empty, a prepared pick plays without a lookup');
  assert.equal(f.requests.length, 1);
});

test('the suggestion buffer is prepared only near the end of the human queue', async () => {
  const f = fixture({ mode: 'on', mixes: { seed0000000: mixOf(['sugg0000001']) } });
  f.player.queue.current = f.current;
  f.player.queue.tracks.push(song('human000001'), song('human000002'), song('human000003'));
  assert.equal(await refreshSuggestions(f.player, f.client), false);
  assert.equal(f.requests.length, 0);
});

test('seeds rotate across recent plays; disliked seeds sink and retire; a chosen seed leads', () => {
  const recent = ['a', 'b', 'c', 'd', 'e'].map(letter => song(letter.repeat(11)));
  const f = fixture({ previous: recent });
  const state = setRadio(f.player, true);
  const firsts = [];
  for (let i = 0; i < 4; i++) { firsts.push(chooseSeeds(f.player, state)[0].info.identifier); state.cursor++; }
  assert.deepEqual(firsts, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'], 'the four most recent plays take turns');
  state.cursor = 0;
  state.penalties.set('youtube:aaaaaaaaaaa', 1);
  assert.equal(chooseSeeds(f.player, state).at(-1).info.identifier, 'aaaaaaaaaaa', 'a disliked seed moves to the back');
  state.penalties.set('youtube:aaaaaaaaaaa', 2);
  assert.ok(!chooseSeeds(f.player, state).some(seed => seed.info.identifier === 'aaaaaaaaaaa'), 'two strikes retire a seed');
  const anchor = song('anchor00000');
  const anchored = setRadio(f.player, true, anchor);
  assert.equal(chooseSeeds(f.player, anchored)[0], anchor);
});

test('drifting seeds produce different mixes over successive picks', async () => {
  const recent = [song('aaaaaaaaaaa'), song('bbbbbbbbbbb')];
  const f = fixture({ mode: 'on', previous: recent, mixes: { aaaaaaaaaaa: mixOf(['fromA000001', 'fromA000002']), bbbbbbbbbbb: mixOf(['fromB000001', 'fromB000002']) } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0 }), true);
  f.player.queue.previous.unshift(f.player.queue.tracks.shift());
  // The new pick is now the most recent play, so the rotation reaches the older seed.
  f.player.queue.previous.splice(0, 1);
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0 }), true);
  assert.deepEqual(f.requests, [mixUrl('aaaaaaaaaaa'), mixUrl('bbbbbbbbbbb')]);
});

test('near-duplicate recordings and recently played server music are filtered', async () => {
  const official = song('official001', { author: 'Bee Gees', title: 'Stayin\' Alive (Official Music Video)' });
  assert.ok(nearKeys(song('topic000001', { author: 'Bee Gees - Topic', title: 'Stayin\' Alive' })).some(key => nearKeys(official).includes(key)));
  assert.ok(nearKeys(song('channel0001', { author: 'beegees', title: 'Bee Gees - Stayin\' Alive [Lyrics]' })).some(key => nearKeys(official).includes(key)));
  assert.ok(!nearKeys(song('other000001', { author: 'Bee Gees', title: 'Night Fever' })).some(key => nearKeys(official).includes(key)));
  // A multi-artist Topic credit and the lead artist's own upload are one song.
  assert.ok(nearKeys(song('topic000002', { author: 'The Kid LAROI, Justin Bieber - Topic', title: 'Stay' })).some(key => nearKeys(song('solo0000001', { author: 'The Kid LAROI', title: 'Stay (Official Audio)' })).includes(key)));

  const playedEarlier = song('server00001', { author: 'Kool & The Gang', title: 'Celebration' });
  const history = [{ playedAt: Date.now() - 60_000, track: trackReference(playedEarlier) }];
  const f = fixture({ mode: 'on', history, previous: [official], mixes: { official001: mixOf([
    official, song('topic000001', { author: 'Bee Gees - Topic', title: 'Stayin\' Alive' }),
    song('channel0002', { author: 'KoolandthegangShow', title: 'Kool & The Gang - Celebration (Official Video)' }),
    song('server00001', { author: 'Kool & The Gang', title: 'Celebration' }), song('newsong0001', { author: 'Blondie', title: 'Heart Of Glass' })]) } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0 }), true);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'newsong0001');
});

test('a failed mix falls back to artist search, and non-YouTube seeds resolve to YouTube first', async () => {
  const f = fixture({ mode: 'on', mixes: { seed0000000: new Error('mix unavailable') }, fallback: { loadType: 'search', tracks: [song('artist00001')] } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0 }), true);
  assert.deepEqual(f.requests, [mixUrl('seed0000000'), 'Artist seed0000000 music']);
  assert.equal(f.player.queue.tracks[0].info.identifier, 'artist00001');

  const cloud = song('cloud', { source: 'soundcloud', author: 'Producer', title: 'Night Drive' });
  const g = fixture({ mode: 'on', previous: [cloud], mixes: { resolved001: mixOf(['resolved001', 'related0001']) },
    fallback: query => ({ loadType: 'search', tracks: query === 'Producer Night Drive' ? [song('resolved001')] : [] }) });
  assert.equal(await fillRadioQueue(g.player, null, g.client, { random: () => 0 }), true);
  assert.deepEqual(g.requests, ['Producer Night Drive', mixUrl('resolved001')]);
  assert.equal(g.player.queue.tracks[0].info.identifier, 'related0001');
});

test('"listening" mode waits for someone who can hear it; empty rooms never trigger lookups', async () => {
  const f = fixture({ mode: 'listening', mixes: { seed0000000: mixOf(['fresh000001']) }, members: [['200', { user: { bot: false }, voice: { selfDeaf: true } }]] });
  assert.equal(await fillRadioQueue(f.player, null, f.client), false);
  setRadio(f.player, true);
  assert.equal(await fillRadioQueue(f.player, null, f.client), true, '/radio on keeps playing for a deafened room');
  const g = fixture({ mode: 'on', members: [] });
  assert.equal(await fillRadioQueue(g.player, null, g.client), false);
  assert.equal(g.requests.length, 0);
});

test('turning autoplay off, destroying a session, or queuing a song during discovery prevents late insertion', async () => {
  for (const change of ['off', 'destroy', 'enqueue']) {
    let complete; const f = fixture();
    f.player.search = () => new Promise(resolve => { complete = resolve; });
    setRadio(f.player, true, f.current);
    const pending = fillRadioQueue(f.player, f.current, f.client);
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'off') setRadio(f.player, false);
    if (change === 'destroy') f.client.lavalink.getPlayer = () => null;
    if (change === 'enqueue') f.player.queue.tracks.push(song('user0000000'));
    complete(mixOf(['lmnopqrstuv']));
    assert.equal(await pending, false);
    assert.equal(f.player.queue.tracks.length, change === 'enqueue' ? 1 : 0);
  }
});

test('maintenance, concurrent queue ends, and source outages cannot create lookup storms', async () => {
  const f = fixture({ fallback: new Error('source failed') });
  let searches = 0; const search = f.player.search;
  f.player.search = (...args) => { searches++; return search(...args); };
  setRadio(f.player, true, f.current);
  setMaintenance(f.client, true); await fillRadioQueue(f.player, f.current, f.client); assert.equal(searches, 0);
  setMaintenance(f.client, false);
  await Promise.all([fillRadioQueue(f.player, f.current, f.client), fillRadioQueue(f.player, f.current, f.client)]);
  assert.equal(searches, 2, 'one mix attempt and one artist fallback, not two of each');
  await fillRadioQueue(f.player, f.current, f.client); await fillRadioQueue(f.player, f.current, f.client);
  assert.equal(radioState(f.player).suspended, true);
  assert.equal(autoplayActive(f.client, f.player), false, 'three misses pause autoplay for the session');
  const before = searches;
  await fillRadioQueue(f.player, f.current, f.client); await refreshSuggestions(f.player, f.client);
  assert.equal(searches, before);
  setRadio(f.player, true);
  assert.equal(autoplayActive(f.client, f.player), true, '/radio on re-arms it');
  assert.equal(maintenanceStatus(f.client).inFlight, 0);
});

test('skipping or disliking a pick excludes it, lowers its seed, and drops picks from that seed', async () => {
  const f = fixture({ mode: 'on', mixes: { seed0000000: mixOf(['pick0000001', 'pick0000002', 'pick0000003', 'pick0000004']) } });
  assert.equal(await fillRadioQueue(f.player, null, f.client, { random: () => 0 }), true);
  await f.player.skip();
  const pick = f.player.queue.current;
  await refreshSuggestions(f.player, f.client, { random: () => 0 });
  assert.equal(suggestions(f.player).length, 3);
  assert.ok(isAutoplayTrack(f.player, pick));
  await skipCurrent(f.player, f.client);
  assert.equal(suggestions(f.player).length, 0, 'picks from the disliked seed are dropped');
  assert.deepEqual(f.player.stopped, { clear: true, autoplay: true }, 'autoplay looks up a fresh pick instead of ending the session');
  // The skipped song is never suggested again this session.
  const g = fixture({ mode: 'on', mixes: { seed0000000: mixOf([pick, 'other000001']) } });
  lessLikeThis(g.player, pick, 'youtube:unrelated00');
  assert.equal(await fillRadioQueue(g.player, null, g.client, { random: () => 0 }), true);
  assert.equal(g.player.queue.tracks[0].info.identifier, 'other000001');
});

test('removing a suggestion excludes only that song', async () => {
  const f = fixture({ mode: 'on', mixes: { seed0000000: mixOf(['pick0000001', 'pick0000002', 'pick0000003', 'pick0000004']) } });
  f.player.queue.current = f.current; f.player.queue.previous = [];
  await refreshSuggestions(f.player, f.client, { random: () => 0 });
  const [first] = suggestions(f.player);
  assert.equal(dismissSuggestion(f.player, 0, { expected: track => track.info.identifier === 'wrong' }), null, 'a stale selection changes nothing');
  assert.equal(dismissSuggestion(f.player, 0).info.identifier, first.info.identifier);
  await refreshSuggestions(f.player, f.client, { random: () => 0 });
  assert.equal(suggestions(f.player).length, 3);
  assert.ok(!suggestions(f.player).some(track => track.info.identifier === first.info.identifier));
});

test('the autoplay setting validates and older saved documents migrate to off', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-autoplay-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'library.json');
  const legacySettings = { volume: 80, fairQueue: true, djRoleId: null, musicTextChannelId: null };
  await fs.writeFile(filePath, JSON.stringify({ version: 2, favorites: {}, favoriteOverflow: {}, guilds: { 100: { settings: legacySettings, mixes: {}, session: null, history: [], activity: [] } } }));
  const library = await new MusicLibrary(filePath).open();
  assert.deepEqual(library.settings('100'), { ...legacySettings, autoplay: 'off' });
  assert.equal(library.settings('101').autoplay, 'off');
  await library.updateGuild('100', guild => { guild.settings.autoplay = 'listening'; });
  assert.equal((await new MusicLibrary(filePath).open()).settings('100').autoplay, 'listening');
  await assert.rejects(library.updateGuild('100', guild => { guild.settings.autoplay = 'always'; }), /Invalid saved server settings/);
  assert.equal(library.settings('100').autoplay, 'listening');

  const v1 = path.join(directory, 'v1.json');
  await fs.writeFile(v1, JSON.stringify({ version: 1, guilds: { 100: { settings: { volume: 50, fairQueue: false, djRoleId: null }, favorites: {}, mixes: {}, session: null } } }));
  assert.equal((await new MusicLibrary(v1).open()).settings('100').autoplay, 'off');
});
