import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibrary, trackReference, catalogUrl, LIBRARY_LIMITS, LIBRARY_WARNING_RATIO, HISTORY_RETENTION_MS } from '../src/utils/library.js';
import { sessionSnapshot, savedSession, attachSessionSnapshots, SESSION_RETENTION_MS } from '../src/utils/sessions.js';
import { track } from './fixtures.js';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-library-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'library.json');
  return { filePath, library: await new MusicLibrary(filePath, options).open() };
}

test('concurrent library writes survive reopening without losing a listener’s favorites', async t => {
  const { library, filePath } = await fixture(t);
  await Promise.all(Array.from({ length: 30 }, (_, i) => library.updateFavorites('200', list => {
    list.push(trackReference(track(String(i).padStart(11, '0'))));
  })));
  const reopened = await new MusicLibrary(filePath).open();
  assert.equal(reopened.favorites('200').length, 30);
  assert.equal(reopened.favorites('201').length, 0);
  assert.deepEqual(library.document, reopened.document);
  const saved = await fs.readFile(filePath, 'utf8');
  assert.doesNotMatch(saved, /never-save|encoded-|requester|userData/);
});

test('disk replacement failure leaves both in-memory and durable library unchanged, and later saves recover', async t => {
  const { filePath } = await fixture(t);
  let fail = false;
  const io = { ...fs, rename: async (...args) => { if (fail) throw Object.assign(new Error('Disk unavailable'), { code: 'ENOSPC' }); return fs.rename(...args); } };
  const library = await new MusicLibrary(filePath, { io }).open();
  await library.updateGuild('100', guild => { guild.settings.volume = 40; });
  fail = true;
  await assert.rejects(library.updateGuild('100', guild => { guild.settings.volume = 90; }), { code: 'ENOSPC' });
  assert.equal(library.settings('100').volume, 40);
  assert.equal((await new MusicLibrary(filePath).open()).settings('100').volume, 40);
  assert.deepEqual((await fs.readdir(path.dirname(filePath))).sort(), ['library.json']);
  fail = false;
  await library.updateGuild('100', guild => { guild.settings.fairQueue = true; });
  assert.equal(library.settings('100').fairQueue, true);
});

test('damaged and oversized libraries fail startup without overwriting the evidence', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, '{broken');
  await assert.rejects(new MusicLibrary(filePath).open());
  assert.equal(await fs.readFile(filePath, 'utf8'), '{broken');
  await fs.writeFile(filePath, 'x'.repeat(LIBRARY_LIMITS.bytes + 1));
  await assert.rejects(new MusicLibrary(filePath).open(), /size limit/);
});

test('library snapshots contain public catalog references only and isolate returned state', async t => {
  const { library } = await fixture(t);
  assert.equal(catalogUrl('https://youtu.be/abcdefghijk?si=tracking'), 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(catalogUrl('https://www.youtube.com/shorts/abcdefghijk'), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const url of ['http://youtube.com/watch?v=abcdefghijk', 'https://localhost/audio', 'https://user:secret@youtube.com/watch?v=abcdefghijk', 'https://evil.youtube.com/watch?v=abcdefghijk', 'https://youtube.com:4430/watch?v=abcdefghijk', 'file:///private.mp3']) assert.equal(catalogUrl(url), null);
  await library.updateFavorites('200', list => { list.push(trackReference(track())); });
  const copy = library.favorites('200'); copy.length = 0;
  assert.equal(library.favorites('200').length, 1);
});

test('checkpoints use reported progress, persist pause/queue state and expire after 72 hours', async t => {
  const { library } = await fixture(t);
  const player = { guildId: '100', voiceChannelId: '300', textChannelId: '400', lastPosition: 8000, position: 99_000, paused: true, volume: 75, repeatMode: 'queue', queue: { current: track(), tracks: [track('lmnopqrstuv')] } };
  const snapshot = sessionSnapshot(player, 100_000);
  assert.equal(snapshot.position, 8000);
  assert.equal(snapshot.tracks.length, 2);
  assert.equal(snapshot.paused, true);
  await library.updateGuild('100', guild => { guild.session = snapshot; });
  assert.equal(savedSession(library, '100', 100_100).position, 8000);
  assert.equal(savedSession(library, '100', 100_000 + SESSION_RETENTION_MS + 1), null);
  player.queue.current.info.isStream = true;
  assert.equal(sessionSnapshot(player).position, 0);
  assert.equal(sessionSnapshot({ ...player, voiceChannelId: 'another-guild' }), null);
});

function countingWrites() {
  const io = { ...fs, writes: 0, rename: async (...args) => { io.writes += 1; return fs.rename(...args); } };
  return io;
}

test('checkpoints skip unchanged snapshots, step playing progress by 30 s and keep exact shutdown progress', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const io = countingWrites();
  const { library } = await fixture(t, { io });
  const handlers = new Map();
  const player = { guildId: '100', voiceChannelId: '300', textChannelId: '400', lastPosition: 10_000, paused: false, volume: 80, repeatMode: 'off', queue: { current: track(), tracks: [] } };
  const client = { library, lavalink: { players: new Map([['100', player]]), on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) } };
  const stop = attachSessionSnapshots(client, { intervalMs: 15_000 });
  const tick = async (position) => { player.lastPosition = position; t.mock.timers.tick(15_000); t.mock.timers.tick(500); await library.pending; };
  await tick(10_000);
  assert.equal(io.writes, 1);
  assert.equal(library.readGuild('100').session.position, 0);
  await tick(25_000);
  handlers.get('playerClientUpdate')(null, player); t.mock.timers.tick(500); await library.pending;
  assert.equal(io.writes, 1, 'progress within the same 30 s step is not rewritten');
  await tick(31_000);
  assert.equal(io.writes, 2);
  assert.equal(library.readGuild('100').session.position, 30_000);
  player.paused = true;
  await tick(31_000);
  assert.equal(io.writes, 3, 'a pause is a real change');
  for (let i = 0; i < 230; i += 1) await tick(31_000);
  assert.equal(io.writes, 3, 'a paused player does not rewrite the library');
  for (let i = 0; i < 20; i += 1) await tick(31_000);
  assert.equal(io.writes, 4, 'an unchanged checkpoint is refreshed hourly so it never expires while live');
  player.lastPosition = 44_321;
  await stop();
  assert.equal(io.writes, 5);
  assert.equal(library.readGuild('100').session.position, 44_321);
});

