import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createTcpServer } from 'node:net';
import { createServer } from 'node:http';
import { addressToward, createStreamRelay, RELAY_LIMITS } from '../src/utils/stream-relay.js';

const AUDIO = Buffer.from('0123456789abcdefghij');

// A stand-in CDN that honours byte ranges and refuses anything else.
async function cdn(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, range: request.headers.range });
    if (request.url !== '/file?token=secret-key') return response.writeHead(403, { 'X-Detail': 'secret-key' }).end('denied for /file?token=secret-key');
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!range) return response.writeHead(200, { 'Content-Type': 'audio/flac', 'Content-Length': AUDIO.length, 'Accept-Ranges': 'bytes', 'Set-Cookie': 'x=1' }).end(AUDIO);
    const start = Number(range[1]); const end = range[2] ? Number(range[2]) : AUDIO.length - 1;
    response.writeHead(206, { 'Content-Type': 'audio/flac', 'Content-Range': `bytes ${start}-${end}/${AUDIO.length}`, 'Content-Length': end - start + 1 })
      .end(AUDIO.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}

async function relayFor(t, options = {}) {
  const relay = createStreamRelay({ port: 0, logger: { error: () => {} }, ...options });
  t.after(() => relay.close());
  assert.equal(await relay.ready(), true);
  return relay;
}

test('a relay link streams the real file and passes byte ranges through for seeking', async t => {
  const upstream = await cdn(t);
  const relay = await relayFor(t);
  const link = await relay.register(`${upstream.base}/file?token=secret-key`);
  assert.match(link, /^http:\/\/127\.0\.0\.1:\d+\/relay\/[0-9a-f-]{36}$/);
  assert.ok(!link.includes('secret-key'));
  const whole = await fetch(link);
  assert.equal(whole.status, 200);
  assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), AUDIO.toString());
  assert.equal(whole.headers.get('set-cookie'), null);
  const part = await fetch(link, { headers: { Range: 'bytes=10-14' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-14/20');
  assert.equal(await part.text(), 'abcde');
  assert.equal(upstream.requests.at(-1).range, 'bytes=10-14');
});

test('unknown, expired, non-read and refused links reveal nothing about the real one', async t => {
  const upstream = await cdn(t);
  let clock = 0;
  const relay = await relayFor(t, { now: () => clock });
  const port = relay.server.address().port;
  const refused = await relay.register(`${upstream.base}/expired?token=secret-key`);
  const denied = await fetch(refused);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('x-detail'), null);
  assert.equal(await denied.text(), '');
  assert.equal((await fetch(refused, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/relay/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 404);
  const link = await relay.register(`${upstream.base}/file?token=secret-key`);
  clock += RELAY_LIMITS.ttlMs;
  assert.equal((await fetch(link)).status, 404);
});

test('the relay keeps a bounded number of links and concurrent streams', async t => {
  const held = [];
  const relay = await relayFor(t, { fetch: async () => new Response(new ReadableStream({ start(c) { held.push(c); } })) });
  const first = await relay.register('https://cdn.example/1');
  for (let count = 0; count < RELAY_LIMITS.links; count += 1) await relay.register(`https://cdn.example/${count + 2}`);
  assert.equal((await fetch(first)).status, 404);
  const link = await relay.register('https://cdn.example/open');
  const open = await Promise.all(Array.from({ length: RELAY_LIMITS.streams }, () => fetch(link)));
  assert.ok(open.every(response => response.status === 200));
  assert.equal((await fetch(link)).status, 503);
  for (const response of open) await response.body.cancel();
  for (const controller of held) controller.close();
});

test('a relay that cannot listen hands out no links', async t => {
  const blocker = createTcpServer().listen(0, '127.0.0.1'); await once(blocker, 'listening');
  t.after(() => blocker.close());
  const errors = [];
  const relay = createStreamRelay({ port: blocker.address().port, logger: { error: (message) => errors.push(message) } });
  assert.equal(await relay.ready(), false);
  assert.equal(await relay.register('https://cdn.example/song'), null);
  assert.equal(errors.length, 1);
});

test('the advertised address is the local end of a connection to Lavalink', async t => {
  const lavalink = createTcpServer(socket => socket.end()).listen(0, '127.0.0.1'); await once(lavalink, 'listening');
  t.after(() => lavalink.close());
  assert.equal(await addressToward('127.0.0.1', lavalink.address().port), '127.0.0.1');
  const relay = await relayFor(t, { host: '0.0.0.0', advertise: () => addressToward('127.0.0.1', lavalink.address().port) });
  assert.match(await relay.register('https://cdn.example/song'), /^http:\/\/127\.0\.0\.1:\d+\/relay\//);
  const unreachable = await relayFor(t, { advertise: async () => { throw new Error('Lavalink unreachable'); } });
  assert.equal(await unreachable.register('https://cdn.example/song'), null);
});

test('a closed or failed relay stops handing out links', async t => {
  const errors = [];
  const relay = await relayFor(t, { logger: { error: (message) => errors.push(message) } });
  relay.server.emit('error', new Error('later failure'));
  relay.server.emit('error', new Error('another failure'));
  assert.equal(await relay.ready(), false);
  assert.equal(await relay.register('https://cdn.example/song'), null);
  assert.equal(errors.length, 1);
  const closed = await relayFor(t);
  closed.close();
  assert.equal(await closed.ready(), false);
  assert.equal(await closed.register('https://cdn.example/song'), null);
});
