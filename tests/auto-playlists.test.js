import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayStats } from '../src/utils/play-stats.js';
import { AUTO_PLAYLIST_LIMIT, buildArtistMix, buildYourMix, mixSeed, personalPlaylist, personalPlaylists, weekOf } from '../src/utils/auto-playlists.js';
import { artistKeyOf, songKey } from '../src/utils/song-identity.js';

const DAY = 24 * 60 * 60_000;
// Thursday 2026-10-08 12:00 UTC.
const NOW = Date.UTC(2026, 9, 8, 12);
const quiet = { error() {}, log() {} };

function ref(id, { title = `Song ${id}`, author = 'Artist' } = {}) {
  return { uri: `https://www.youtube.com/watch?v=${id.padEnd(11, 'x').slice(0, 11)}`, sourceName: 'youtube', identifier: id, title, author, duration: 200_000, isStream: false };
}
const refs = (prefix, count, options) => Array.from({ length: count }, (_, index) => ref(`${prefix}${index}`, options));
const titles = list => list.map(item => item.title);

async function store(t) {
  const clock = { now: NOW };
  const stats = await new PlayStats(':memory:', { now: () => clock.now, logger: quiet, flushDelayMs: 1 }).open();
  t.after(() => stats.close());
  const request = (reference, { requesterId = '200', voiceChannelId = '300', playedAt = NOW - DAY, skipped = false } = {}) => {
    const handle = stats.begin({ guildId: '100', voiceChannelId, track: { info: reference }, requesterKind: 'user', requesterId, playedAt });
    stats.finish(handle, { playedMs: skipped ? 5_000 : 200_000, completed: !skipped, skipped });
  };
  return { stats, clock, request };
}

