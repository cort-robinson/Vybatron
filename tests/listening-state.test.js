import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateLibrary, trackReference, LIBRARY_LIMITS, LISTENING_STATE_BACKUP, ACTIVITY_RETENTION_MS, HISTORY_RETENTION_MS } from '../src/utils/library.js';
import { ListeningState, LISTENING_STATE_SCHEMA_VERSION } from '../src/utils/listening-state.js';
import { savedSession } from '../src/utils/sessions.js';
import { openLibrary, closeLibraries } from './library-fixture.js';
import { track } from './fixtures.js';

const id = n => String(n).padStart(11, '0');
const historyItem = (n, playedAt, voiceChannelId = '300') => ({ id: `h${n}`, playedAt, voiceChannelId, track: trackReference(track(id(n))) });
const activityItem = (n, at) => ({ id: `a${n}`, at, actor: { id: '200', displayName: 'Listener' }, action: 'queue', detail: 'Listening queue updated.' });
const checkpoint = (savedAt = Date.now(), overrides = {}) => ({ voiceChannelId: '300', textChannelId: '400', savedAt, tracks: [trackReference(track())],
  position: 8000, volume: 75, paused: true, repeatMode: 'queue', ...overrides });

// A library.json as a release before ADR-0009 writes it.
function olderDocument(now = Date.now()) {
  return { version: 2, favorites: { '200': [trackReference(track('favoriteaaa'))] }, favoriteOverflow: {}, guilds: { '100': {
    settings: { volume: 80, fairQueue: false, djRoleId: null, musicTextChannelId: null, autoplay: 'off' }, mixes: {},
    history: [historyItem(2, now - 1000, '301'), historyItem(1, now - 2000)], activity: [activityItem(1, now - 500)], session: checkpoint(now - 3000),
  } } };
}
// What an older image sees after a rollback: the unchanged v2 validator and the guild fields.
async function olderImageReads(filePath) { return migrateLibrary(JSON.parse(await fs.readFile(filePath, 'utf8'))).guilds['100']; }

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-listening-'));
  t.after(async () => { await closeLibraries(); await fs.rm(dir, { recursive: true, force: true }); });
  const logs = [];
  const logger = { error: line => logs.push(JSON.parse(line).event), log() {} };
  return { dir, filePath: path.join(dir, 'library.json'), statePath: path.join(dir, 'listening-state.sqlite'), logs, logger };
}

test('first start adopts history, activity and the checkpoint after a byte-exact backup, without rewriting library.json', async t => {
  const { dir, filePath } = await fixture(t);
  const original = JSON.stringify(olderDocument());
  await fs.writeFile(filePath, original);
  const library = await openLibrary(filePath);
  const guild = library.readGuild('100');
  assert.deepEqual(guild.history.map(item => [item.id, item.voiceChannelId]), [['h2', '301'], ['h1', '300']]);
  assert.deepEqual(guild.activity.map(item => item.id), ['a1']);
  assert.equal(savedSession(library, '100').position, 8000);
  assert.equal(guild.settings.volume, 80);
  assert.equal(await fs.readFile(filePath, 'utf8'), original, 'migration never rewrites library.json');
  assert.equal(await fs.readFile(`${filePath}${LISTENING_STATE_BACKUP}`, 'utf8'), original);

  // Idempotent: a restart adopts nothing and keeps the first backup.
  await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track('newtrackaaa'));
  await library.saveSession('100', null);
  await fs.writeFile(`${filePath}${LISTENING_STATE_BACKUP}`, 'first backup');
  library.state.close();
  const restarted = await openLibrary(filePath);
  assert.equal(restarted.readGuild('100').history.length, 3);
  assert.equal(savedSession(restarted, '100'), null, 'the stale mirror does not revive a cleared checkpoint');
  assert.equal(await fs.readFile(`${filePath}${LISTENING_STATE_BACKUP}`, 'utf8'), 'first backup');
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.bak')).length, 1);
});

test('track starts, activity and checkpoints never rewrite library.json', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  let replacements = 0;
  const library = await openLibrary(filePath, { io: { ...fs, rename: async (from, to) => { if (to === filePath) replacements += 1; return fs.rename(from, to); } } });
  for (let n = 0; n < 5; n++) await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track(id(n)));
  await library.recordActivity('100', { id: '200', username: 'Listener' }, 'queue');
  await library.saveSession('100', checkpoint());
  await library.updateGuild('100', guild => { guild.session = null; });
  assert.equal(replacements, 0);
  await library.updateGuild('100', guild => { guild.settings.volume = 50; });
  assert.equal(replacements, 1, 'settings still save to library.json');
  assert.equal(library.readGuild('100').history.length, 7);
});

