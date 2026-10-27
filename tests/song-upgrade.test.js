import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackReference } from '../src/utils/library.js';
import { upgradeList, upgradeSavedSongs, UPGRADE_MODE, UPGRADE_REPORT } from '../src/utils/song-upgrade.js';
import { openLibrary, closeLibraries } from './library-fixture.js';

const info = (id, title, author, sourceName = 'youtube') => ({ info: { sourceName, identifier: id, uri: sourceName === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : `https://soundcloud.com/artist/${id}`,
  title, author, duration: 200_000, isStream: false } });
const ref = (...args) => trackReference(info(...args));
const video = ref('aaaaaaaaaaa', 'Anti-Hero (Official Music Video)', 'TaylorSwiftVEVO');
const song = ref('bbbbbbbbbbb', 'Anti-Hero', 'Taylor Swift');
const topic = ref('ccccccccccc', 'Loser', 'Tame Impala - Topic');
const live = ref('ddddddddddd', 'Mr. Brightside (Live at Wembley)', 'The Killers');
const offline = ref('eeeeeeeeeee', 'Offline', 'Nobody');
const soundcloud = ref('track-one', 'Elsewhere', 'Someone', 'soundcloud');

// YouTube Music answers with song uploads only: never the live recording.
const results = {
  'TaylorSwiftVEVO Anti-Hero (Official Music Video)': [info('fffffffffff', 'Anti-Hero (Acoustic)', 'Taylor Swift'), info('bbbbbbbbbbb', 'Anti-Hero', 'Taylor Swift')],
  'Taylor Swift Anti-Hero': [info('bbbbbbbbbbb', 'Anti-Hero', 'Taylor Swift')],
  'Tame Impala - Topic Loser': [info('ccccccccccc', 'Loser', 'Tame Impala')],
  'The Killers Mr. Brightside (Live at Wembley)': [info('ggggggggggg', 'Mr. Brightside', 'The Killers')],
};

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-upgrade-'));
  t.after(async () => { await closeLibraries(); await fs.rm(directory, { recursive: true, force: true }); });
  const library = await openLibrary(path.join(directory, 'library.json'), { logger: { info() {}, warn() {}, error() {} } });
  await library.updateFavorites('200', list => list.push(video, topic, live, soundcloud));
  await library.updateFavorites('201', list => list.push(video, song));
  await library.updateGuild('100', guild => { guild.mixes.night = { ownerId: '200', tracks: [offline, video], savedAt: 1 }; });
  const queries = [];
  const node = { search: async ({ query, source }) => {
    assert.equal(source, 'ytmsearch'); queries.push(query);
    if (query.startsWith('Nobody')) throw new Error('offline');
    return { loadType: 'search', tracks: results[query] || [] };
  } };
  const logger = { lines: [], info(line) { this.lines.push(JSON.parse(line)); } };
  return { directory, library, node, queries, logger, run: options => upgradeSavedSongs({ library, node, logger, pauseMs: 0, now: () => 0, ...options }) };
}

test('the deployed mode is a dry run', () => assert.equal(UPGRADE_MODE, 'dry-run'));

test('a dry run reports exact song matches once and changes nothing', async t => {
  const f = await setup(t);
  const before = await fs.readFile(f.library.filePath, 'utf8');
  const report = await f.run({ mode: 'dry-run' });
  assert.deepEqual({ ...report, changes: undefined }, { version: 1, mode: 'dry-run', finishedAt: new Date(0).toISOString(), checked: 5, current: 2, unmatched: 1, failed: 1, upgrades: 1, applied: null, changes: undefined });
  assert.deepEqual(report.changes, [{ lists: ['favorites', 'mix'], from: { title: video.title, author: video.author, uri: video.uri }, to: { title: 'Anti-Hero', author: 'Taylor Swift', uri: song.uri } }]);
  assert.equal(await fs.readFile(f.library.filePath, 'utf8'), before);
  const file = path.join(f.directory, UPGRADE_REPORT);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), report);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  // The log line carries counts, never titles or links.
  assert.deepEqual(f.logger.lines, [{ event: 'saved_song_upgrade', mode: 'dry-run', checked: 5, current: 2, unmatched: 1, failed: 1, upgrades: 1 }]);
  f.queries.length = 0;
  assert.equal(await f.run({ mode: 'dry-run' }), null);
  assert.deepEqual(f.queries, []);
});

test('applying backs up the library, upgrades matches in place and never duplicates a song', async t => {
  const f = await setup(t);
  await f.run({ mode: 'dry-run' });
  const before = await fs.readFile(f.library.filePath, 'utf8');
  const report = await f.run({ mode: 'apply' });
  assert.deepEqual(report.applied, { favorites: 2, mixes: 1 });
  assert.deepEqual(f.library.favorites('200'), [song, topic, live, soundcloud]);
  assert.deepEqual(f.library.favorites('201'), [song]);
  assert.deepEqual(f.library.readGuild('100').mixes.night.tracks, [offline, song]);
  assert.equal(await fs.readFile(`${f.library.filePath}.pre-song-upgrade.bak`, 'utf8'), before);
  // References keep their exact fields, so the upgraded library opens like any other.
  await closeLibraries();
  const reopened = await openLibrary(f.library.filePath, { logger: { info() {}, warn() {}, error() {} } });
  assert.deepEqual(reopened.favorites('200'), [song, topic, live, soundcloud]);
  assert.equal(await f.run({ mode: 'apply' }), null);
});

test('a run interrupted by shutdown writes no report and starts over next time', async t => {
  const f = await setup(t);
  let checks = 0;
  assert.equal(await f.run({ mode: 'apply', draining: () => ++checks > 2 }), null);
  await assert.rejects(fs.stat(path.join(f.directory, UPGRADE_REPORT)), { code: 'ENOENT' });
  assert.deepEqual(f.library.favorites('201'), [video, song]);
});

test('shutdown during apply stops further writes and publishes no report', async t => {
  const f = await setup(t);
  let stopping = false;
  const backup = f.library.publishBackup.bind(f.library);
  f.library.publishBackup = async (...args) => { await backup(...args); stopping = true; };
  assert.equal(await f.run({ mode: 'apply', draining: () => stopping }), null);
  await assert.rejects(fs.stat(path.join(f.directory, UPGRADE_REPORT)), { code: 'ENOENT' });
  assert.deepEqual(f.library.favorites('200'), [video, topic, live, soundcloud]);
  assert.deepEqual(f.library.readGuild('100').mixes.night.tracks, [offline, video]);
});

test('upgradeList drops an upgraded entry when its song is already listed', () => {
  const list = [video, song, video];
  assert.equal(upgradeList(list, new Map([[video.uri, song]])), 2);
  assert.deepEqual(list, [song]);
});
