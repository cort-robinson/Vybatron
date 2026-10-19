import test from 'node:test';
import assert from 'node:assert/strict';
import { getTrackChoices, rememberSearchResults, resetAutocompleteCache } from '../src/utils/autocomplete.js';
import { resolveTrackQuery, searchFailureMessage } from '../src/utils/search.js';

test.beforeEach(resetAutocompleteCache);

test('search failures distinguish no matches from source errors', () => {
  assert.match(searchFailureMessage({ loadType: 'empty' }, 'track name'), /No matches/);
  assert.match(searchFailureMessage({ loadType: 'error' }, 'track name'), /Couldn’t load/);
  assert.match(searchFailureMessage({ loadType: 'error' }, '@everyone **bad**'), /@\u200Beveryone/);
  assert.equal(
    searchFailureMessage({ loadType: 'error' }, 'https://www.youtube.com/watch?v=abc'),
    'Couldn’t load that link. Try another result or paste a different YouTube, Spotify, or SoundCloud link.'
  );
});

test('selected autocomplete results reuse the exact track without another search', async () => {
  const selectedTrack = {
    info: {
      title: 'Selected song',
      author: 'Selected artist',
      identifier: 'video-id',
      uri: 'https://www.youtube.com/watch?v=video-id',
    },
    requester: { id: 'u1' },
  };
  const choices = await getTrackChoices({
    options: { getFocused: () => 'selected' },
    user: { id: 'u1' },
    client: {
      lavalink: {
        nodeManager: {
          leastUsedNodes: () => [{ search: async () => ({ tracks: [selectedTrack] }) }],
        },
      },
    },
  });
  const player = { search: async () => { throw new Error('must not search twice'); } };
  const resolved = await resolveTrackQuery(player, choices[0].value, { id: 'u1' });
  assert.equal(resolved.expired, false);
  assert.equal(resolved.result.tracks[0], selectedTrack);
});

test('expired or foreign autocomplete selections fail without searching the token', async () => {
  const player = { search: async () => { throw new Error('must not search token'); } };
  const resolved = await resolveTrackQuery(
    player,
    'autocomplete:u1:000000000000',
    { id: 'u1' }
  );
  assert.equal(resolved.expired, true);
  assert.equal(resolved.result, null);
});

test('a chosen portal search result is added without loading its link again', async () => {
  const found = { encoded: 'QAAA', info: { title: 'Found', author: 'Artist', identifier: 'Zi_XLOBDo_Y', uri: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y', sourceName: 'youtube' },
    pluginInfo: {}, userData: {}, requester: { id: 'u1' } };
  rememberSearchResults([found], 'u1');
  const player = { search: async () => { throw new Error('must not search twice'); } };
  const requester = { id: 'u1', username: 'listener' };
  const first = await resolveTrackQuery(player, found.info.uri, requester);
  const second = await resolveTrackQuery(player, found.info.uri, requester);
  assert.equal(first.result.loadType, 'track');
  assert.equal(first.result.tracks[0].encoded, 'QAAA');
  assert.equal(first.result.tracks[0].requester, requester);
  assert.notEqual(first.result.tracks[0], second.result.tracks[0], 'each addition is its own queue entry');
  assert.notEqual(first.result.tracks[0].info, found.info);
});

test('remembered search results stay with the listener who searched', async () => {
  rememberSearchResults([{ encoded: 'QAAA', info: { uri: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y' } }], 'u1');
  let searched = 0;
  const player = { search: async () => { searched++; return { loadType: 'track', tracks: [] }; } };
  await resolveTrackQuery(player, 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y', { id: 'u2' });
  // A link with more than the chosen song (a playlist) still loads normally.
  await resolveTrackQuery(player, 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y&list=PL0123456789', { id: 'u1' });
  assert.equal(searched, 2);
});
