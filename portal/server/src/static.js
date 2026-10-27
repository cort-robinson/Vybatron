import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';

// The web build writes brotli and gzip copies next to text assets (portal/web/scripts/compress.mjs).
// Static responses never compress at request time: the proxy in front has little CPU to spare.
export const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
const CODINGS = [['br', '.br'], ['gzip', '.gz']];

// Vite writes every bundled file to /assets/ as name-<8 character content hash>.ext, so a
// changed file always has a new URL. Public files keep their names and must revalidate.
const HASHED = /-[A-Za-z0-9_-]{8}\.(?:js|css|woff2?|webp|avif|png|jpe?g|svg)$/;
export function immutable(root, file) {
  const parts = path.relative(root, file).split(path.sep);
  return parts.length === 2 && parts[0] === 'assets' && HASHED.test(parts[1]);
}

// Codings this request accepts, most preferred first. An explicit q=0 refuses a coding.
export function acceptedCodings(header) {
  const weights = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(value => value.trim());
    if (!name) continue;
    const q = params.map(param => /^q=([01](?:\.\d{0,3})?)$/.exec(param)).find(Boolean);
    weights.set(name, q ? Number(q[1]) : 1);
  }
  const weight = coding => weights.get(coding) ?? weights.get('*') ?? 0;
  return CODINGS.filter(([coding]) => weight(coding) > 0).sort((a, b) => weight(b[0]) - weight(a[0]));
}

// If-None-Match uses the weak comparison (RFC 9110 13.1.2): W/ prefixes are ignored.
export function notModified(header, etag) {
  if (typeof header !== 'string') return false;
  if (header.trim() === '*') return true;
  return header.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
}

// Open a prebuilt encoding beside the file. It must be a regular file written no earlier than
// the original, so a stale copy left by an older build is never served for new content.
export async function openVariant(file, original, maxBytes) {
  let handle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (stat.isFile() && stat.size <= maxBytes && stat.mtimeMs >= original.mtimeMs) return { handle, stat, size: stat.size };
  } catch { /* No usable variant: serve the original. */ }
  await handle?.close();
  return null;
}

// Strong validators from file content, hashed once per file version (size, mtime and inode).
export class EntityTags {
  constructor(maxEntries = 4096) { this.entries = new Map(); this.maxEntries = maxEntries; }
  async get(file, handle, stat) {
    const version = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    const known = this.entries.get(file);
    if (known?.version === version) return known.tag;
    // Positional reads leave the handle's own position at 0 for the response stream.
    const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; position < stat.size;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const tag = hash.digest('base64url').slice(0, 32);
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(file, { version, tag });
    return tag;
  }
}