test('shutdown mirrors the latest state so an older image keeps history and can restore the session', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  const library = await openLibrary(filePath);
  await library.recordHistory({ guildId: '100', voiceChannelId: '302' }, track('latesttrack'));
  await library.recordActivity('100', { id: '201', username: 'Second' }, 'settings');
  const latest = checkpoint(Date.now(), { position: 42_000 });
  await library.saveSession('100', latest);
  await library.close();
  const older = await olderImageReads(filePath);
  assert.deepEqual(older.history.map(item => item.track.identifier), ['latesttrack', id(2), id(1)]);
  assert.equal(older.history[0].voiceChannelId, '302');
  assert.equal(older.activity[0].actor.id, '201');
  assert.deepEqual(older.session, latest);
});

test('a roll-forward adopts what an older image wrote, and restarts without one keep the store', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  const library = await openLibrary(filePath);
  await library.close();

  // The older image after a rollback: plays a track, records activity and stops.
  const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
  document.guilds['100'].history.unshift(historyItem(9, Date.now(), '303'));
  document.guilds['100'].activity.unshift(activityItem(9, Date.now()));
  document.guilds['100'].session = null;
  document.guilds['100'].settings.volume = 30;
  await fs.writeFile(filePath, JSON.stringify(document));

  const rolledForward = await openLibrary(filePath);
  const guild = rolledForward.readGuild('100');
  assert.deepEqual(guild.history.map(item => item.id), ['h9', 'h2', 'h1']);
  assert.deepEqual(guild.activity.map(item => item.id), ['a9', 'a1']);
  assert.equal(guild.session, null, 'the older image stopped the session');
  assert.equal(guild.settings.volume, 30);

  // A crash leaves the mirror behind the store; the next start must not adopt it.
  await rolledForward.saveSession('100', checkpoint(Date.now(), { position: 1000 }));
  rolledForward.state.close();
  assert.equal(savedSession(await openLibrary(filePath), '100').position, 1000);
});

