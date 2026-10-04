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
