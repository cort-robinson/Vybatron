import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeStats, PlayStats, STATS_LIMITS, STATS_SCHEMA_VERSION, StatsUnavailableError } from '../src/utils/play-stats.js';
import { songKey } from '../src/utils/song-identity.js';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;
const quiet = { error() {}, log() {} };

function song(id, title = `Song ${id}`, author = 'Artist - Topic') {
  return { info: { sourceName: 'youtube', identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, title, author, duration: 200_000, isStream: false } };
}

// Read-only inspection that closes its handle before temporary cleanup.
function inspect(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}

async function store(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-stats-'));
  const clock = { now: NOW };
  const file = path.join(directory, 'stats.sqlite');
  const stats = await new PlayStats(file, { now: () => clock.now, logger: quiet, flushDelayMs: 1, ...options }).open();
  t.after(async () => { stats.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { stats, clock, file, directory };
}

function play(stats, { guildId = '100', voiceChannelId = '300', track = song('aaaaaaaaaaa'), requesterKind = 'user', requesterId = '200', playedAt = NOW, ...end } = {}) {
  const handle = stats.begin({ guildId, voiceChannelId, track, requesterKind, requesterId: requesterKind === 'user' ? requesterId : null, playedAt });
  stats.finish(handle, { playedMs: 200_000, completed: true, ...end });
  return handle;
}

test('plays are durable across reopen with a versioned schema', async t => {
  const { stats, file, clock } = await store(t);
  play(stats, { requesterId: '200' });
  play(stats, { requesterId: '201', skipped: true, completed: false, playedMs: 5_000 });
  stats.close();
  const reopened = await new PlayStats(file, { now: () => clock.now, logger: quiet }).open();
  reopened.close();
  assert.equal(inspect(file, db => db.prepare('PRAGMA user_version').get().user_version), STATS_SCHEMA_VERSION);
  const rows = inspect(file, db => db.prepare('SELECT requester_id, played_ms, completed, skipped, origin FROM plays ORDER BY id').all().map(row => ({ ...row })));
  assert.deepEqual(rows, [
    { requester_id: '200', played_ms: 200_000, completed: 1, skipped: 0, origin: 'live' },
    { requester_id: '201', played_ms: 5_000, completed: 0, skipped: 1, origin: 'live' },
  ]);
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('only public catalog references are stored, with the most playable reference kept per song', async t => {
  const { stats, file } = await store(t);
  const video = song('bbbbbbbbbbb', 'Artist - Tune (Official Music Video)', 'ArtistVEVO');
  const topic = song('ccccccccccc', 'Tune', 'Artist - Topic');
  play(stats, { track: { ...video, encoded: 'secret', requester: { token: 'never' }, info: { ...video.info, uri: `${video.info.uri}&token=private` } } });
  play(stats, { track: topic });
  play(stats, { track: video, requesterId: '201' });
  stats.flush();
  const { songs, distinct, plays } = inspect(file, db => ({ songs: db.prepare('SELECT * FROM songs').all(),
    distinct: db.prepare('SELECT COUNT(DISTINCT song_key) AS n FROM plays').get().n, plays: db.prepare('SELECT * FROM plays').all() }));
  assert.equal(songs.length, 1);
  assert.equal(songs[0].uri, 'https://www.youtube.com/watch?v=ccccccccccc');
  assert.equal(distinct, 1);
  const dump = JSON.stringify(plays) + JSON.stringify(songs);
  assert.doesNotMatch(dump, /secret|never|private/);
  // Streams and references without a public catalog address are not songs.
  assert.equal(stats.begin({ guildId: '100', voiceChannelId: '300', track: { info: { ...topic.info, isStream: true } }, requesterKind: 'user', requesterId: '200' }), null);
  assert.equal(stats.begin({ guildId: '100', voiceChannelId: '300', track: { info: { ...topic.info, uri: 'https://example.com/a.mp3' } }, requesterKind: 'user', requesterId: '200' }), null);
});

test('server favorites include only plays in visible voice channels', async t => {
  const { stats } = await store(t);
  play(stats, { track: song('public00001'), voiceChannelId: '300', requesterId: '200' });
  play(stats, { track: song('public00001'), voiceChannelId: '300', requesterId: '201' });
  play(stats, { track: song('hidden00001'), voiceChannelId: '301', requesterId: '200' });
  play(stats, { track: song('hidden00001'), voiceChannelId: '301', requesterId: '201' });
  play(stats, { track: song('hidden00001'), voiceChannelId: '301', requesterId: '202' });
  play(stats, { track: song('otherguild1'), guildId: '101', voiceChannelId: '300' });
  assert.deepEqual(stats.voiceChannelIds('100').sort(), ['300', '301']);
  const visible = stats.serverFavorites('100', { visibleChannelIds: ['300'] });
  assert.deepEqual(visible.onRepeat.map(entry => entry.track.identifier), ['public00001']);
  assert.equal(visible.onRepeat[0].plays, 2);
  const everything = stats.serverFavorites('100', { visibleChannelIds: ['300', '301'] });
  assert.deepEqual(everything.onRepeat.map(entry => entry.track.identifier), ['hidden00001', 'public00001']);
  assert.deepEqual(stats.serverFavorites('100', { visibleChannelIds: [] }), { onRepeat: [], forgottenGems: [] });
  assert.deepEqual(stats.topTracks('100', '200', { visibleChannelIds: ['300'] }).map(entry => entry.track.identifier), ['public00001']);
});

test('forgotten gems surface earlier favorites without recent plays', async t => {
  const { stats } = await store(t);
  for (const requesterId of ['200', '201', '202']) play(stats, { track: song('gemgemgem01'), requesterId, playedAt: NOW - 90 * DAY });
  for (const requesterId of ['200', '201', '202']) play(stats, { track: song('stillplayed'), requesterId, playedAt: NOW - 90 * DAY });
  play(stats, { track: song('stillplayed'), playedAt: NOW - DAY });
  const { forgottenGems } = stats.serverFavorites('100', { visibleChannelIds: ['300'] });
  assert.deepEqual(forgottenGems.map(entry => entry.track.identifier), ['gemgemgem01']);
});

test('personal stats come from the listener’s own requests', async t => {
  const { stats } = await store(t);
  const a = song('aaaaaaaaaaa', 'Alpha', 'First Artist - Topic'); const b = song('bbbbbbbbbbb', 'Beta', 'First Artist - Topic'); const c = song('ccccccccccc', 'Gamma', 'Second Artist - Topic');
  for (let i = 0; i < 3; i++) play(stats, { track: a, playedAt: NOW - i * DAY });
  play(stats, { track: b, playedAt: NOW - 2 * DAY });
  play(stats, { track: c, playedAt: NOW - 40 * DAY });
  play(stats, { track: c, requesterId: '201' });
  play(stats, { track: c, requesterKind: 'autoplay' });
  play(stats, { track: b, skipped: true, completed: false, playedMs: 3000 });
  const visibleChannelIds = ['300'];
  assert.deepEqual(stats.topTracks('100', '200', { visibleChannelIds, since: NOW - 30 * DAY }).map(entry => [entry.track.title, entry.plays]), [['Alpha', 3], ['Beta', 1]]);
  assert.deepEqual(stats.topTracks('100', '200', { visibleChannelIds }).map(entry => entry.track.title), ['Alpha', 'Beta', 'Gamma']);
  const artists = stats.topArtists('100', '200', { visibleChannelIds });
  assert.deepEqual(artists.map(artist => [artist.artist, artist.plays, artist.track.title]), [['First Artist', 4, 'Alpha'], ['Second Artist', 1, 'Gamma']]);
  const favorites = [b.info, c.info, a.info, song('ddddddddddd', 'Delta', 'Never Requested - Topic').info].map(info => ({ ...info }));
  const rediscover = stats.rediscover('200', favorites, { now: NOW });
  assert.deepEqual(rediscover.map(item => [item.track.title, item.index, item.requests, item.lastRequestedAt]), [['Gamma', 2, 1, NOW - 40 * DAY], ['Delta', 4, 0, null]]);
});

test('clearing request stats removes the requester everywhere but keeps anonymized server totals', async t => {
  const { stats, file } = await store(t);
  play(stats, { requesterId: '200' });
  play(stats, { requesterId: '200', guildId: '101' });
  play(stats, { requesterId: '201' });
  const pending = stats.begin({ guildId: '100', voiceChannelId: '300', track: song('aaaaaaaaaaa'), requesterKind: 'user', requesterId: '200' });
  assert.equal(stats.clearRequests('200'), 3, 'pending writes are flushed before clearing');
  stats.finish(pending, { playedMs: 1000 });
  stats.flush();
  assert.deepEqual(stats.topTracks('100', '200', { visibleChannelIds: ['300'] }), []);
  assert.deepEqual(stats.rediscover('200', [song('aaaaaaaaaaa').info], { now: NOW }).map(item => item.requests), [0]);
  assert.equal(stats.serverFavorites('100', { visibleChannelIds: ['300'] }).onRepeat[0].plays, 3);
  assert.equal(inspect(file, db => db.prepare("SELECT COUNT(*) AS n FROM plays WHERE requester_id = '200'").get().n), 0);
  assert.equal(inspect(file, db => db.prepare("SELECT COUNT(*) AS n FROM plays WHERE requester_kind = 'cleared'").get().n), 3);
});

test('backfill imports library history once as unattended plays', async t => {
  const { stats, file } = await store(t);
  const history = [
    { id: 'h1', playedAt: NOW - DAY, voiceChannelId: '300', track: { ...song('aaaaaaaaaaa').info } },
    { id: 'h2', playedAt: NOW - 2 * DAY, voiceChannelId: '301', track: { ...song('bbbbbbbbbbb').info } },
    { id: 'bad', playedAt: NOW, voiceChannelId: 'not-an-id', track: { ...song('ccccccccccc').info } },
  ];
  assert.equal(stats.backfill([['100', history], ['bad', history]]), 2);
  assert.equal(stats.backfill([['100', history]]), 0, 'idempotent across restarts');
  assert.deepEqual(inspect(file, db => db.prepare('SELECT history_id, requester_kind, requester_id, origin, played_ms FROM plays ORDER BY history_id').all().map(row => ({ ...row }))), [
    { history_id: 'h1', requester_kind: 'unknown', requester_id: null, origin: 'backfill', played_ms: null },
    { history_id: 'h2', requester_kind: 'unknown', requester_id: null, origin: 'backfill', played_ms: null },
  ]);
  // Half weight for an unknown requester, decayed by one day of a 14-day half-life.
  assert.equal(stats.serverFavorites('100', { visibleChannelIds: ['300'] }).onRepeat[0].score, 0.476);
});

test('pruning bounds rows by retention, per server, in total and by file size', async t => {
  const limits = { ...STATS_LIMITS, guildPlays: 30, totalPlays: 50 };
  const { stats, file, clock } = await store(t, { limits });
  play(stats, { playedAt: NOW - 366 * DAY });
  play(stats, { playedAt: NOW + 2 * DAY });
  for (let i = 0; i < 40; i++) play(stats, { guildId: '100', track: song(`a${String(i).padStart(10, '0')}`), playedAt: NOW - i * 1000 });
  for (let i = 0; i < 40; i++) play(stats, { guildId: '101', track: song(`b${String(i).padStart(10, '0')}`), playedAt: NOW - 100_000 - i * 1000 });
  stats.prune();
  const counts = inspect(file, db => Object.fromEntries(db.prepare('SELECT guild_id, COUNT(*) AS n FROM plays GROUP BY guild_id').all().map(row => [row.guild_id, row.n])));
  assert.deepEqual(counts, { 100: 30, 101: 20 });
  assert.equal(inspect(file, db => db.prepare('SELECT MIN(played_at) AS t FROM plays WHERE guild_id = ?').get('100').t), NOW - 29_000, 'newest plays survive');
  assert.equal(inspect(file, db => db.prepare('SELECT COUNT(*) AS n FROM songs').get().n), 50, 'orphaned songs are removed');
  // The size guard sheds the oldest plays until the file fits its budget.
  stats.limits = { ...limits, bytes: 1 };
  clock.now += 1;
  stats.prune();
  assert.ok(inspect(file, db => db.prepare('SELECT COUNT(*) AS n FROM plays').get().n) < 50);
});

test('stats writes never throw, even when SQLite fails', async t => {
  const { stats } = await store(t);
  let logged = 0;
  stats.logger = { error() { logged++; } };
  stats.statements.insertPlay = { run() { throw new Error('disk I/O error'); } };
  const handle = stats.begin({ guildId: '100', voiceChannelId: '300', track: song('aaaaaaaaaaa'), requesterKind: 'user', requesterId: '200' });
  assert.doesNotThrow(() => stats.finish(handle, { playedMs: 1000 }));
  assert.doesNotThrow(() => stats.flush());
  assert.equal(stats.status().writeFailures, 1);
  assert.equal(logged, 1);
  stats.db.close();
  assert.doesNotThrow(() => play(stats));
  assert.doesNotThrow(() => stats.flush());
  assert.doesNotThrow(() => stats.prune());
  assert.ok(stats.status().writeFailures >= 2);
  stats.available = false; stats.db = null;
  assert.equal(stats.begin({ guildId: '100', voiceChannelId: '300', track: song('aaaaaaaaaaa'), requesterKind: 'user', requesterId: '200' }), null);
  assert.throws(() => stats.serverFavorites('100'), StatsUnavailableError);
});

test('bounded pending writes drop rather than grow without limit', async t => {
  const { stats } = await store(t, { limits: { ...STATS_LIMITS, pendingWrites: 3 }, flushDelayMs: 60_000 });
  for (let i = 0; i < 5; i++) stats.begin({ guildId: '100', voiceChannelId: '300', track: song('aaaaaaaaaaa'), requesterKind: 'user', requesterId: '200' });
  assert.equal(stats.status().pendingWrites, 3);
  assert.equal(stats.status().droppedWrites, 2);
});

test('a newer or damaged store is left untouched and stats start disabled', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-stats-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const newer = path.join(directory, 'newer.sqlite');
  const db = new DatabaseSync(newer); db.exec(`PRAGMA user_version = ${STATS_SCHEMA_VERSION + 1}; CREATE TABLE future (x);`); db.close();
  const before = await fs.readFile(newer);
  await assert.rejects(new PlayStats(newer, { logger: quiet }).open(), /newer release/);
  assert.deepEqual(await fs.readFile(newer), before);

  const damaged = path.join(directory, 'stats.sqlite');
  await fs.writeFile(damaged, 'not a database'.repeat(100));
  const evidence = await fs.readFile(damaged);
  const errors = [];
  const client = { library: { guildIds: () => [], readGuild: () => ({ history: [] }) } };
  const stats = await initializeStats(client, { dataDir: directory, logger: { error: line => errors.push(line), log() {} } });
  assert.equal(stats.available, false);
  assert.equal(client.stats, stats);
  assert.match(errors.join('\n'), /stats_unavailable/);
  assert.doesNotMatch(errors.join('\n'), /not a database/, 'logs carry no raw error text');
  assert.deepEqual(await fs.readFile(damaged), evidence);
  assert.equal(client.playTracker.started({ guildId: '100', voiceChannelId: '300' }, song('aaaaaaaaaaa')), undefined);
});

test('initialization backfills from the library and closes to a single file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-stats-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const history = [{ id: 'h1', playedAt: Date.now() - DAY, voiceChannelId: '300', track: { ...song('aaaaaaaaaaa').info } }];
  const client = { library: { guildIds: () => ['100'], readGuild: () => ({ history }) } };
  const stats = await initializeStats(client, { dataDir: directory, logger: quiet });
  assert.equal(stats.serverFavorites('100', { visibleChannelIds: ['300'] }).onRepeat[0].songKey, songKey(song('aaaaaaaaaaa').info));
  stats.close();
  assert.deepEqual((await fs.readdir(directory)).sort(), ['stats.sqlite']);
});
