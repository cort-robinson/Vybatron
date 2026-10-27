import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trackReference } from '../src/utils/library.js';
import { PlayStats } from '../src/utils/play-stats.js';
import { songKey } from '../src/utils/song-identity.js';
import { upgradeList, upgradeSavedSongs, UPGRADE_MODE, UPGRADE_REPORT, UPGRADE_UNDO } from '../src/utils/song-upgrade.js';
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
const audioVideo = ref('hhhhhhhhhhh', 'Michael Jackson - Chicago (Official Audio)', 'michaeljacksonVEVO');
const chicago = ref('iiiiiiiiiii', 'Chicago', 'Michael Jackson');

// YouTube Music answers with song uploads only: never the live recording.
const results = {
  'TaylorSwiftVEVO Anti-Hero (Official Music Video)': [info('fffffffffff', 'Anti-Hero (Acoustic)', 'Taylor Swift'), info('bbbbbbbbbbb', 'Anti-Hero', 'Taylor Swift')],
  'Taylor Swift Anti-Hero': [info('bbbbbbbbbbb', 'Anti-Hero', 'Taylor Swift')],
  'Tame Impala - Topic Loser': [info('ccccccccccc', 'Loser', 'Tame Impala')],
  'The Killers Mr. Brightside (Live at Wembley)': [info('ggggggggggg', 'Mr. Brightside', 'The Killers')],
  'michaeljacksonVEVO Michael Jackson - Chicago (Official Audio)': [info('iiiiiiiiiii', 'Chicago', 'Michael Jackson')],
  'Band Song': [info('kkkkkkkkkkk', 'Song', 'Band')],
  'Band Song (Live)': [info('kkkkkkkkkkk', 'Song', 'Band')],
};

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-upgrade-'));
  const stats = await new PlayStats(path.join(directory, 'stats.sqlite'), { logger: { info() {}, warn() {}, error() {} }, flushDelayMs: 1 }).open();
  t.after(async () => { stats.close(); await closeLibraries(); await fs.rm(directory, { recursive: true, force: true }); });
  const library = await openLibrary(path.join(directory, 'library.json'), { logger: { info() {}, warn() {}, error() {} } });
  // The same video played twice in history; stats show an official audio video.
  for (let play = 0; play < 2; play += 1) await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, { info: video });
  stats.finish(stats.begin({ guildId: '100', voiceChannelId: '300', track: { info: audioVideo }, requesterKind: 'user', requesterId: '200' }), { playedMs: 200_000, completed: true });
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
  return { directory, library, stats, node, queries, logger, run: options => upgradeSavedSongs({ library, stats, node, logger, pauseMs: 0, now: () => 0, ...options }) };
}

test('the deployed mode applies the reviewed upgrade', () => assert.equal(UPGRADE_MODE, 'apply'));

test('a dry run reports exact song matches once and changes nothing', async t => {
  const f = await setup(t);
  const before = await fs.readFile(f.library.filePath, 'utf8');
  const report = await f.run({ mode: 'dry-run' });
  assert.deepEqual({ ...report, changes: undefined }, { version: 1, mode: 'dry-run', finishedAt: new Date(0).toISOString(), checked: 6, current: 2, unmatched: 1, failed: 1, upgrades: 2, applied: null, changes: undefined });
  assert.deepEqual(report.changes, [
    { lists: ['favorites', 'mix', 'history'], from: { title: video.title, author: video.author, uri: video.uri }, to: { title: 'Anti-Hero', author: 'Taylor Swift', uri: song.uri } },
    { lists: ['stats'], from: { title: audioVideo.title, author: audioVideo.author, uri: audioVideo.uri }, to: { title: 'Chicago', author: 'Michael Jackson', uri: chicago.uri } },
  ]);
  assert.equal(f.stats.youtubeSongs()[0].ref.uri, audioVideo.uri);
  assert.equal(await fs.readFile(f.library.filePath, 'utf8'), before);
  const file = path.join(f.directory, UPGRADE_REPORT);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), report);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  // The log line carries counts, never titles or links.
  assert.deepEqual(f.logger.lines, [{ event: 'saved_song_upgrade', mode: 'dry-run', checked: 6, current: 2, unmatched: 1, failed: 1, upgrades: 2 }]);
  f.queries.length = 0;
  assert.equal(await f.run({ mode: 'dry-run' }), null);
  assert.deepEqual(f.queries, []);
});

