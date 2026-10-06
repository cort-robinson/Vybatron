import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
const output = new URL('../.impeccable/review/', import.meta.url); await mkdir(output, { recursive: true });
const references = new URL('../../../docs/portal-references/', import.meta.url);
for (const [name, source, rendered, width, height] of [['queue', 'queue.png', 'desktop-queue.png', 1488, 1056], ['player', 'player.png', 'desktop.png', 1488, 1056], ['phone', 'phone.png', 'mobile.png', 426, 928]]) {
  const original = await sharp(fileURLToPath(new URL(source, references))).resize(width, height, { fit: 'fill' }).png().toBuffer();
  const build = await sharp(fileURLToPath(new URL(rendered, output))).resize(width, height, { fit: 'fill' }).png().toBuffer();
  await sharp({ create: { width: width * 2, height, channels: 4, background: '#09121f' } }).composite([{ input: original, left: 0, top: 0 }, { input: build, left: width, top: 0 }]).png().toFile(fileURLToPath(new URL(`compare-${name}.png`, output)));
  if (name !== 'phone') {
    for (const [region, top, regionHeight] of [['content', name === 'queue' ? 135 : 110, name === 'queue' ? 495 : 710], ['controls', 896, 160]]) {
      const originalRegion = await sharp(original).extract({ left: 0, top, width, height: regionHeight }).png().toBuffer();
      const buildRegion = await sharp(build).extract({ left: 0, top, width, height: regionHeight }).png().toBuffer();
      await sharp({ create: { width: width * 2, height: regionHeight, channels: 4, background: '#09121f' } }).composite([{ input: originalRegion, left: 0, top: 0 }, { input: buildRegion, left: width, top: 0 }]).png().toFile(fileURLToPath(new URL(`compare-${name}-${region}.png`, output)));
    }
  }
  console.log(`${name}: reference left, browser right, ${width} × ${height} CSS pixels.`);
}
