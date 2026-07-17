import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { friendlyInteractionError } from '../src/commands/index.js';

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

test('/play and /playnext query options enable bounded autocomplete', async () => {
  for (const name of ['play', 'playnext']) {
    const mod = await import(pathToFileURL(path.join(commandsDir, `${name}.js`)).href);
    const json = mod.data.toJSON();
    const query = json.options.find((option) => option.name === 'query');
    assert.equal(query.autocomplete, true);
    assert.equal(query.max_length, 200);
    assert.equal(typeof mod.autocomplete, 'function');
  }
});

test('unexpected interaction errors provide actionable recovery guidance', () => {
  assert.match(
    friendlyInteractionError({ code: 50013, message: 'Missing Permissions' }, '/play'),
    /Check View Channel/
  );
  assert.match(
    friendlyInteractionError({ message: 'No available Lavalink nodes' }, '/play'),
    /audio service is temporarily unavailable/
  );
  assert.match(
    friendlyInteractionError({ message: 'YouTube track failed to load' }, '/play'),
    /paste a direct YouTube/
  );
  assert.match(
    friendlyInteractionError(new Error('unexpected'), '/volume'),
    /share the reference below/
  );
});
