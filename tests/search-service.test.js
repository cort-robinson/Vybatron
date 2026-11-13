import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMusic, searchFailureMessage } from '../src/utils/search.js';
import { resetSearchCache, searchSongs } from '../src/utils/query.js';
import { track } from './fixtures.js';

test.beforeEach(() => resetSearchCache());

const spotify = 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp';

test('working native Spotify catalog lookup stays authoritative and strips share tokens', async () => {
  const actual = { loadType: 'track', tracks: [track()] };
  const player = { search: async ({ query }) => { assert.equal(query, spotify); return actual; } };
  assert.equal(await searchMusic(player, `${spotify}?si=private`, {}, { embedSearch: () => assert.fail('native source works') }), actual);
});

test('an unavailable or hung Spotify loader falls back within its deadline without accepting the late native result', async () => {
  for (const hung of [false, true]) {
    let complete;
    const player = { search: () => hung ? new Promise(resolve => { complete = resolve; }) : Promise.reject(new Error('source token unavailable')) };
    const mirror = { loadType: 'track', tracks: [track()], spotifyImport: { notice: 'Matched one recording.' } };
    const result = await searchMusic(player, spotify, { id: '200' }, {
      nativeTimeoutMs: 5, spotifyTimeoutMs: 100,
      embedSearch: async (actualPlayer, query, user, options) => {
        assert.equal(actualPlayer, player); assert.equal(query, spotify); assert.equal(user.id, '200');
        assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 100);
        return mirror;
      },
    });
    assert.equal(result, mirror);
    assert.equal(searchFailureMessage(mirror, spotify), 'Matched one recording.');
    if (complete) complete({ loadType: 'track', tracks: [track('lmnopqrstuv')] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.tracks[0].info.identifier, 'abcdefghijk');
  }
});

test('ordinary source requests stay bounded and never attempt a Spotify catalog fallback', async () => {
  await assert.rejects(searchMusic({ search: () => new Promise(() => {}) }, 'song and artist', {}, {
    timeoutMs: 5, embedSearch: () => assert.fail('not a Spotify link'),
  }), /took too long/);
});

test('song searches prefer YouTube Music and fall back to YouTube when it finds nothing or fails', async () => {
  const song = { loadType: 'search', tracks: [track()] };
  const music = [];
  const preferred = { search: async ({ query, source }) => { music.push([query, source]); return song; } };
  assert.equal(await searchMusic(preferred, 'song and artist', {}), song);
  assert.deepEqual(music, [['song and artist', 'ytmsearch']]);
  for (const failure of [() => ({ loadType: 'empty', tracks: [] }), () => ({ loadType: 'error', tracks: [] }), () => { throw new Error('music client offline'); }, () => new Promise(() => {})]) {
    resetSearchCache();
    const sources = [];
    const player = { search: async ({ source }) => { sources.push(source); return source === 'ytmsearch' ? failure() : song; } };
    assert.equal(await searchMusic(player, 'song and artist', {}, { timeoutMs: 50 }), song);
    assert.deepEqual(sources, ['ytmsearch', 'ytsearch']);
  }
});

test('catalog links load directly without a song search', async () => {
  const link = 'https://music.youtube.com/watch?v=abcdefghijk';
  const result = { loadType: 'track', tracks: [track()] };
  const player = { search: async query => { assert.deepEqual(query, { query: link }); return result; } };
  assert.equal(await searchMusic(player, link, {}), result);
});

test('a repeated song search within a minute is answered from memory with fresh copies', async () => {
  let searches = 0;
  // As the audio client builds a track: the requester is also kept in its user data, which is what a play request sends.
  const searcher = { search: async (_query, user) => { searches += 1; return { loadType: 'search', tracks: [{ ...track(), requester: user, userData: { requester: user } }] }; } };
  const first = await searchSongs(searcher, 'Song And Artist', { id: 'u1' });
  const second = await searchSongs(searcher, ' song and artist ', { id: 'u2' });
  const third = await searchSongs(searcher, 'song and artist', { id: 'u3' });
  assert.equal(searches, 1);
  assert.equal(second.tracks[0].info.identifier, first.tracks[0].info.identifier);
  assert.equal(second.tracks[0].encoded, first.tracks[0].encoded);
  assert.equal(first.tracks[0].userData.requester.id, 'u1');
  assert.equal(second.tracks[0].requester.id, 'u2');
  assert.equal(second.tracks[0].userData.requester.id, 'u2');
  assert.equal(third.tracks[0].requester.id, 'u3');
  assert.notEqual(second.tracks[0], first.tracks[0]);
  assert.notEqual(third.tracks[0], second.tracks[0]);
  assert.notEqual(third.tracks[0].info, second.tracks[0].info);
});

test('empty and failed song searches are not remembered', async () => {
  let searches = 0;
  const searcher = { search: async () => { searches += 1; return { loadType: 'empty', tracks: [] }; } };
  await searchSongs(searcher, 'nothing here', {});
  await searchSongs(searcher, 'nothing here', {});
  assert.equal(searches, 4);
});

test('a slow YouTube Music search starts regular YouTube early and still wins if it answers in time', async () => {
  const song = { loadType: 'search', tracks: [track()] };
  const other = { loadType: 'search', tracks: [track('lmnopqrstuv')] };
  let fallbackStartedAt = null; const startedAt = Date.now();
  const slow = { search: ({ source }) => {
    if (source === 'ytsearch') { fallbackStartedAt = Date.now() - startedAt; return Promise.resolve(other); }
    return new Promise(resolve => setTimeout(() => resolve(song), 100));
  } };
  // Music answers inside its share (60% of 200 ms): its result is used.
  assert.equal(await searchSongs(slow, 'slow music', {}, { timeoutMs: 200 }), song);
  assert.ok(fallbackStartedAt !== null && fallbackStartedAt < 100, 'regular YouTube started before Music answered');
  // Music never answers: regular YouTube, already loaded, answers when Music's share ends.
  let fallbacks = 0;
  const hung = { search: ({ source }) => source === 'ytsearch' ? (fallbacks += 1, Promise.resolve(other)) : new Promise(() => {}) };
  assert.equal(await searchSongs(hung, 'hung music', {}, { timeoutMs: 100 }), other);
  assert.equal(fallbacks, 1);
});
