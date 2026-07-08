import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const commandsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands');
const files = fs
  .readdirSync(commandsDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js');

test('V1: every command file exports data and execute with matching name', async () => {
  assert.ok(files.length >= 11, `expected >= 11 command files, found ${files.length}`);
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    assert.ok(mod.data, `${file} missing export: data`);
    assert.equal(typeof mod.execute, 'function', `${file} missing export: execute`);
    assert.equal(mod.data.name, path.basename(file, '.js'), `${file} data.name mismatch`);
    assert.doesNotThrow(() => mod.data.toJSON(), `${file} data.toJSON() failed`);
  }
});
