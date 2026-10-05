import { mkdir, writeFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaveformIcon } from '@phosphor-icons/react/ssr';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const directory = new URL('../public/icons/', import.meta.url);
await mkdir(directory, { recursive: true });
const svg = renderToStaticMarkup(createElement(WaveformIcon, { size: 512, color: '#f20aa7', weight: 'regular' }));
await writeFile(new URL('icon.svg', directory), svg);
for (const [name, size, inset] of [['icon-192.png', 192, 28], ['icon-512.png', 512, 76], ['maskable-512.png', 512, 104], ['apple-touch-icon.png', 180, 27]]) {
  const mark = await sharp(Buffer.from(svg)).resize(size - inset * 2, size - inset * 2).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#09121f' } }).composite([{ input: mark, left: inset, top: inset }]).png().toFile(fileURLToPath(new URL(name, directory)));
}
await writeFile(new URL('PROVENANCE.md', directory), '# App icons\n\nSource: Phosphor Icons, Waveform regular, @phosphor-icons/react 2.1.10, MIT license.\nRendered with React server markup and Sharp; midnight ground and magenta mark from the approved portal palette.\nRegenerate with `node scripts/build-icons.mjs`. No AI-generated or user avatar imagery.\n');
