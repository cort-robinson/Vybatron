import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';

// TorBox links carry the account's API key, and Lavalink logs the URLs it
// loads and fails to play. Lavalink gets an opaque relay link instead, and the
// bot fetches the real one, passing Range through so seeking still works.
export const RELAY_LIMITS = Object.freeze({ links: 64, ttlMs: 6 * 60 * 60_000 });
const PASSED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

// The address Lavalink reaches this container on. Lavalink shares the WARP
// container's network, whose resolver may not know Compose service names.
export function containerAddress(interfaces = networkInterfaces()) {
  for (const entries of Object.values(interfaces)) {
    const found = entries?.find(entry => entry.family === 'IPv4' && !entry.internal);
    if (found) return found.address;
  }
  return '127.0.0.1';
}

export function createStreamRelay({ host = '127.0.0.1', port = 3020, fetch = globalThis.fetch, now = Date.now,
  advertise = host === '0.0.0.0' ? containerAddress() : host, logger = console } = {}) {
  const links = new Map();

  function prune() {
    for (const [id, link] of links) if (link.expires <= now()) links.delete(id);
    while (links.size >= RELAY_LIMITS.links) links.delete(links.keys().next().value);
  }

  function register(url) {
    prune();
    const id = randomUUID();
    links.set(id, { url, expires: now() + RELAY_LIMITS.ttlMs });
    return `http://${advertise}:${port}/relay/${id}`;
  }

  const server = createServer(async (request, response) => {
    const id = request.url?.match(/^\/relay\/([0-9a-f-]{36})$/)?.[1];
    const link = id && links.get(id);
    if (!link || link.expires <= now()) return response.writeHead(404).end();
    if (!['GET', 'HEAD'].includes(request.method)) return response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    const abort = new AbortController();
    response.on('close', () => abort.abort());
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
      Readable.fromWeb(upstream.body).on('error', () => response.destroy()).pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    }
  });
  server.headersTimeout = 5000;
  server.on('error', () => logger.error('[Relay] stream relay failed to listen.'));
  server.listen(port, host);
  server.unref();

  return { register, close: () => server.close(), server };
}