test('a Deploy rollback that quarantines the store rebuilds it from library.json on the next release', async t => {
  const { filePath, statePath } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  const library = await openLibrary(filePath);
  await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track('beforeclose'));
  await library.close();
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${statePath}${suffix}`, { force: true });
  const rebuilt = await openLibrary(filePath);
  assert.deepEqual(rebuilt.readGuild('100').history.map(item => item.track.identifier), ['beforeclose', id(2), id(1)]);
  assert.equal(savedSession(rebuilt, '100').position, 8000);
});

test('an unreadable or newer store never blocks startup and is left untouched', async t => {
  for (const kind of ['corrupt', 'newer']) await t.test(kind, async t => {
    const { filePath, statePath, logs, logger } = await fixture(t);
    await fs.writeFile(filePath, JSON.stringify(olderDocument()));
    if (kind === 'corrupt') await fs.writeFile(statePath, 'not a database '.repeat(100));
    else { const db = new DatabaseSync(statePath); db.exec(`PRAGMA user_version = ${LISTENING_STATE_SCHEMA_VERSION + 1}`); db.close(); }
    const before = await fs.readFile(statePath);
    const library = await openLibrary(filePath, { logger });
    assert.equal(library.state.durable, false);
    assert.deepEqual(logs, ['listening_state_unavailable']);
    assert.equal(library.readGuild('100').history.length, 2, 'runs from the library.json mirror');
    await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track('inmemoryaaa'));
    await library.close();
    assert.deepEqual(await fs.readFile(statePath), before);
    assert.equal((await olderImageReads(filePath)).history[0].track.identifier, 'inmemoryaaa', 'memory state survives through library.json');
  });
});

test('a failed or interrupted backup defers the migration without blocking startup', async t => {
  const { dir, filePath, logs, logger } = await fixture(t);
  const original = JSON.stringify(olderDocument());
  await fs.writeFile(filePath, original);
  // The backup write dies part way through, as on a full disk.
  const io = { ...fs, open: async (file, ...args) => {
    const handle = await fs.open(file, ...args);
    if (!file.includes(LISTENING_STATE_BACKUP)) return handle;
    return { writeFile: async () => { await handle.writeFile(original.slice(0, 16)); throw Object.assign(new Error('private'), { code: 'ENOSPC' }); }, sync: () => handle.sync(), close: () => handle.close() };
  } };
  const degraded = await openLibrary(filePath, { io, logger });
  assert.equal(degraded.state.durable, false);
  assert.deepEqual(logs, ['listening_state_unavailable']);
  assert.equal(degraded.readGuild('100').history.length, 2, 'playback history still works from library.json');
  degraded.state.close();
  assert.equal(await fs.readFile(filePath, 'utf8'), original);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.bak')), [], 'no partial backup is published');

  const library = await openLibrary(filePath);
  assert.equal(library.state.durable, true);
  assert.equal(library.readGuild('100').history.length, 2);
  assert.equal(await fs.readFile(`${filePath}${LISTENING_STATE_BACKUP}`, 'utf8'), original);
});

test('a store failure after it opens still falls back to memory instead of stopping startup', async t => {
  const { filePath, logs, logger } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  // The disk fills after the file opens: recording the migration marker fails.
  class FullDisk extends DatabaseSync {
    constructor(location, ...rest) { super(location, ...rest); this.onDisk = location !== ':memory:'; }
    prepare(sql) { if (this.onDisk && sql.startsWith('INSERT INTO meta')) throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' }); return super.prepare(sql); }
  }
  const broken = await openLibrary(filePath, { logger, sqlite: { DatabaseSync: FullDisk } });
  assert.equal(broken.state.durable, false);
  assert.deepEqual(logs, ['listening_state_unavailable']);
  assert.equal(savedSession(broken, '100').position, 8000);
});

test('listening state shares the library size cap, so the shutdown mirror always fits', async t => {
  const { filePath, statePath } = await fixture(t);
  const library = await openLibrary(filePath);
  const queue = Array.from({ length: LIBRARY_LIMITS.queue + 1 }, (_, n) => trackReference(track(id(n))));
  let saved = 0;
  for (let guild = 100; guild < 200; guild++) {
    try { await library.saveSession(String(guild), checkpoint(Date.now(), { tracks: queue })); saved += 1; }
    catch (error) { assert.match(error.message, /Music library is full/); break; }
  }
  assert.ok(saved > 0 && saved < 100, `${saved} checkpoints fit`);
  assert.equal(library.readGuild(String(100 + saved)).session, null, 'a rejected write leaves nothing behind');
  await assert.rejects(library.updateFavorites('200', list => { list.push(...queue.slice(0, 500)); }), /Music library is full/, 'favorites count the mirror too');
  await library.close();
  const json = await fs.readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(json) <= LIBRARY_LIMITS.bytes);
  assert.equal(Object.values(JSON.parse(json).guilds).filter(guild => guild.session).length, saved, 'every accepted checkpoint reached the mirror');
  assert.ok((await fs.stat(statePath)).size <= 8 * 1024 * 1024, 'the store stays inside its snapshot budget');
});

test('a mirror that cannot be written is logged and never overrides newer state', async t => {
  const { filePath, logs, logger } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  const library = await openLibrary(filePath, { logger });
  await library.saveSession('100', checkpoint(Date.now(), { position: 77_000 }));
  library.io = { ...fs, rename: async () => { throw Object.assign(new Error('private'), { code: 'ENOSPC' }); } };
  await library.close();
  assert.deepEqual(logs, ['listening_state_mirror_failed']);
  assert.equal((await olderImageReads(filePath)).session.position, 8000, 'the previous mirror is still valid');
  assert.equal(savedSession(await openLibrary(filePath), '100').position, 77_000);
});

test('history keeps 100 recent plays for 30 days per server; activity keeps 24 hours', async t => {
  const { filePath } = await fixture(t);
  const library = await openLibrary(filePath);
  const now = Date.now();
  for (let n = 0; n < LIBRARY_LIMITS.history + 5; n++) await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track(id(n)));
  await library.recordHistory({ guildId: '101', voiceChannelId: '300' }, track('otherguilda'));
  const history = library.readGuild('100').history;
  assert.equal(history.length, LIBRARY_LIMITS.history);
  assert.equal(history[0].track.identifier, id(LIBRARY_LIMITS.history + 4), 'newest first');
  assert.equal(library.readGuild('101').history.length, 1);
  await library.updateGuild('100', guild => {
    guild.history = [historyItem(1, now - 31 * 24 * 60 * 60_000), historyItem(2, now - 1000)];
    guild.activity = [activityItem(1, now - 25 * 60 * 60_000), activityItem(2, now - 1000)];
  });
  assert.deepEqual(library.readGuild('100').history.map(item => item.id), ['h2']);
  assert.deepEqual(library.readGuild('100').activity.map(item => item.id), ['a2']);
  await assert.rejects(library.updateGuild('100', guild => { guild.session = { ...checkpoint(), volume: 999 }; }), /Invalid saved listening session/);
  await assert.rejects(library.saveSession('100', { ...checkpoint(), tracks: [] }), /Invalid saved listening session/);
});

test('the size guard sheds the oldest history before any checkpoint', async t => {
  const { statePath } = await fixture(t);
  const retention = { history: { maxAgeMs: Infinity, limit: 1000 }, activity: { maxAgeMs: Infinity, limit: 1000 } };
  const state = await new ListeningState(statePath, { retention, limits: { bytes: 128 * 1024 } }).open();
  try {
    const now = Date.now();
    state.setSession('100', checkpoint(now));
    for (let n = 0; n < 600; n++) state.add('history', '100', historyItem(n, now - 600 + n), now);
    state.prune(now);
    const kept = state.read('100', now).history;
    assert.ok(state.usedBytes() <= 128 * 1024);
    assert.ok(kept.length > 0 && kept.length < 600);
    assert.equal(kept[0].id, 'h599', 'the newest plays survive');
    assert.notEqual(state.read('100', now).session, null);
  } finally { state.close(); }
});

test('a checkpoint that fails at shutdown does not stop the mirror or leave the store open', async t => {
  const { filePath, logs, logger } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify(olderDocument()));
  const library = await openLibrary(filePath, { logger });
  await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track('lastplayeda'));
  library.stopSnapshots = async () => { throw new Error('Music library is full. Remove unused favorites or mixes.'); };
  await library.close();
  assert.deepEqual(logs, ['listening_state_checkpoint_failed']);
  assert.equal(library.state.db, null);
  assert.equal((await olderImageReads(filePath)).history[0].track.identifier, 'lastplayeda');
});

test('adopting a nearly full older mirror sheds the oldest history so the mirror still fits', async t => {
  const { filePath } = await fixture(t);
  const now = Date.now();
  await fs.writeFile(filePath, JSON.stringify(olderDocument(now)));
  const library = await openLibrary(filePath);
  for (let n = 0; n < LIBRARY_LIMITS.history; n++) await library.recordHistory({ guildId: '100', voiceChannelId: '300' }, track(id(n)));
  library.state.close(); // a crash: the store holds 100 plays the mirror never saw

  // The older image after a rollback fills favorites up to its own cap and clears the session.
  const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
  document.guilds['100'].session = null;
  const filler = Array.from({ length: LIBRARY_LIMITS.favorites }, (_, n) => trackReference(track(id(n))));
  for (let user = 201; Buffer.byteLength(JSON.stringify(document)) < LIBRARY_LIMITS.bytes - 4096; user++) {
    document.favorites[String(user)] = filler.slice(0, Math.min(LIBRARY_LIMITS.favorites, Math.floor((LIBRARY_LIMITS.bytes - 4096 - Buffer.byteLength(JSON.stringify(document))) / 200) || 1));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(document)) <= LIBRARY_LIMITS.bytes);
  await fs.writeFile(filePath, JSON.stringify(document));

  const rolledForward = await openLibrary(filePath);
  assert.ok(rolledForward.projectedBytes() <= LIBRARY_LIMITS.bytes);
  const history = rolledForward.readGuild('100').history;
  assert.ok(history.length > 0 && history.length < LIBRARY_LIMITS.history, `${history.length} plays kept`);
  assert.equal(history[0].track.identifier, id(LIBRARY_LIMITS.history - 1), 'the newest plays survive');
  assert.equal(rolledForward.readGuild('100').session, null);
  await rolledForward.close();
  assert.equal((await olderImageReads(filePath)).history[0].track.identifier, id(LIBRARY_LIMITS.history - 1), 'the mirror was written');
});

test('expired listening state stops counting toward the size cap', async t => {
  const { filePath } = await fixture(t);
  const library = await openLibrary(filePath);
  const empty = library.projectedBytes();
  await library.updateGuild('150', guild => { guild.activity = [activityItem(1, Date.now() - ACTIVITY_RETENTION_MS + 50)]; });
  assert.ok(library.projectedBytes() > empty);
  await new Promise(resolve => setTimeout(resolve, 100));
  library.maintain();
  assert.equal(library.projectedBytes(), empty);
});

test('the server limit counts servers that only have listening state', async t => {
  const { filePath } = await fixture(t);
  const library = await openLibrary(filePath);
  for (let n = 0; n < LIBRARY_LIMITS.guilds; n++) await library.recordHistory({ guildId: String(1000 + n), voiceChannelId: '300' }, track());
  await assert.rejects(library.recordHistory({ guildId: '99999', voiceChannelId: '300' }, track()), /server limit/);
  await assert.rejects(library.updateGuild('99999', guild => { guild.settings.volume = 10; }), /server limit/);
  await library.updateGuild('1000', guild => { guild.settings.volume = 10; });
  assert.equal(library.settings('1000').volume, 10);
});

test('space freed by expired history in a frozen mirror is usable for favorites again', async t => {
  const { filePath } = await fixture(t);
  const old = Date.now() - HISTORY_RETENTION_MS - 60_000;
  const document = olderDocument();
  for (let guild = 100; guild < 110; guild++) {
    document.guilds[String(guild)] = { ...structuredClone(document.guilds['100']), session: null, activity: [],
      history: Array.from({ length: LIBRARY_LIMITS.history }, (_, n) => historyItem(guild * 1000 + n, old - n)) };
  }
  const filler = Array.from({ length: LIBRARY_LIMITS.favorites }, (_, n) => trackReference(track(id(n))));
  // Fill favorites to within 2 KB of the cap; the expired history is what fills the rest.
  const perUser = Buffer.byteLength(JSON.stringify(filler)) + 10, perTrack = Buffer.byteLength(JSON.stringify(filler[0])) + 1;
  let size = Buffer.byteLength(JSON.stringify(document));
  for (let user = 201; size + perUser < LIBRARY_LIMITS.bytes - 2000; user++, size += perUser) document.favorites[String(user)] = filler;
  document.favorites['199'] = filler.slice(0, Math.floor((LIBRARY_LIMITS.bytes - 2000 - size) / perTrack));
  assert.ok(Buffer.byteLength(JSON.stringify(document)) <= LIBRARY_LIMITS.bytes);
  await fs.writeFile(filePath, JSON.stringify(document));

  const library = await openLibrary(filePath);
  assert.equal(library.readGuild('105').history.length, 0, 'expired history is gone');
  await library.updateFavorites('300', list => { list.push(...filler.slice(0, 20)); });
  const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(saved.favorites['300'].length, 20);
  assert.equal(saved.guilds['105'].history.length, 0, 'the refreshed mirror was written');
  library.state.close();
  const reopened = await openLibrary(filePath);
  assert.equal(savedSession(reopened, '100'), null, 'the refreshed mirror is recorded, so nothing stale is adopted');
});

test('adoption never leaves more servers than the library allows', async t => {
  const { filePath } = await fixture(t);
  await fs.writeFile(filePath, JSON.stringify({ version: 2, guilds: {}, favorites: {}, favoriteOverflow: {} }));
  const library = await openLibrary(filePath);
  for (let n = 0; n < LIBRARY_LIMITS.guilds; n++) await library.recordHistory({ guildId: String(1000 + n), voiceChannelId: '300' }, track());
  library.state.close(); // a crash: none of these servers reached the mirror

  // The older image after a rollback adds settings for a new server.
  const document = JSON.parse(await fs.readFile(filePath, 'utf8'));
  document.guilds['5'] = { settings: { volume: 20, fairQueue: false, djRoleId: null, musicTextChannelId: null, autoplay: 'off' }, mixes: {}, history: [], activity: [], session: null };
  await fs.writeFile(filePath, JSON.stringify(document));

  const rolledForward = await openLibrary(filePath);
  const ids = rolledForward.guildIds();
  assert.equal(ids.length, LIBRARY_LIMITS.guilds);
  assert.ok(ids.includes('5') && !ids.includes('1000'), 'the least recently active listening-only server is dropped');
  assert.equal(rolledForward.settings('5').volume, 20);
  await rolledForward.close();
  assert.equal(Object.keys(JSON.parse(await fs.readFile(filePath, 'utf8')).guilds).length, LIBRARY_LIMITS.guilds, 'the mirror was written');
});
