import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { portalFixture } from './portal-fixtures.js';
import { createAudioCache, sendAudio } from '../src/portal/audio.js';

const song = Buffer.from(Array.from({ length: 1000 }, (_, index) => index % 251));

// Lavalink's YouTube plugin route at the network boundary.
async function fakeLavalink(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://lavalink.invalid');
    requests.push({ path: url.pathname, itag: url.searchParams.get('itag'), auth: request.headers.authorization });
    const id = url.pathname.split('/').pop();
    if (id === 'abcdefghijk' || (id === 'webmonly123' && url.searchParams.get('itag') === '251')) {
      // Like the plugin: a bogus length and no Range support.
      response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(song); return;
    }
    response.writeHead(400, { 'Content-Type': 'application/json' }); response.end('{"message":"no format"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return { port: server.address().port, requests };
}
async function audioFixture(t) {
  const f = await portalFixture(t);
  const lavalink = await fakeLavalink(t);
  f.node.options = { host: '127.0.0.1', port: lavalink.port, authorization: 'lavalink-secret', secure: false };
  const get = (id, { actor = '200', headers = {} } = {}) => fetch(`${f.origin}/v1/guilds/100/audio/${id}?actorId=${actor}`, { headers: { Authorization: `Bearer ${f.token}`, ...headers } });
  return { f, lavalink, get };
}

test('portal audio serves a cached audio-only track by byte range', async t => {
  const { lavalink, get } = await audioFixture(t);
  const full = await get('abcdefghijk');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mp4'); assert.equal(full.headers.get('content-length'), '1000');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), song);
  assert.deepEqual(lavalink.requests, [{ path: '/youtube/stream/abcdefghijk', itag: '140', auth: 'lavalink-secret' }]);

  const part = await get('abcdefghijk', { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), song.subarray(10, 20));
  const tail = await get('abcdefghijk', { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.headers.get('content-range'), 'bytes 995-999/1000');
  const open = await get('abcdefghijk', { headers: { Range: 'bytes=990-' } });
  assert.equal(open.headers.get('content-range'), 'bytes 990-999/1000'); await open.arrayBuffer();
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=2000-' } })).status, 416);
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=a-b' } })).status, 416);
  // Range requests reuse the one download.
  assert.equal(lavalink.requests.length, 1);
});

test('portal audio falls back to Opus and explains unavailable songs', async t => {
  const { lavalink, get } = await audioFixture(t);
  const webm = await get('webmonly123');
  assert.equal(webm.status, 200); assert.equal(webm.headers.get('content-type'), 'audio/webm'); await webm.arrayBuffer();
  assert.deepEqual(lavalink.requests.map(item => item.itag), ['140', '251']);
  const missing = await get('missing1234');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'audio_unavailable');
  // A failed lookup is not cached as a success; it is tried again next time.
  await (await get('missing1234')).arrayBuffer();
  assert.equal(lavalink.requests.filter(item => item.path.endsWith('missing1234')).length, 4);
});

test('portal audio needs server membership and a valid video id', async t => {
  const { lavalink, get } = await audioFixture(t);
  assert.equal((await get('abcdefghijk', { actor: '901' })).status, 404);
  assert.equal((await get('short')).status, 404);
  assert.equal((await fetch(`${(await audioFixture(t)).f.origin}/v1/guilds/100/audio/abcdefghijk?actorId=200`)).status, 401);
  assert.equal(lavalink.requests.length, 0);
});

test('the audio cache evicts least recently used songs and bounds concurrent downloads', async () => {
  const sizes = { aaaaaaaaaaa: 40, bbbbbbbbbbb: 40, ccccccccccc: 40 };
  const fetches = [];
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 },
    fetchImpl: async url => { const id = new URL(url).pathname.split('/').pop(); fetches.push(id); return new Response(Buffer.alloc(sizes[id] ?? 60)); } });
  await cache.get('aaaaaaaaaaa'); await cache.get('bbbbbbbbbbb');
  await cache.get('aaaaaaaaaaa');
  await cache.get('ccccccccccc');
  assert.equal(cache.size, 80);
  await cache.get('aaaaaaaaaaa');
  assert.deepEqual(fetches, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await assert.rejects(cache.get('ddddddddddd'), error => error.status === 413);
  const slow = { ...client };
  const gated = createAudioCache(slow, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 1, timeoutMs: 1000 }, fetchImpl: () => new Promise(() => {}) });
  void gated.get('aaaaaaaaaaa').catch(() => {});
  assert.throws(() => gated.get('bbbbbbbbbbb'), error => error.status === 429);
});

test('sendAudio answers whole and partial requests the way media elements expect', () => {
  const sent = [];
  const response = { writeHead: (status, headers) => sent.push({ status, headers }), end: body => sent.push(body?.length ?? 0) };
  sendAudio({ headers: { range: 'bytes=0-1' } }, response, { data: song, type: 'audio/mp4' });
  assert.equal(sent[0].status, 206); assert.equal(sent[0].headers['Content-Length'], 2); assert.equal(sent[1], 2);
});
