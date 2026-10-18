import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandDefinitions, registerCommands } from '../deploy-commands.js';

test('the complete v2 command catalog is valid, unique and restricted to servers', async () => {
  const definitions = await commandDefinitions();
  assert.ok(definitions.length > 0);
  assert.equal(new Set(definitions.map(c => c.name)).size, definitions.length);
  assert.ok(definitions.every(c => c.dm_permission === false));
  for (const name of ['favorite', 'mix', 'radio', 'session', 'settings', 'voteskip', 'history', 'replay', 'filter', 'help', 'invite', 'lyrics']) assert.ok(definitions.some(c => c.name === name));
});

test('broken definitions and missing guild targets fail closed before updating Discord', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-registration-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(directory, 'broken.js'), 'export const data = {};');
  let requests = 0;
  const cfg = { token: 'private', clientId: '123456789012345678', guildId: '987654321098765432' };
  const rest = { put: async () => { requests++; return []; } };
  await assert.rejects(registerCommands({ cfg, rest, definitions: () => commandDefinitions(directory) }), /incomplete/);
  await assert.rejects(registerCommands({ mode: 'guild', cfg: { ...cfg, guildId: null }, rest }), /GUILD_ID/);
  assert.equal(requests, 0);
});
