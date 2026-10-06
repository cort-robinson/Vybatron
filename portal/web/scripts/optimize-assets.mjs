// Mechanical compression of the approved raster assets. Source PNGs are retained
// in Git at 0bb9bc6 and may be supplied from any private working directory.
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source = resolve(process.argv[2] || 'public/assets');
const destination = resolve('public/assets');
await mkdir(destination, { recursive: true });
const assets = [];
for (const [name, width, quality] of [
  ['aurora', 1600, 82], ['fallback-cover', 320, 82],
  ['fallback-cover', 640, 84], ['fallback-cover', 1024, 86],
]) {
  const original = await readFile(resolve(source, `${name}.png`));
  const file = name === 'aurora' ? 'aurora.webp' : `${name}-${width}.webp`;
  const encoded = await sharp(original).resize({ width, withoutEnlargement: true }).webp({ quality, effort: 6 }).toBuffer();
  await writeFile(resolve(destination, file), encoded);
  assets.push({ file, bytes: encoded.length, sourceBytes: original.length,
    sourceSha256: createHash('sha256').update(original).digest('hex'),
    sha256: createHash('sha256').update(encoded).digest('hex') });
}
console.log(JSON.stringify(assets, null, 2));
