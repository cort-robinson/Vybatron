import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MusicLibrary, trackReference, catalogUrl, LIBRARY_LIMITS } from '../src/utils/library.js';
import { sessionSnapshot, savedSession, SESSION_RETENTION_MS } from '../src/utils/sessions.js';
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
