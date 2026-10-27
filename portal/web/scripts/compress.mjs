// Brotli and gzip copies of the built text files, served by the portal server when the browser
// accepts them (portal/server/src/static.js). Compressing once here at maximum effort keeps the
// small proxy and server from spending CPU on every response. Each copy is written after its
// original, which is how the server tells a current copy from a stale one. Runs after
// build-sw.mjs: the copies are encodings of the same URLs, never extra precached URLs.
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

// Keep in sync with COMPRESSIBLE in portal/server/src/static.js.
const compressible = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);
// Below this, the headers outweigh the saving.
const minimumBytes = 1024;
const directory = fileURLToPath(new URL('../dist/', import.meta.url));

const files = [];
async function collect(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (/\.(?:br|gz)$/.test(entry.name)) await rm(path);
    else if (compressible.has(extname(entry.name).toLowerCase())) files.push(path);
  }
}
await collect(directory);

let count = 0; let before = 0; let brotli = 0; let gzip = 0;
for (const path of files.sort()) {
  const source = await readFile(path);
  if (source.length < minimumBytes) continue;
  const encodings = {
    br: brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT, [constants.BROTLI_PARAM_SIZE_HINT]: source.length } }),
    gz: gzipSync(source, { level: 9 }),
  };
  count++; before += source.length;
  for (const [extension, encoded] of Object.entries(encodings)) {
    // An encoding that saves little isn't worth a second copy of the file.
    if (encoded.length > source.length * 0.9) continue;
    await writeFile(`${path}.${extension}`, encoded);
    if (extension === 'br') brotli += encoded.length; else gzip += encoded.length;
  }
}
const kb = bytes => `${(bytes / 1024).toFixed(1)} KB`;
console.log(`Compressed ${count} text files: ${kb(before)} → brotli ${kb(brotli)}, gzip ${kb(gzip)}.`);
