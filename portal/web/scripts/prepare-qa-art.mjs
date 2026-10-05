// Test-only crops of the user's approved generated references, never runtime assets.
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory = new URL('../tests/art/', import.meta.url);
await mkdir(directory, { recursive: true });
const queue = new URL('../../../docs/portal-references/queue.png', import.meta.url);
const player = new URL('../../../docs/portal-references/player.png', import.meta.url);
for (const [name, image, left, top, width, height] of [
  ['evening', player, 389, 138, 512, 516],
  ['night', queue, 405, 256, 67, 69], ['slow', queue, 405, 349, 67, 69],
  ['golden', queue, 405, 444, 67, 69], ['afterglow', queue, 405, 538, 67, 69],
  ['jordan', queue, 953, 274, 34, 34], ['alex', queue, 953, 368, 34, 34], ['sam', queue, 953, 463, 34, 34],
]) {
  await sharp(fileURLToPath(image)).extract({ left, top, width, height }).png().toFile(fileURLToPath(new URL(`${name}.png`, directory)));
}
await writeFile(new URL('README.md', directory), '# Local visual fixtures\n\nCrops of the approved, user-supplied queue.png and player.png images in docs/portal-references. Synthetic song and avatar imagery is used only by explicit Playwright route interception on loopback. This directory is outside public/src and is not included in dist or the service-worker cache.\n');
