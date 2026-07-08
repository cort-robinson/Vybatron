import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FORBIDDEN = [
  'discord-player',
  'vulkava',
  'ytdl',
  'play-dl',
  'youtube-ext',
  'opusscript',
  '@discordjs/voice',
  'node-wit',
];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : full.endsWith('.js') ? [full] : [];
  });
}

test('V7: no second-engine imports anywhere in src', () => {
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const forbidden of FORBIDDEN) {
      assert.ok(
        !content.includes(forbidden),
        `${path.relative(srcDir, file)} references forbidden module: ${forbidden}`
      );
    }
  }
});
