import test from 'node:test';
import assert from 'node:assert/strict';
import { createTorbox, matchingFile, songTerms } from '../src/utils/torbox.js';
import { createTorznab, parseTorznab } from '../src/utils/torznab.js';

const HASH = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ALBUM = 'c'.repeat(40);
const KEY = 'test-key-0000000000';
const song = { info: { title: 'Rick Astley - Never Gonna Give You Up (Official Music Video)', author: 'RickAstleyVEVO', length: 213_000 } };

function api(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', auth: options.headers?.Authorization });
    const route = routes.find(([pattern]) => pattern.test(String(url)));
    const [status, body] = route ? route[1](String(url), options) : [404, { success: false, error: 'NOT_FOUND' }];
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, calls };
}

function indexer(byQuery) {
  const queries = [];
  return { queries, search: async (query) => { queries.push(query); return byQuery[query] || []; } };
}

const result = (hash) => ({ hash, magnet: `magnet:?xt=urn:btih:${hash}` });

test('song terms split an "Artist - Song" video title and drop release labels', () => {
  assert.deepEqual(songTerms(song), { query: 'Rick Astley Never Gonna Give You Up', song: 'never gonna give you up', artist: 'rick astley' });
  assert.equal(songTerms({ info: { title: 'Bohemian Rhapsody', author: 'Queen - Topic' } }).query, 'Queen Bohemian Rhapsody');
  assert.equal(songTerms({ info: { title: '(Official Video)', author: 'X' } }), null);
});

test('a matching file holds the whole title and the artist; a bare title beats a longer name', () => {
  const terms = songTerms({ info: { title: 'Dreams', author: 'Fleetwood Mac - Topic' } });
  const files = [
    { name: 'Fleetwood Mac - Rumours/Sweet Dreams.flac' },
    { name: 'Fleetwood Mac - Rumours/02. Dreams (Live).flac' },
    { name: 'Fleetwood Mac - Rumours/02. Dreams.flac' },
    { name: 'Fleetwood Mac - Rumours/Dreams.mkv' },
    { name: 'Fleetwood Mac - Rumours/Dreamscape.mp3' },
  ];
  assert.equal(matchingFile(files, terms).name, 'Fleetwood Mac - Rumours/02. Dreams.flac');
  assert.equal(matchingFile([{ name: 'Discography/2019 Lover/02. Dreams.flac' }], terms, 'Taylor Swift - Discography'), null);
  assert.equal(matchingFile([{ name: 'Lover/02. Dreams.flac' }], terms, 'Fleetwood Mac - Discography').name, 'Lover/02. Dreams.flac');
});

test('torznab results give hashes and magnets in order, building a magnet from a bare hash', () => {
  const xml = `<rss><channel>
    <item><title>Rick Astley - Whenever You Need Somebody</title><link>http://prowlarr/download?apikey=x&amp;id=1</link>
      <torznab:attr name="infohash" value="${HASH.toUpperCase()}"/></item>
    <item><title>No hash</title><link>http://prowlarr/download?id=2</link></item>
    <item><title>Magnet</title><torznab:attr name="magneturl" value="magnet:?xt=urn:btih:${OTHER}&amp;dn=x"/></item>
  </channel></rss>`;
  assert.deepEqual(parseTorznab(xml), [result(HASH), { hash: OTHER, magnet: `magnet:?xt=urn:btih:${OTHER}&dn=x` }]);
});

