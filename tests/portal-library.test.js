import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibrary, trackReference, HISTORY_RETENTION_MS, ACTIVITY_RETENTION_MS } from '../src/utils/library.js';
import { track } from './fixtures.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, filePath: path.join(dir, 'library.json') };
}
const legacyGuild = favorites => ({ settings: { volume: 65, fairQueue: true, djRoleId: null }, favorites, mixes: {}, session: null });

test('v1 migration backs up exact bytes, merges exact public references globally and retains/promotes overflow losslessly', async t => {
  const { dir, filePath } = await fixture(t);
  const legacy = { version: 1, guilds: {} };
  for (let guild = 0; guild < 11; guild++) legacy.guilds[String(100 + guild)] = legacyGuild({ '200': Array.from({ length: guild === 10 ? 50 : 100 }, (_, index) => trackReference(track(String(guild * 100 + index).padStart(11, '0')))) });
  legacy.guilds['111'] = legacyGuild({ '200': [trackReference(track('00000000000'))], '201': [trackReference(track('00000000000'))] });
  const original = `${JSON.stringify(legacy, null, 2)}\n`;
  await fs.writeFile(filePath, original);
  const library = await new MusicLibrary(filePath).open();
  assert.equal(library.document.version, 2); assert.equal(library.favorites('200').length, 1000); assert.equal(library.favoriteOverflowCount('200'), 50);
  assert.equal(library.favorites('201').length, 1);
  assert.equal(library.settings('100').volume, 65); assert.equal(library.settings('100').musicTextChannelId, null);
  assert.equal(library.readGuild('100').favorites, undefined);
  const backups = (await fs.readdir(dir)).filter(name => name.endsWith('.bak')); assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), original);
  await library.updateFavorites('200', list => { list.splice(0, 1); });
  assert.equal(library.favorites('200').length, 1000); assert.equal(library.favoriteOverflowCount('200'), 49);
  assert.equal(library.favorites('200').at(-1).identifier, '00000001000');
  const reopened = await new MusicLibrary(filePath).open(); assert.deepEqual(reopened.document, library.document);
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.bak')).length, 1, 'reopening v2 does not remigrate');
  const all = [...reopened.favorites('200'), ...reopened.document.favoriteOverflow['200']];
  assert.equal(new Set(all.map(item => item.uri)).size, 1049);
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /encoded-|never-save|requester|pluginInfo/);
});

test('migration disk/backup failures preserve original v1 and an unsuccessful global write does not publish its draft', async t => {
  for (const stage of ['backup', 'rename', 'rename missing']) await t.test(stage, async t => {
    const { filePath, dir } = await fixture(t);
    const original = JSON.stringify({ version: 1, guilds: { '100': legacyGuild({ '200': [trackReference(track())] }) } });
    await fs.writeFile(filePath, original);
    const code = stage === 'rename missing' ? 'ENOENT' : 'ENOSPC';
    const io = { ...fs, open: async (file, ...args) => { if (stage === 'backup' && file.endsWith('.bak')) throw Object.assign(new Error('private disk error'), { code }); return fs.open(file, ...args); }, rename: async (...args) => { if (stage.startsWith('rename')) throw Object.assign(new Error('private disk error'), { code }); return fs.rename(...args); } };
    await assert.rejects(new MusicLibrary(filePath, { io }).open(), { code });
    assert.equal(await fs.readFile(filePath, 'utf8'), original);
    assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
    const library = await new MusicLibrary(filePath).open(); assert.equal(library.favorites('200').length, 1);
    library.io = { ...fs, rename: async () => { throw Object.assign(new Error('failure'), { code: 'EROFS' }); } };
    await assert.rejects(library.updateFavorites('200', list => { list.length = 0; }), { code: 'EROFS' });
    assert.equal(library.favorites('200').length, 1); assert.equal((await new MusicLibrary(filePath).open()).favorites('200').length, 1);
  });
});

test('history and successful actor activity persist with bounded retention and private-reference-only storage', async t => {
  const { filePath } = await fixture(t); const library = await new MusicLibrary(filePath).open();
  const now = Date.now();
  await library.updateGuild('100', guild => {
    guild.history = Array.from({ length: 105 }, (_, index) => ({ id: String(index), playedAt: now - index, voiceChannelId: index % 2 ? '300' : '301', track: trackReference(track(String(index).padStart(11, '0'))) }));
    guild.activity = [ { id: 'old', at: now - ACTIVITY_RETENTION_MS - 100, actor: { id: '200', displayName: 'Listener' }, action: 'queue', detail: 'Listening queue updated.' } ];
  });
  assert.equal(library.readGuild('100').history.length, 100); assert.equal(library.readGuild('100').activity.length, 0);
  await library.updateGuild('100', guild => { guild.history[0].playedAt = now - HISTORY_RETENTION_MS - 100; });
  assert.equal(library.readGuild('100').history.length, 99);
  await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track('abcdefghijk'));
  await library.recordActivity('100', { id: '200', username: 'Listener' }, 'settings');
  const reopened = await new MusicLibrary(filePath).open();
  assert.equal(reopened.readGuild('100').history.length, 100); assert.equal(reopened.readGuild('100').history[0].voiceChannelId, '300');
  assert.equal(reopened.readGuild('100').activity[0].action, 'settings');
  assert.doesNotMatch(await fs.readFile(filePath, 'utf8'), /encoded-|never-save|userData|pluginInfo/);
});