test('clearing an absent checkpoint and no-op retention leave the library file untouched', async t => {
  const io = countingWrites();
  const { library } = await fixture(t, { io });
  const handlers = new Map();
  const client = { library, lavalink: { players: new Map(), on: (name, fn) => handlers.set(name, fn), off: name => handlers.delete(name) } };
  const stop = attachSessionSnapshots(client);
  t.after(stop);
  handlers.get('queueEnd')({ guildId: '100', queue: { tracks: [] } });
  await library.pending;
  assert.equal(io.writes, 0);
  assert.deepEqual(library.guildIds(), []);
  await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track());
  assert.equal(io.writes, 1);
  await library.pruneExpired();
  assert.equal(io.writes, 1, 'nothing expired, so nothing is rewritten');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + HISTORY_RETENTION_MS + 1);
  await library.pruneExpired();
  assert.equal(io.writes, 2);
  assert.equal(library.readGuild('100').history.length, 0);
});

test('library size is reported and a rate-limited warning fires past 80% of the shared cap', async t => {
  let now = 0;
  const warnings = [];
  const { library, filePath } = await fixture(t, { now: () => now, logger: { warn: message => warnings.push(message) } });
  await library.updateGuild('100', guild => { guild.settings.volume = 50; });
  assert.deepEqual(library.capacity(), { bytes: (await fs.stat(filePath)).size, limitBytes: LIBRARY_LIMITS.bytes });
  assert.equal(warnings.length, 0);
  const reference = id => ({ ...trackReference(track(id)), title: 'T'.repeat(180), author: 'A'.repeat(120) });
  await library.updateDocument(draft => {
    for (let user = 0; user < 11; user += 1) {
      draft.favorites[String(1000 + user)] = Array.from({ length: LIBRARY_LIMITS.favorites }, (_, i) => reference(String(user * 10_000 + i).padStart(11, '0')));
    }
  });
  const { bytes } = library.capacity();
  assert.ok(bytes >= LIBRARY_LIMITS.bytes * LIBRARY_WARNING_RATIO && bytes <= LIBRARY_LIMITS.bytes);
  assert.equal(bytes, (await fs.stat(filePath)).size);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\d+% full/);
  assert.doesNotMatch(warnings[0], /100\b|1000|Song|T{5}/);
  now += 30 * 60_000;
  await library.updateGuild('100', guild => { guild.settings.volume = 60; });
  assert.equal(warnings.length, 1, 'repeat warnings are rate limited');
  now += 30 * 60_000;
  await library.updateGuild('100', guild => { guild.settings.volume = 70; });
  assert.equal(warnings.length, 2);
  const reopenedWarnings = [];
  const reopened = await new MusicLibrary(filePath, { logger: { warn: message => reopenedWarnings.push(message) } }).open();
  assert.equal(reopened.capacity().bytes, (await fs.stat(filePath)).size);
  assert.equal(reopenedWarnings.length, 1, 'startup warns when the library is already nearly full');
});