test('weeks turn over at Monday 00:00 UTC', () => {
  const week = weekOf(NOW);
  assert.equal(new Date(week.startsAt).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(new Date(week.endsAt).toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(weekOf(week.endsAt - 1).index, week.index);
  assert.equal(weekOf(week.endsAt).index, week.index + 1);
});

test('your mix blends top requests and favorites, stays stable all week and changes the next', () => {
  const topTracks = refs('top', 25);
  const favorites = refs('fav', 60);
  const build = now => buildYourMix({ topTracks, favorites, seed: mixSeed('200', '100', now) });
  const monday = build(weekOf(NOW).startsAt);
  assert.equal(monday.length, AUTO_PLAYLIST_LIMIT);
  assert.equal(new Set(monday.map(songKey)).size, AUTO_PLAYLIST_LIMIT, 'each song once');
  assert.equal(monday.filter(item => item.identifier.startsWith('top')).length, 15, 'about 60% from top requests');
  assert.equal(monday.filter(item => item.identifier.startsWith('fav')).length, 10);
  assert.deepEqual(build(NOW), monday, 'same picks and order later the same week');
  assert.deepEqual(build(weekOf(NOW).endsAt - 1), monday);
  assert.notDeepEqual(build(weekOf(NOW).endsAt), monday, 'a new week brings a new mix');
  assert.notDeepEqual(buildYourMix({ topTracks, favorites, seed: mixSeed('201', '100', NOW) }), monday, 'each listener has their own mix');

  // Picks depend on each song, not its list position: a new request this week
  // does not reshuffle everything already chosen.
  const shifted = buildYourMix({ topTracks: [ref('newcomer'), ...topTracks.slice(0, 24)], favorites, seed: mixSeed('200', '100', NOW) });
  const kept = monday.filter(item => shifted.some(other => other.identifier === item.identifier));
  assert.ok(kept.length >= 20, `most picks survive one new request (${kept.length})`);
});

test('your mix favors the most requested songs but still varies them', () => {
  const topTracks = refs('top', 25);
  const weeks = Array.from({ length: 20 }, (_, week) => buildYourMix({ topTracks, favorites: [], seed: `200:100:${week}` }).slice(0, 25));
  // With no favorites, every top request fits; light randomization only changes order.
  assert.ok(weeks.every(list => list.length === 25));
  const top = buildYourMix({ topTracks, favorites: refs('fav', 40), seed: 'a' }).filter(item => item.identifier.startsWith('top'));
  const ranks = top.map(item => Number(item.identifier.slice(3)));
  assert.ok(ranks.filter(rank => rank < 10).length >= 8, 'the top ten requests are nearly always in');
  assert.ok(new Set(weeks.map(list => list[0].identifier)).size > 3, 'order changes from week to week');
});

test('your mix fills from whichever source has songs, and reserves room for recommendations', () => {
  assert.deepEqual(buildYourMix({ topTracks: [], favorites: [], seed: 's' }), []);
  assert.equal(buildYourMix({ topTracks: [], favorites: refs('fav', 40), seed: 's' }).length, 25, 'favorites alone fill the mix');
  assert.equal(buildYourMix({ topTracks: refs('top', 3), favorites: refs('fav', 2), seed: 's' }).length, 5, 'small libraries give a short mix');
  const duplicate = buildYourMix({ topTracks: [ref('same1', { title: 'Tune', author: 'Band - Topic' })], favorites: [ref('same2', { title: 'Band - Tune (Official Video)', author: 'BandVEVO' })], seed: 's' });
  assert.equal(duplicate.length, 1, 'the same song from two uploads appears once');

  const mixed = buildYourMix({ topTracks: refs('top', 25), favorites: refs('fav', 40), recommendations: refs('rec', 10), seed: 's' });
  assert.equal(mixed.filter(item => item.identifier.startsWith('rec')).length, 5, 'recommendations take at most a fifth');
  assert.equal(mixed.length, 25);
});

test('artist mixes alternate the listener’s favorites with the server’s plays by that artist', () => {
  const favorites = [ref('mine1', { author: 'Nova - Topic' }), ref('other1', { author: 'Someone Else' }), ref('mine2', { author: 'Nova feat. Guest' })];
  const serverSongs = [ref('srv1', { author: 'Nova' }), ref('mine1', { author: 'Nova - Topic' }), ref('srv2', { author: 'Nova' })];
  const mix = buildArtistMix({ artistKey: artistKeyOf('Nova'), favorites, serverSongs });
  assert.deepEqual(mix.map(item => item.identifier), ['mine1', 'srv1', 'mine2', 'srv2']);
  assert.deepEqual(buildArtistMix({ artistKey: artistKeyOf('Nobody'), favorites, serverSongs: [] }), []);
  assert.equal(artistKeyOf('Nova - Topic'), artistKeyOf('Nova'));
});

test('personal playlists come from the listener’s own requests in visible channels', async t => {
  const { stats, request } = await store(t);
  const nova = refs('nova', 4, { author: 'Nova' });
  const echo = refs('echo', 2, { author: 'Echo' });
  const pulse = refs('pulse', 1, { author: 'Pulse' });
  for (const reference of nova) { request(reference); request(reference); }
  for (const reference of echo) request(reference);
  request(pulse[0]);
  request(ref('oldsong', { author: 'Nova' }), { playedAt: NOW - 45 * DAY });
  request(ref('skipped', { author: 'Nova' }), { skipped: true });
  request(ref('hidden', { author: 'Hidden' }), { voiceChannelId: '301' });
  request(ref('hidden', { author: 'Hidden' }), { voiceChannelId: '301' });
  // Someone else's plays feed artist mixes anonymously, never top tracks.
  request(ref('friend', { author: 'Nova' }), { requesterId: '201' });
  request(ref('friend', { author: 'Nova' }), { requesterId: '201' });
  request(ref('others', { author: 'Other' }), { requesterId: '201' });
  const favorites = [ref('favnova', { author: 'Nova' }), ref('stale', { author: 'Echo' }), ...refs('more', 3, { author: 'Calm' })];
  const scope = { guildId: '100', userId: '200', favorites, visibleChannelIds: ['300'], since: NOW - 30 * DAY, now: NOW };

  const lists = personalPlaylists(stats, scope);
  assert.deepEqual(lists.map(list => list.id), ['your-mix', 'top-tracks', 'rediscover', 'artist-1', 'artist-2', 'artist-3']);
  const byId = Object.fromEntries(lists.map(list => [list.id, list]));
  assert.deepEqual(titles(byId['top-tracks'].tracks).slice(0, 4), titles(nova));
  assert.ok(!titles(byId['top-tracks'].tracks).includes('Song oldsong'), 'outside the 30-day window');
  assert.ok(!titles(byId['top-tracks'].tracks).some(title => /hidden|friend|skipped|others/.test(title)));
  assert.equal(byId['your-mix'].refreshesAt, weekOf(NOW).endsAt);
  assert.ok(titles(byId['your-mix'].tracks).includes('Song oldsong'), 'the mix looks back 90 days');
  assert.ok(!titles(byId['your-mix'].tracks).some(title => /hidden|friend|others/.test(title)));
  assert.deepEqual(titles(byId.rediscover.tracks), titles(favorites), 'none of these favorites were requested in 30 days');

  assert.deepEqual([byId['artist-1'].artist, byId['artist-2'].artist, byId['artist-3'].artist], ['Nova', 'Echo', 'Pulse']);
  assert.equal(byId['artist-1'].title, 'Nova mix');
  const novaMix = titles(byId['artist-1'].tracks);
  assert.equal(novaMix[0], 'Song favnova', 'your favorites lead');
  assert.ok(novaMix.includes('Song friend'), 'server plays by the artist are included');
  assert.ok(!novaMix.some(title => /skipped|hidden|others/.test(title)));

  assert.deepEqual(titles(personalPlaylist(stats, 'artist', { ...scope, artist: 'nova' }).tracks), novaMix, 'artist names match loosely');
  assert.equal(personalPlaylist(stats, 'artist', { ...scope }).title, 'Nova mix', 'defaults to the top artist');
  assert.equal(personalPlaylist(stats, 'artist', { ...scope, artist: 'Nobody At All' }), null);
  assert.equal(personalPlaylist(stats, 'top', scope).tracks.length, byId['top-tracks'].tracks.length);
});

test('personal playlists are empty for a new listener and follow cleared stats immediately', async t => {
  const { stats, request } = await store(t);
  const scope = { guildId: '100', userId: '200', favorites: [], visibleChannelIds: ['300'], since: NOW - 30 * DAY, now: NOW };
  const empty = personalPlaylists(stats, scope);
  assert.deepEqual(empty.map(list => [list.id, list.tracks.length]), [['your-mix', 0], ['top-tracks', 0], ['rediscover', 0]]);

  request(ref('mine1', { author: 'Nova' }));
  assert.equal(personalPlaylists(stats, scope).find(list => list.id === 'top-tracks').tracks.length, 1);
  stats.clearRequests('200');
  const cleared = personalPlaylists(stats, scope);
  assert.deepEqual(cleared.map(list => [list.id, list.tracks.length]), [['your-mix', 0], ['top-tracks', 0], ['rediscover', 0]],
    'computed on read, so nothing personal survives a clear');
});
