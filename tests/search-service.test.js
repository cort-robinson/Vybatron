import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMusic, searchFailureMessage } from '../src/utils/search.js';
import { track } from './fixtures.js';

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
