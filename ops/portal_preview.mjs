// Portal web preview: serves an unreleased portal/web build beside the live portal, so a branch can
// be tried on real devices before it ships. Its own files come from PREVIEW_DIST; every API, auth
// and audio request passes through to the live portal with the Origin it expects. Sign-in happens
// on the live portal (its session cookie is host-scoped, so it also reaches this port). Nothing is
// written to disk. Usage: node portal_preview.mjs  (env: PREVIEW_DIST, PREVIEW_PORT, PREVIEW_UPSTREAM,
// PREVIEW_ORIGIN = the live portal's public origin)
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

const dist = normalize(process.env.PREVIEW_DIST || '/srv/preview');
const port = Number(process.env.PREVIEW_PORT || 3002);
const upstream = new URL(process.env.PREVIEW_UPSTREAM || 'http://127.0.0.1:3001');
const origin = new URL(process.env.PREVIEW_ORIGIN || '').origin;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const passThrough = /^\/(?:api|auth|health)(?:\/|$)/;

// The live portal's security headers (CSP, HSTS, framing) also cover the preview's own files.
let security = {};
async function loadSecurity() {
  const response = await fetch(new URL('/health', upstream), { signal: AbortSignal.timeout(4000) });
  security = Object.fromEntries([...response.headers].filter(([name]) => /^(content-security-policy|strict-transport-security|x-content-type-options|referrer-policy|x-frame-options|cross-origin-resource-policy|permissions-policy)$/.test(name)));
}

function proxy(req, res) {
  const headers = { ...req.headers, host: upstream.host };
  if (headers.origin) headers.origin = origin;
  delete headers['x-forwarded-host'];
  const outgoing = request({ hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers }, incoming => {
    res.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(res);
  });
  outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' }); res.end('Live portal unavailable.'); });
  // A browser that goes away (for example, closing the event stream) ends the upstream request too.
  res.on('close', () => { if (!res.writableFinished) outgoing.destroy(); });
  req.pipe(outgoing);
}

async function file(pathname) {
  const path = normalize(join(dist, decodeURIComponent(pathname)));
  if (path !== dist && !path.startsWith(dist + sep)) return null;
  const info = await stat(path).catch(() => null);
  return info?.isFile() ? { path, size: info.size } : null;
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url || '/', 'http://preview');
    if (passThrough.test(pathname) || !['GET', 'HEAD'].includes(req.method || '')) return proxy(req, res);
    // Unknown paths are app routes (the live portal does the same); the page is this build's.
    const found = await file(pathname) || (extname(pathname) ? null : await file('/index.html'));
    if (!found) return proxy(req, res);
    const immutable = /[-.][a-zA-Z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(found.path);
    res.writeHead(200, { ...security, 'Content-Type': types[extname(found.path)] || 'application/octet-stream', 'Content-Length': found.size, 'Cache-Control': found.path.endsWith('sw.js') ? 'no-store' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(found.path).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request.');
  }
}).listen(port, '127.0.0.1', () => console.log(`Portal preview on 127.0.0.1:${port}, serving ${dist}, live portal ${upstream.origin}`));

await loadSecurity().catch(error => { console.error(`Live portal headers unavailable: ${error.message}`); process.exit(1); });