test('applying backs up the library and upgrades favorites, mixes, history and play stats in place', async t => {
  const f = await setup(t);
  await f.run({ mode: 'dry-run' });
  const before = await fs.readFile(f.library.filePath, 'utf8');
  const report = await f.run({ mode: 'apply' });
  assert.deepEqual(report.applied, { favorites: 2, mixes: 1, history: 2, stats: 1 });
  assert.deepEqual(f.library.favorites('200'), [song, topic, live, soundcloud]);
  assert.deepEqual(f.library.favorites('201'), [song]);
  assert.deepEqual(f.library.readGuild('100').mixes.night.tracks, [offline, song]);
  // Both plays stay in history, now as the song.
  assert.deepEqual(f.library.readGuild('100').history.map(item => item.track), [song, song]);
  // The stats song keeps its key and plays and now shows the YouTube Music upload.
  const key = songKey(audioVideo);
  assert.equal(key, songKey(chicago));
  const row = f.stats.songs([key]).get(key);
  assert.deepEqual({ uri: row.uri, title: row.title, author: row.author, rank: row.rank }, { uri: chicago.uri, title: 'Chicago', author: 'Michael Jackson', rank: 38 });
  assert.equal(f.stats.serverFavorites('100', { visibleChannelIds: ['300'] }).onRepeat[0]?.track.uri, chicago.uri);
  assert.equal(await fs.readFile(`${f.library.filePath}.pre-song-upgrade-2.bak`, 'utf8'), before);
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
  assert.equal(f.stats.youtubeSongs()[0].ref.uri, audioVideo.uri);
});

test('upgradeList drops an upgraded entry when its song is already listed', () => {
  const list = [video, song, video];
  assert.equal(upgradeList(list, new Map([[`${video.uri} ${songKey(video)}`, song]])), 2);
  assert.deepEqual(list, [song]);
});

test('the undo record holds every previous stats row and history item before anything changes', async t => {
  const f = await setup(t);
  // Shutdown right after the undo record is written, before the first change.
  assert.equal(await f.run({ mode: 'apply', draining: () => existsSync(path.join(f.directory, UPGRADE_UNDO)) }), null);
  const undo = JSON.parse(await fs.readFile(path.join(f.directory, UPGRADE_UNDO), 'utf8'));
  const history = f.library.readGuild('100').history;
  assert.deepEqual(undo.history, history.map(item => ({ guildId: '100', id: item.id, track: video })));
  assert.deepEqual(undo.stats, [{ songKey: songKey(audioVideo), rank: 34, ...audioVideo }]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(f.directory, UPGRADE_UNDO))).mode & 0o777, 0o600);
  // Nothing changed yet, and a rerun keeps the first record.
  assert.equal(f.stats.youtubeSongs()[0].ref.uri, audioVideo.uri);
  const report = await f.run({ mode: 'apply' });
  assert.equal(report.applied.stats, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory, UPGRADE_UNDO), 'utf8')), undo);
});

test('a link saved under two song identities upgrades only the identity that matches', async t => {
  const f = await setup(t);
  const studio = { info: info('jjjjjjjjjjj', 'Song', 'Band').info };
  const live = { info: { ...studio.info, title: 'Song (Live)' } };
  for (const track of [studio, live]) {
    f.stats.finish(f.stats.begin({ guildId: '100', voiceChannelId: '300', track, requesterKind: 'user', requesterId: '200' }), { playedMs: 200_000, completed: true });
  }
  await f.library.updateFavorites('202', list => list.push(trackReference(live), trackReference(studio)));
  const report = await f.run({ mode: 'apply' });
  const rows = f.stats.songs([songKey(studio.info), songKey(live.info)]);
  assert.equal(rows.get(songKey(studio.info)).uri, 'https://www.youtube.com/watch?v=kkkkkkkkkkk');
  assert.equal(rows.get(songKey(live.info)).uri, studio.info.uri);
  assert.equal(rows.get(songKey(live.info)).title, 'Song (Live)');
  assert.deepEqual(f.library.favorites('202').map(ref => ref.title), ['Song (Live)', 'Song']);
  assert.equal(f.library.favorites('202')[1].uri, 'https://www.youtube.com/watch?v=kkkkkkkkkkk');
  assert.ok(report.changes.every(change => change.from.title !== 'Song (Live)'));
});

test('a rerun that finds more matches adds them to the undo record and keeps the originals', async t => {
  const f = await setup(t);
  const undoFile = path.join(f.directory, UPGRADE_UNDO);
  // The first attempt cannot reach the stats song's search, then shuts down before any change.
  const search = f.node.search;
  f.node.search = async query => { if (query.query.startsWith('michaeljacksonVEVO')) throw new Error('timeout'); return search(query); };
  assert.equal(await f.run({ mode: 'apply', draining: () => existsSync(undoFile) }), null);
  const first = JSON.parse(await fs.readFile(undoFile, 'utf8'));
  assert.deepEqual([first.history.length, first.stats.length], [2, 0]);
  f.node.search = search;
  const report = await f.run({ mode: 'apply' });
  assert.deepEqual(report.applied, { favorites: 2, mixes: 1, history: 2, stats: 1 });
  const undo = JSON.parse(await fs.readFile(undoFile, 'utf8'));
  assert.deepEqual(undo.history, first.history);
  assert.deepEqual(undo.stats, [{ songKey: songKey(audioVideo), rank: 34, ...audioVideo }]);
});
