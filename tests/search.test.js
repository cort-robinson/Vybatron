import test from 'node:test';
import assert from 'node:assert/strict';
import { getTrackChoices, resetAutocompleteCache } from '../src/utils/autocomplete.js';
import { resolveTrackQuery, searchFailureMessage } from '../src/utils/search.js';

test.beforeEach(resetAutocompleteCache);

test('search failures distinguish no matches from source errors', () => {
  assert.match(searchFailureMessage({ loadType: 'empty' }, 'track name'), /No matches/);
  assert.match(searchFailureMessage({ loadType: 'error' }, 'track name'), /Couldn’t load/);
  assert.match(searchFailureMessage({ loadType: 'error' }, '@everyone **bad**'), /@​everyone/);
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
