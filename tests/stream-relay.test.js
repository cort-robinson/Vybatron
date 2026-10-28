import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { containerAddress, createStreamRelay, RELAY_LIMITS } from '../src/utils/stream-relay.js';

const AUDIO = Buffer.from('0123456789abcdefghij');

// A stand-in CDN that honours byte ranges and refuses anything else.
async function cdn(t) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, range: request.headers.range });
    if (request.url !== '/file?token=secret-key') return response.writeHead(403).end('denied for /file?token=secret-key');
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
  const relay = createStreamRelay({ port: 0, ...options });
  await once(relay.server, 'listening');
  t.after(() => relay.close());
  const port = relay.server.address().port;
  // The advertised link names the configured port; tests use the bound one.
  const local = (link) => link.replace(/:0\//, `:${port}/`);
  return { relay, local, port };
}

test('a relay link streams the real file and passes byte ranges through for seeking', async t => {
  const upstream = await cdn(t);
  const { relay, local } = await relayFor(t);
  const link = relay.register(`${upstream.base}/file?token=secret-key`);
  assert.match(link, /^http:\/\/127\.0\.0\.1:0\/relay\/[0-9a-f-]{36}$/);
  assert.ok(!link.includes('secret-key'));
  const whole = await fetch(local(link));
  assert.equal(whole.status, 200);
  assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), AUDIO.toString());
  assert.equal(whole.headers.get('set-cookie'), null);
  const part = await fetch(local(link), { headers: { Range: 'bytes=10-14' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-14/20');
  assert.equal(await part.text(), 'abcde');
  assert.equal(upstream.requests.at(-1).range, 'bytes=10-14');
});

test('unknown, expired, non-read and refused links reveal nothing about the real one', async t => {
  const upstream = await cdn(t);
  let clock = 0;
  const { relay, local, port } = await relayFor(t, { now: () => clock });
  const refused = relay.register(`${upstream.base}/expired?token=secret-key`);
  const denied = await fetch(local(refused));
  assert.equal(denied.status, 403);
  assert.equal(await denied.text(), '');
  assert.equal((await fetch(local(refused), { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${port}/relay/00000000-0000-0000-0000-000000000000`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 404);
  const link = relay.register(`${upstream.base}/file?token=secret-key`);
  clock += RELAY_LIMITS.ttlMs;
  assert.equal((await fetch(local(link))).status, 404);
});

test('the relay keeps a bounded number of links, dropping the oldest', async t => {
  const { relay, local } = await relayFor(t, { fetch: async () => new Response('ok') });
  const first = relay.register('https://cdn.example/1');
  for (let count = 0; count < RELAY_LIMITS.links; count += 1) relay.register(`https://cdn.example/${count + 2}`);
  assert.equal((await fetch(local(first))).status, 404);
});

test('Compose advertises the container address Lavalink can reach, not a service name', () => {
  assert.equal(containerAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '172.18.0.5' }] }), '172.18.0.5');
  assert.equal(containerAddress({}), '127.0.0.1');
});
