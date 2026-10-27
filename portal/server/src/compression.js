import zlib from 'node:zlib';
import { promisify } from 'node:util';

// Compression for private JSON and the event stream. It is safe here because
// none of these bodies carries a secret: the CSRF token travels only in the
// bootstrap reply, which is never compressed, and cookies only in requests.
// BREACH also needs an attacker to make the victim's browser send chosen
// input, and the API refuses cross-site requests (Sec-Fetch-Site, SameSite=Lax
// cookies, exact Origin on writes). The only attacker-chosen text in a body
// is shared listening state (track titles, display names) that every viewer
// of the session already sees.
const brotli = promisify(zlib.brotliCompress); const gzip = promisify(zlib.gzip);
const MIN_BYTES = 1024;
// A 170 KB snapshot (500 queued songs): brotli 4 gives 11.4 KB and gzip 4 gives
// 14 KB in about a third of the time of the next levels, which save only 3-5%.
const LEVEL = 4;

function accepted(req) {
  const header = req.headers['accept-encoding'];
  const weights = new Map();
  if (typeof header !== 'string' || header.length > 256) return weights;
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';').map(value => value.trim());
    const q = params.find(param => param.startsWith('q='));
    if (name) weights.set(name, q ? Number(q.slice(2)) || 0 : 1);
  }
  return weights;
}
const allows = (weights, name) => (weights.get(name) ?? weights.get('*') ?? 0) > 0;

// Sends one serialized JSON body, compressed when the browser accepts it and
// the body is big enough to benefit.
export async function sendJson(req, res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const weights = accepted(req); let encoding = null; let payload = Buffer.from(body);
  if (payload.length >= MIN_BYTES) {
    if (allows(weights, 'br')) {
      encoding = 'br';
      payload = await brotli(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: LEVEL, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: payload.length } });
    } else if (allows(weights, 'gzip')) { encoding = 'gzip'; payload = await gzip(payload, { level: LEVEL }); }
  }
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, Vary: 'Accept-Encoding',
    ...(encoding && { 'Content-Encoding': encoding }) });
  res.end(payload);
}

// The event stream's writer: gzip with a sync flush after every event, so each
// event reaches the browser at once. Gzip keeps per-stream memory near half a
// megabyte (brotli needs about twice that), which bounds 32 streams well inside
// the portal's memory limit. `write` returns false when the caller must wait
// for `drain` on `target` before writing more.
export function eventStream(req, res) {
  if (!allows(accepted(req), 'gzip')) return { encoding: null, target: res, write: frame => res.write(frame), end: () => res.end() };
  const encoder = zlib.createGzip({ level: LEVEL, memLevel: 8 });
  encoder.on('error', () => res.destroy());
  encoder.pipe(res);
  res.once('close', () => encoder.destroy());
  return {
    encoding: 'gzip', target: encoder,
    write(frame) { const flowing = encoder.write(frame); encoder.flush(zlib.constants.Z_SYNC_FLUSH); return flowing; },
    end: () => encoder.end(),
  };
}
