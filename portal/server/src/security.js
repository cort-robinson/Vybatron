import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const busy = () => new HttpError(429, 'busy', 'The portal is busy. Please try again shortly.');
export const unavailable = () => new HttpError(503, 'unavailable', 'The service is unavailable. Refresh before making another change.');
export const unauthorized = () => new HttpError(401, 'unauthenticated', 'Sign in with Discord to continue.');
export const invalid = () => new HttpError(400, 'invalid_input', 'The request contains invalid or unsupported input.');

export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const first = Buffer.from(a); const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export function cookie(req, name) {
  const values = (req.headers.cookie || '').split(';').map(item => item.trim()).filter(item => item.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

export function setCookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}

export function securityHeaders(res, production) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  // Audio for this device's player comes from the portal itself (/api/.../audio). The MilkDrop
  // visualizer compiles each preset's equations to WebAssembly ('wasm-unsafe-eval'); JavaScript
  // eval stays refused (ADR-0015).
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self'; manifest-src 'self'");
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

export function sameOrigin(req, config, { optional = false } = {}) {
  const origin = req.headers.origin;
  if ((!optional || origin !== undefined) && origin !== config.origin) {
    throw new HttpError(403, 'forbidden', 'This request must come from the portal origin.');
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'forbidden', 'Cross-site requests are not allowed.');
  }
}

export function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function sendError(res, error) {
  if (res.headersSent) { res.destroy(); return; }
  const known = error instanceof HttpError;
  const status = known ? error.status : 503;
  if (status === 429) res.setHeader('Retry-After', '5');
  json(res, status, { error: { code: known ? error.code : 'unavailable', message: known ? error.message : unavailable().message } });
}

export class RateLimiter {
  constructor(maxKeys, now = Date.now) { this.entries = new Map(); this.maxKeys = maxKeys; this.now = now; }
  check(key, limit, period = 60_000) {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxKeys) throw busy();
      entry = { count: 0, until: now + period }; this.entries.set(key, entry);
    }
    if (++entry.count > limit) throw busy();
  }
}

export async function readBody(req, maxBytes, timeoutMs, signal) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) throw invalid();
  if (req.headers['content-length'] !== undefined && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > maxBytes)) throw invalid();
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const timer = setTimeout(() => finish(invalid()), timeoutMs); timer.unref();
    const finish = (error, body) => {
      clearTimeout(timer); req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAborted);
      signal?.removeEventListener('abort', onCancel);
      if (error) { req.resume(); reject(error); } else resolve(body);
    };
    const onData = chunk => { size += chunk.length; if (size > maxBytes) finish(invalid()); else chunks.push(chunk); };
    const onEnd = () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(invalid()); } };
    const onError = () => finish(invalid()); const onAborted = () => finish(invalid());
    const onCancel = () => finish(signal.reason instanceof HttpError ? signal.reason : invalid());
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onAborted);
    signal?.addEventListener('abort', onCancel, { once: true });
    if (signal?.aborted) onCancel();
  });
}
