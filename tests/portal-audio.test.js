import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { portalFixture } from './portal-fixtures.js';
import { createAudioCache, sendAudio } from '../src/portal/audio.js';

const song = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

// Lavalink at the network boundary: our audio plugin, plus the YouTube plugin's
// stream route (no real length, no Range support), which serves only some videos.
async function fakeLavalink(t, { hold } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://lavalink.invalid');
    requests.push({ path: url.pathname, itag: url.searchParams.get('itag'), auth: request.headers.authorization });
    const id = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/vybatron/audio/') && ['abcdefghijk', 'slowsong123'].includes(id)) {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      response.write(song.subarray(0, 500));
      if (id === 'slowsong123') await hold;
      response.end(song.subarray(500)); return;
    }
    if (id === 'webmonly123' && url.searchParams.get('itag') === '251') { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(song); return; }
    response.writeHead(url.pathname.startsWith('/vybatron/') ? 404 : 400, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, requests };
}
async function audioFixture(t, options) {
  const f = await portalFixture(t);
  const lavalink = await fakeLavalink(t, options);
  f.node.options = { host: '127.0.0.1', port: lavalink.port, authorization: 'lavalink-secret', secure: false };
  const get = (id, { actor = '200', headers = {} } = {}) => fetch(`${f.origin}/v1/guilds/100/audio/${id}?actorId=${actor}`, { headers: { Authorization: `Bearer ${f.token}`, ...headers } });
  return { f, lavalink, get };
}

test('portal audio decodes through the Lavalink plugin and serves byte ranges', async t => {
  const { lavalink, get } = await audioFixture(t);
  const full = await get('abcdefghijk');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/ogg'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), song);
  assert.deepEqual(lavalink.requests, [{ path: '/vybatron/audio/abcdefghijk', itag: null, auth: 'lavalink-secret' }]);

  const part = await get('abcdefghijk', { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), song.subarray(10, 20));
  const tail = await get('abcdefghijk', { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.headers.get('content-range'), 'bytes 995-999/1000'); await tail.arrayBuffer();
  const whole = await get('abcdefghijk');
  assert.equal(whole.headers.get('content-length'), '1000'); await whole.arrayBuffer();
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=2000-' } })).status, 416);
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=a-b' } })).status, 416);
  // Every request after the first is answered from the one download.
  assert.equal(lavalink.requests.length, 1);
});

test('a song still arriving streams from its start while ranges wait for the whole song', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const { get } = await audioFixture(t, { hold });
  const first = await get('slowsong123');
  assert.equal(first.status, 200); assert.equal(first.headers.get('content-length'), null);
  const reader = first.body.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Buffer.from(value), song.subarray(0, 500));
  const ranged = get('slowsong123', { headers: { Range: 'bytes=900-909' } });
  release();
  const rest = []; for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest.push(chunk.value);
  assert.deepEqual(Buffer.concat([value, ...rest]), song);
  const answer = await ranged;
  assert.equal(answer.status, 206); assert.equal(answer.headers.get('content-range'), 'bytes 900-909/1000');
  assert.deepEqual(Buffer.from(await answer.arrayBuffer()), song.subarray(900, 910));
});

test('portal audio falls back to the YouTube stream route and explains unavailable songs', async t => {
  const { lavalink, get } = await audioFixture(t);
  const webm = await get('webmonly123');
  assert.equal(webm.status, 200); assert.equal(webm.headers.get('content-type'), 'audio/webm'); await webm.arrayBuffer();
  assert.deepEqual(lavalink.requests.map(item => item.itag ?? 'plugin'), ['plugin', '140', '251']);
  const missing = await get('missing1234');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'audio_unavailable');
  // A failed lookup is not cached as a success; it is tried again next time.
  await (await get('missing1234')).arrayBuffer();
  assert.equal(lavalink.requests.filter(item => item.path.endsWith('missing1234')).length, 6);
});

test('portal audio needs server membership and a valid video id', async t => {
  const { lavalink, get, f } = await audioFixture(t);
  assert.equal((await get('abcdefghijk', { actor: '901' })).status, 404);
  assert.equal((await get('short')).status, 404);
  assert.equal((await fetch(`${f.origin}/v1/guilds/100/audio/abcdefghijk?actorId=200`)).status, 401);
  assert.equal(lavalink.requests.length, 0);
});

test('the audio cache evicts least recently used songs and bounds concurrent downloads', async () => {
  const sizes = { aaaaaaaaaaa: 40, bbbbbbbbbbb: 40, ccccccccccc: 40 };
  const fetches = [];
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 },
    fetchImpl: async url => { const id = new URL(url).pathname.split('/').pop(); fetches.push(id); return new Response(Buffer.alloc(sizes[id] ?? 60)); } });
  const load = async id => { const entry = await cache.get(id); await entry.done; return entry; };
  await load('aaaaaaaaaaa'); await load('bbbbbbbbbbb');
  await load('aaaaaaaaaaa');
  await load('ccccccccccc');
  assert.equal(cache.size, 80);
  await load('aaaaaaaaaaa');
  assert.deepEqual(fetches, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await assert.rejects(load('ddddddddddd'), error => error.status === 413);
  const gated = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 1, timeoutMs: 1000 }, fetchImpl: () => new Promise(() => {}) });
  void gated.get('aaaaaaaaaaa').catch(() => {});
  assert.throws(() => gated.get('bbbbbbbbbbb'), error => error.status === 429);
});

test('sendAudio answers whole and partial requests the way media elements expect', async () => {
  const sent = [];
  const response = { writeHead: (status, headers) => sent.push({ status, headers }), end: body => sent.push(body?.length ?? 0) };
  await sendAudio({ headers: { range: 'bytes=0-1' } }, response, { complete: true, data: song, type: 'audio/ogg', done: Promise.resolve() });
  assert.equal(sent[0].status, 206); assert.equal(sent[0].headers['Content-Length'], 2); assert.equal(sent[1], 2);
});

test('a background fetch shares cached songs but never takes a download slot from playback', async () => {
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 }, fetchImpl: () => new Promise(() => {}) });
  void cache.get('aaaaaaaaaaa').catch(() => {});
  assert.throws(() => cache.get('bbbbbbbbbbb', { background: true }), error => error.status === 429);
  // A listener's next song still gets the second slot.
  void cache.get('ccccccccccc').catch(() => {});
  assert.throws(() => cache.get('ddddddddddd'), error => error.status === 429);
  const idle = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 }, fetchImpl: async () => new Response(Buffer.alloc(10)) });
  const entry = await idle.get('aaaaaaaaaaa', { background: true }); await entry.done;
  assert.equal(entry.bytes, 10);
});
