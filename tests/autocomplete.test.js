import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getTrackChoices,
  resetAutocompleteCache,
  resolveAutocompleteTrack,
} from '../src/utils/autocomplete.js';
import { trackIdentity } from '../src/utils/presentation.js';

function interaction(query, search, userId = 'u1') {
  return {
    options: { getFocused: () => query },
    user: { id: userId },
    client: {
      lavalink: {
        nodeManager: { leastUsedNodes: () => search ? [{ search }] : [] },
        createPlayer: () => { throw new Error('autocomplete must not create a player'); },
      },
    },
  };
}

function tracks(count) {
  return Array.from({ length: count }, (_, index) => ({
    info: {
      title: `Title ${index}`,
      author: `Artist ${index}`,
      uri: `https://example.com/${index}`,
    },
  }));
}

test.beforeEach(resetAutocompleteCache);

test('autocomplete bypasses short queries and URLs', async () => {
  let searches = 0;
  const search = async () => { searches += 1; return { tracks: tracks(2) }; };
  assert.deepEqual(await getTrackChoices(interaction('a', search)), []);
  assert.deepEqual(await getTrackChoices(interaction('😀', search)), []);
  assert.deepEqual(await getTrackChoices(interaction('https://example.com/a', search)), []);
  assert.equal(searches, 0);
});

test('autocomplete limits results and caches normalized queries', async () => {
  let searches = 0;
  const search = async ({ query, source }) => {
    searches += 1;
    assert.equal(source, 'ytmsearch');
    assert.equal(query.toLowerCase(), 'daft punk');
    return { tracks: tracks(12) };
  };
  const first = await getTrackChoices(interaction('Daft Punk', search));
  const second = await getTrackChoices(interaction('daft punk', search));
  assert.equal(first.length, 8);
  assert.deepEqual(second, first);
  assert.equal(searches, 1);
  assert.match(first[0].value, /^autocomplete:u1:[a-f0-9]{12}$/);
  assert.ok(first[0].value.length <= 100);
  assert.equal(resolveAutocompleteTrack(first[0].value, 'u1').track.info.title, 'Title 0');
  assert.equal(resolveAutocompleteTrack(first[0].value, 'u2').track, null);
});

test('autocomplete caches choices per user so requester ownership stays correct', async () => {
  let searches = 0;
  const search = async () => { searches += 1; return { tracks: tracks(1) }; };
  const first = await getTrackChoices(interaction('same query', search, 'u1'));
  const second = await getTrackChoices(interaction('same query', search, 'u2'));
  assert.equal(searches, 2);
  assert.notEqual(first[0].value, second[0].value);
});

test('autocomplete fails closed when nodes or search are unavailable', async () => {
  assert.deepEqual(await getTrackChoices(interaction('query', null)), []);
  assert.deepEqual(await getTrackChoices(interaction('failure', async () => { throw new Error('offline'); })), []);
  assert.deepEqual(
    await getTrackChoices(interaction('timeout', () => new Promise(() => {})), { timeoutMs: 5 }),
    []
  );
});

test('a search that finishes after the autocomplete deadline caches nothing', async () => {
  let finish;
  let searches = 0;
  const late = () => { searches += 1; return new Promise(resolve => { finish = resolve; }); };
  assert.deepEqual(await getTrackChoices(interaction('slow query', late), { timeoutMs: 5 }), []);
  const [lateTrack] = tracks(1);
  finish({ tracks: [lateTrack] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolveAutocompleteTrack(`autocomplete:u1:${trackIdentity(lateTrack)}`, 'u1').track, null);

  const fresh = await getTrackChoices(interaction('slow query', async () => {
    searches += 1;
    return { tracks: [] };
  }));
  assert.deepEqual(fresh, []);
  // Each attempt tries YouTube Music, then regular YouTube.
  assert.equal(searches, 4);
});

test('autocomplete cache evicts its least-recently-used entry at 100 queries', async () => {
  let searches = 0;
  const search = async () => { searches += 1; return { tracks: tracks(1) }; };
  for (let index = 0; index <= 100; index += 1) {
    await getTrackChoices(interaction(`query ${index}`, search));
  }
  await getTrackChoices(interaction('query 0', search));
  assert.equal(searches, 102);
});
