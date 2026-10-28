import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { Readable } from 'node:stream';

// TorBox links carry the account's API key, and Lavalink logs the URLs it
// loads and fails to play. Lavalink gets an opaque relay link instead, and the
// bot fetches the real one, passing Range through so seeking still works.
// Lavalink reads a song with one or two streams at a time; the cap bounds the
// bot's memory if something asks for many more.
export const RELAY_LIMITS = Object.freeze({ links: 64, ttlMs: 6 * 60 * 60_000, streams: 8, connectMs: 3000 });
const PASSED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

// This container's address on the network it shares with Lavalink: the local
// end of a connection to it. A container on several networks (the portal adds
// one) has several addresses, in no promised order. Lavalink shares the WARP
// container's network, whose resolver may not know Compose service names, so
// the link names an address rather than a host.
export function addressToward(host, port, { timeoutMs = RELAY_LIMITS.connectMs } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, family: 4, timeout: timeoutMs });
    socket.once('connect', () => { resolve(socket.localAddress); socket.destroy(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Lavalink unreachable')); });
    socket.once('error', () => reject(new Error('Lavalink unreachable')));
  });
}

export function createStreamRelay({ host = '127.0.0.1', port = 3020, fetch = globalThis.fetch, now = Date.now,
  advertise = async () => host, logger = console } = {}) {
  const links = new Map();
  let streams = 0;

  function prune() {
    for (const [id, link] of links) if (link.expires <= now()) links.delete(id);
    while (links.size >= RELAY_LIMITS.links) links.delete(links.keys().next().value);
  }

  const server = createServer(async (request, response) => {
    const id = request.url?.match(/^\/relay\/([0-9a-f-]{36})$/)?.[1];
    const link = id && links.get(id);
    if (!link || link.expires <= now()) return response.writeHead(404).end();
    if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    if (streams >= RELAY_LIMITS.streams) return response.writeHead(503, { 'Retry-After': '1' }).end();
    streams += 1;
    const abort = new AbortController();
    response.on('close', () => { streams -= 1; abort.abort(); });
    try {
      const upstream = await fetch(link.url, { method: request.method, signal: abort.signal,
        headers: request.headers.range ? { Range: request.headers.range } : {} });
      // An error page stays upstream: it could describe the real link.
      if (upstream.status >= 400) {
        void upstream.body?.cancel().catch(() => {});
        return response.writeHead(upstream.status).end();
      }
      const headers = Object.fromEntries(PASSED.map(name => [name, upstream.headers.get(name)]).filter(([, value]) => value));
      response.writeHead(upstream.status, headers);
      if (request.method === 'HEAD' || !upstream.body) return response.end();
      // Lavalink sees the response begin before the first audio arrives.
      response.flushHeaders();
      Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    }
  });
  server.headersTimeout = 5000;
  // Links are handed out only while the relay is listening. A taken port
  // turns the fallback off rather than sending Lavalink to another server.
  const listening = new Promise((resolve) => {
    server.once('listening', () => resolve(true));
    server.once('error', () => {
      logger.error('[Relay] stream relay failed to listen; the TorBox fallback is off.');
      resolve(false);
    });
  });
  server.listen(port, host);
  server.unref();

  // The relay link for a real one, or null while the relay can't serve it.
  async function register(url) {
    if (!await listening) return null;
    const address = await advertise().catch(() => null);
    if (!address) return null;
    prune();
    const id = randomUUID();
    links.set(id, { url, expires: now() + RELAY_LIMITS.ttlMs });
    return `http://${address}:${server.address().port}/relay/${id}`;
  }

  return { register, ready: () => listening, close: () => server.close(), server };
}
