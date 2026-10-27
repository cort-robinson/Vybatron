import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logEvent } from '../runtime.js';

export const LISTENING_STATE_LIMITS = Object.freeze({
  // Shares the 64 MiB pre-deploy volume snapshot with the library and stats (ADR-0009).
  bytes: 8 * 1024 * 1024,
});

// Each entry upgrades the previous schema version inside one transaction.
const MIGRATIONS = [
  `CREATE TABLE history (
    seq INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    item TEXT NOT NULL,
    UNIQUE (guild_id, id)
  ) STRICT;
  CREATE INDEX history_recent ON history (guild_id, played_at DESC, seq DESC);
  CREATE TABLE activity (
    seq INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    item TEXT NOT NULL,
    UNIQUE (guild_id, id)
  ) STRICT;
  CREATE INDEX activity_recent ON activity (guild_id, at DESC, seq DESC);
  CREATE TABLE sessions (guild_id TEXT PRIMARY KEY, saved_at REAL NOT NULL, session TEXT NOT NULL) STRICT;
  CREATE TABLE mirrors (guild_id TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
];
export const LISTENING_STATE_SCHEMA_VERSION = MIGRATIONS.length;

/** Digest of one guild's mirrored fields in library.json. */
export function mirrorDigest({ history = [], activity = [], session = null } = {}) {
  return createHash('sha256').update(JSON.stringify([history, activity, session])).digest('hex');
}
const EMPTY_DIGEST = mirrorDigest();

// Server history, actor activity and session checkpoints (ADR-0009). Retention
// windows and item limits are supplied by the library, which owns validation.
// A store that cannot open runs from memory instead, so it never blocks startup.
export class ListeningState {
  constructor(filePath, { retention, sqlite, logger = console, limits = LISTENING_STATE_LIMITS } = {}) {
    Object.assign(this, { filePath, retention, sqlite, logger, limits });
    this.db = null; this.durable = false; this.depth = 0;
  }

  async open() {
    this.DatabaseSync = (this.sqlite || await import('node:sqlite')).DatabaseSync;
    if (this.filePath === ':memory:') return this.openMemory();
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Owner-only before SQLite creates it; WAL and SHM files inherit the mode.
      closeSync(openSync(this.filePath, 'a', 0o600));
      this.db = this.migrate(new this.DatabaseSync(this.filePath), true);
      this.durable = true;
      this.prepare();
    } catch (error) { this.fallBack(error); }
    return this;
  }

  // Leaves the file untouched for an operator and keeps running from memory.
  fallBack(error) {
    logEvent(this.logger, 'error', 'listening_state_unavailable', error);
    try { this.db?.close(); } catch {}
    this.openMemory();
  }

  openMemory() {
    this.db = this.migrate(new this.DatabaseSync(':memory:'), false);
    this.durable = false; this.depth = 0;
    this.prepare();
    return this;
  }

  migrate(db, durable) {
    try {
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA temp_store = MEMORY;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > LISTENING_STATE_SCHEMA_VERSION) throw new Error('Listening state was written by a newer release.');
      if (version > 0 && db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Listening state failed an integrity check.');
      if (durable) {
        if (version === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 1048576;');
      }
      for (let next = version; next < LISTENING_STATE_SCHEMA_VERSION; next++) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(MIGRATIONS[next]); db.exec(`PRAGMA user_version = ${next + 1}`); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      return db;
    } catch (error) { db.close(); throw error; }
  }

  prepare() {
    const sql = text => this.db.prepare(text);
    this.statements = {
      history: sql('SELECT item FROM history WHERE guild_id = ? AND played_at >= ? AND played_at <= ? ORDER BY played_at DESC, seq DESC LIMIT ?'),
      activity: sql('SELECT item FROM activity WHERE guild_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, seq DESC LIMIT ?'),
      historyIds: sql('SELECT id FROM history WHERE guild_id = ? AND played_at >= ? AND played_at <= ? ORDER BY played_at DESC, seq DESC LIMIT ?'),
      session: sql('SELECT session FROM sessions WHERE guild_id = ?'),
      insertHistory: sql('INSERT OR IGNORE INTO history (guild_id, id, played_at, item) VALUES (?, ?, ?, ?)'),
      insertActivity: sql('INSERT OR IGNORE INTO activity (guild_id, id, at, item) VALUES (?, ?, ?, ?)'),
      trimHistory: sql(`DELETE FROM history WHERE guild_id = :guildId AND (played_at < :oldest OR played_at > :newest OR seq IN (
        SELECT seq FROM history WHERE guild_id = :guildId AND played_at >= :oldest AND played_at <= :newest ORDER BY played_at DESC, seq DESC LIMIT -1 OFFSET :limit))`),
      trimActivity: sql(`DELETE FROM activity WHERE guild_id = :guildId AND (at < :oldest OR at > :newest OR seq IN (
        SELECT seq FROM activity WHERE guild_id = :guildId AND at >= :oldest AND at <= :newest ORDER BY at DESC, seq DESC LIMIT -1 OFFSET :limit))`),
      setSession: sql('INSERT INTO sessions (guild_id, saved_at, session) VALUES (?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET saved_at = excluded.saved_at, session = excluded.session'),
      clearSession: sql('DELETE FROM sessions WHERE guild_id = ?'),
      digest: sql('SELECT digest FROM mirrors WHERE guild_id = ?'),
      setDigest: sql('INSERT INTO mirrors (guild_id, digest) VALUES (?, ?) ON CONFLICT (guild_id) DO UPDATE SET digest = excluded.digest'),
    };
  }

  // Nested calls join the outermost transaction, which commits or rolls back all of it.
  transaction(work) {
    if (this.depth) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
    finally { this.depth = 0; }
  }

  window(kind, now) {
    const { maxAgeMs, limit } = this.retention[kind];
    return { oldest: now - maxAgeMs, newest: now + 60_000, limit };
  }

  /** One guild's listening state as library.json stored it, newest first. */
  read(guildId, now = Date.now()) {
    const history = this.window('history', now), activity = this.window('activity', now);
    const session = this.statements.session.get(guildId);
    return {
      history: this.statements.history.all(guildId, history.oldest, history.newest, history.limit).map(row => JSON.parse(row.item)),
      activity: this.statements.activity.all(guildId, activity.oldest, activity.newest, activity.limit).map(row => JSON.parse(row.item)),
      session: session ? JSON.parse(session.session) : null,
    };
  }

  /** The history IDs read() would list, and the raw checkpoint, without parsing either. */
  revisionInputs(guildId, now = Date.now()) {
    const history = this.window('history', now);
    return { historyIds: this.statements.historyIds.all(guildId, history.oldest, history.newest, history.limit).map(row => row.id),
      session: this.statements.session.get(guildId)?.session ?? null };
  }

  guildIds() {
    return this.db.prepare('SELECT guild_id FROM history UNION SELECT guild_id FROM activity UNION SELECT guild_id FROM sessions').all().map(row => row.guild_id);
  }

  // Items arrive newest first; inserting oldest first keeps insertion order as the tiebreak.
  insert(kind, guildId, items, now) {
    const [statement, time] = kind === 'history' ? [this.statements.insertHistory, 'playedAt'] : [this.statements.insertActivity, 'at'];
    for (const item of [...items].reverse()) statement.run(guildId, item.id, item[time], JSON.stringify(item));
    (kind === 'history' ? this.statements.trimHistory : this.statements.trimActivity).run({ guildId, ...this.window(kind, now) });
  }

  add(kind, guildId, item, now = Date.now()) { this.transaction(() => this.insert(kind, guildId, [item], now)); }

  /** Replace a guild's history, activity and/or session; omitted parts are kept. */
  replace(guildId, { history, activity, session } = {}, now = Date.now()) {
    this.transaction(() => {
      if (history) { this.db.prepare('DELETE FROM history WHERE guild_id = ?').run(guildId); this.insert('history', guildId, history, now); }
      if (activity) { this.db.prepare('DELETE FROM activity WHERE guild_id = ?').run(guildId); this.insert('activity', guildId, activity, now); }
      if (session !== undefined) this.writeSession(guildId, session);
    });
  }

  /** Remove all of one guild's listening state. */
  forget(guildId) {
    this.transaction(() => {
      for (const table of ['history', 'activity', 'sessions', 'mirrors']) this.db.prepare(`DELETE FROM ${table} WHERE guild_id = ?`).run(guildId);
    });
  }

  setSession(guildId, session) { this.transaction(() => this.writeSession(guildId, session)); }
  writeSession(guildId, session) {
    if (session) this.statements.setSession.run(guildId, session.savedAt, JSON.stringify(session));
    else this.statements.clearSession.run(guildId);
  }

  /**
   * Adopt library.json mirrors that changed since this store last read or wrote
   * them: an older image wrote them, or this is the first start. History and
   * activity merge by ID; the mirrored session, even an absent one, wins.
   * @param {Iterable<[string, {history?: object[], activity?: object[], session?: object|null}]>} guilds
   * @returns {number} guilds adopted
   */
  adopt(guilds, now = Date.now()) {
    const seen = new Map(guilds);
    for (const { guild_id: guildId } of this.db.prepare('SELECT guild_id FROM mirrors').all()) if (!seen.has(guildId)) seen.set(guildId, {});
    let adopted = 0;
    this.transaction(() => {
      for (const [guildId, mirror] of seen) {
        const digest = mirrorDigest(mirror);
        const stored = this.statements.digest.get(guildId)?.digest;
        if (stored === digest || (stored === undefined && digest === EMPTY_DIGEST)) continue;
        this.insert('history', guildId, mirror.history || [], now);
        this.insert('activity', guildId, mirror.activity || [], now);
        this.writeSession(guildId, mirror.session || null);
        this.statements.setDigest.run(guildId, digest);
        adopted += 1;
      }
    });
    return adopted;
  }

  /** Record the mirrors now in library.json, so the next start adopts nothing. */
  markMirrored(entries) {
    this.transaction(() => { for (const [guildId, digest] of entries) this.statements.setDigest.run(guildId, digest); });
  }

  meta(key, value) {
    if (value === undefined) return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  // Retention and item limits per guild, then the file-size guard.
  prune(now = Date.now()) {
    this.transaction(() => {
      for (const guildId of this.guildIds()) {
        this.statements.trimHistory.run({ guildId, ...this.window('history', now) });
        this.statements.trimActivity.run({ guildId, ...this.window('activity', now) });
      }
    });
    if (!this.durable) return;
    this.db.exec('PRAGMA incremental_vacuum');
    for (let attempt = 0; attempt < 30 && this.usedBytes() > this.limits.bytes && this.shedOldest(); attempt++) this.db.exec('PRAGMA incremental_vacuum');
  }

  /**
   * Remove the oldest tenth of history and activity, or of checkpoints when
   * nothing else is left. @returns {boolean} whether anything was removed
   */
  shedOldest() {
    const items = this.db.prepare('SELECT (SELECT COUNT(*) FROM history) + (SELECT COUNT(*) FROM activity) AS items').get().items;
    const sessions = this.db.prepare('SELECT COUNT(*) AS sessions FROM sessions').get().sessions;
    if (!items && !sessions) return false;
    this.db.exec(items
      ? `DELETE FROM history WHERE seq IN (SELECT seq FROM history ORDER BY played_at ASC, seq ASC LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM history));
         DELETE FROM activity WHERE seq IN (SELECT seq FROM activity ORDER BY at ASC, seq ASC LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM activity));`
      : 'DELETE FROM sessions WHERE guild_id IN (SELECT guild_id FROM sessions ORDER BY saved_at ASC LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM sessions));');
    return true;
  }

  usedBytes() {
    const pages = this.db.prepare('PRAGMA page_count').get().page_count - this.db.prepare('PRAGMA freelist_count').get().freelist_count;
    return pages * this.db.prepare('PRAGMA page_size').get().page_size;
  }

  close() {
    if (!this.db) return;
    // Leave a single self-contained file for volume snapshots.
    try { if (this.durable) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { logEvent(this.logger, 'error', 'listening_state_close_failed', error); }
    try { this.db.close(); } catch {}
    this.db = null;
  }
}