test('torznab searches the Audio category with its own key', async () => {
  let requested;
  const torznab = createTorznab({ url: 'http://prowlarr:9696/1/api', apiKey: 'indexer-key',
    fetch: async (url) => { requested = new URL(url); return { ok: true, text: async () => '<rss></rss>' }; } });
  assert.deepEqual(await torznab.search('Rick Astley'), []);
  assert.deepEqual(Object.fromEntries(requested.searchParams), { t: 'search', q: 'Rick Astley', cat: '3000', apikey: 'indexer-key' });
  const failing = createTorznab({ url: 'http://prowlarr:9696/1/api', apiKey: 'indexer-key', fetch: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing.search('x'), (error) => !error.message.includes('indexer-key'));
});

test('an uncached song result falls back to the artist search and streams the album file', async () => {
  const search = indexer({ 'Rick Astley Never Gonna Give You Up': [result(OTHER)], 'rick astley': [result(OTHER), result(ALBUM)] });
  const { fetch, calls } = api([
    [/checkcached\?hash=bbbb/, () => [200, { success: true, data: [] }]],
    [/checkcached\?hash=cccc/, () => [200, { success: true, data: [{ hash: ALBUM, name: 'Rick Astley - Whenever You Need Somebody',
      files: [{ name: 'Whenever/01 Never Gonna Give You Up.flac' }] }] }]],
    [/createtorrent/, () => [200, { success: true, data: { torrent_id: 42, hash: ALBUM } }]],
    [/mylist\?bypass_cache=true&id=42/, () => [200, { success: true, data: { id: 42, hash: ALBUM,
      files: [{ id: 0, name: 'Whenever/cover.jpg' }, { id: 3, name: 'Whenever/01 Never Gonna Give You Up.flac' }] } }]],
    [/requestdl/, (url) => {
      const params = new URL(url).searchParams;
      assert.deepEqual([params.get('torrent_id'), params.get('file_id'), params.get('redirect')], ['42', '3', 'false']);
      return [200, { success: true, data: 'https://cdn.example/stream.flac' }];
    }],
  ]);
  const stream = await createTorbox({ apiKey: KEY, search: search.search, fetch }).findStream(song);
  assert.deepEqual(stream, { url: 'https://cdn.example/stream.flac', name: '01 Never Gonna Give You Up.flac' });
  assert.deepEqual(search.queries, ['Rick Astley Never Gonna Give You Up', 'rick astley']);
  // The artist search checks only hashes the song search hadn't already.
  assert.ok(calls.some(call => call.url.includes(`checkcached?hash=${ALBUM}&`)));
  assert.ok(calls.every(call => call.auth === `Bearer ${KEY}`));
});

test('a torrent already in the account is reused when adding it is refused', async () => {
  const search = indexer({ 'Rick Astley Never Gonna Give You Up': [result(HASH)] });
  const { fetch } = api([
    [/checkcached/, () => [200, { success: true, data: [{ hash: HASH, name: 'Rick Astley', files: [{ name: 'Never Gonna Give You Up.mp3' }] }] }]],
    [/createtorrent/, () => [400, { success: false, error: 'DUPLICATE_ITEM' }]],
    [/mylist\?bypass_cache=true$/, () => [200, { success: true, data: [{ id: 7, hash: HASH, files: [{ id: 1, name: 'Never Gonna Give You Up.mp3' }] }] }]],
    [/requestdl/, () => [200, { success: true, data: 'https://cdn.example/owned.mp3' }]],
  ]);
  assert.equal((await createTorbox({ apiKey: KEY, search: search.search, fetch }).findStream(song)).url, 'https://cdn.example/owned.mp3');
});

test('no matching cached file adds nothing to the account', async () => {
  const search = indexer({ 'Rick Astley Never Gonna Give You Up': [result(HASH)] });
  const { fetch, calls } = api([
    [/checkcached/, () => [200, { success: true, data: [{ hash: HASH, name: 'Rick Astley', files: [{ name: 'Whenever You Need Somebody.mp3' }] }] }]],
  ]);
  assert.equal(await createTorbox({ apiKey: KEY, search: search.search, fetch }).findStream(song), null);
  assert.ok(!calls.some(call => /createtorrent|requestdl/.test(call.url)));
});

test('live streams are never looked up, and API errors never echo the key', async () => {
  const search = indexer({ 'Rick Astley Never Gonna Give You Up': [result(HASH)] });
  const { fetch, calls } = api([[/checkcached/, () => [401, { success: false, error: 'BAD_TOKEN' }]]]);
  const torbox = createTorbox({ apiKey: 'secret-key-00000000', search: search.search, fetch });
  assert.equal(await torbox.findStream({ info: { ...song.info, isStream: true } }), null);
  assert.equal(calls.length + search.queries.length, 0);
  await assert.rejects(torbox.findStream(song), (error) => error.message.includes('BAD_TOKEN') && !error.message.includes('secret-key'));
});
