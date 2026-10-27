import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../runtime.js';
import { trackReference, validId } from './library.js';
import { isYouTubeMusicSong, referenceRank, songIdentity, songKey } from './song-identity.js';
import { forgottenGems, onRepeat, SCORING } from './stats-scoring.js';
import { createPlayTracker } from './play-tracking.js';

const DAY = 24 * 60 * 60_000;
export const STATS_LIMITS = Object.freeze({
  retentionMs: 365 * DAY,
  guildPlays: 10_000,
  totalPlays: 50_000,
  // The whole data volume is snapshotted before portal releases (64 MiB cap).
  bytes: 16 * 1024 * 1024,
  pendingWrites: 500,
  voiceChannels: 50,
});
export const STATS_WINDOWS = Object.freeze({ '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY, '365d': 365 * DAY });
export const REDISCOVER_QUIET_MS = 30 * DAY;

// Each entry upgrades the previous schema version inside one transaction.
const MIGRATIONS = [
  `CREATE TABLE songs (
    song_key TEXT PRIMARY KEY,
    artist_key TEXT NOT NULL,
    artist TEXT NOT NULL,
    uri TEXT NOT NULL,
    source_name TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    duration INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX songs_artist ON songs (artist_key);
  CREATE TABLE plays (
    id INTEGER PRIMARY KEY,
    guild_id TEXT NOT NULL,
    song_key TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    voice_channel_id TEXT NOT NULL,
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('user', 'autoplay', 'cleared', 'unknown')),
    requester_id TEXT CHECK ((requester_kind = 'user') = (requester_id IS NOT NULL)),
    duration_ms INTEGER NOT NULL,
    played_ms INTEGER,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    skipped INTEGER NOT NULL DEFAULT 0 CHECK (skipped IN (0, 1)),
    origin TEXT NOT NULL CHECK (origin IN ('live', 'backfill')),
    history_id TEXT UNIQUE
  ) STRICT;
  CREATE INDEX plays_guild_time ON plays (guild_id, played_at);
  CREATE INDEX plays_requester ON plays (requester_id, played_at) WHERE requester_id IS NOT NULL;
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
];
export const STATS_SCHEMA_VERSION = MIGRATIONS.length;

// Recap reads. Each is bounded by one server and window and searches an existing
// index: personal totals use plays_requester, server reads use plays_guild_time.
// Parameters: 1 guild, 2 since, 3 visible channel IDs (JSON), 4 requester or limit.
const visiblePlays = 'guild_id = ?1 AND played_at >= ?2 AND voice_channel_id IN (SELECT value FROM json_each(?3))';
export const RECAP_QUERIES = Object.freeze({
  personalTotals: `SELECT COUNT(*) AS plays, COALESCE(SUM(played_ms), 0) AS played_ms, COUNT(DISTINCT song_key) AS songs FROM plays
    WHERE requester_id = ?4 AND ${visiblePlays}`,
  serverTotals: `SELECT COUNT(*) AS plays, COALESCE(SUM(played_ms), 0) AS played_ms, COUNT(DISTINCT song_key) AS songs FROM plays WHERE ${visiblePlays}`,
  serverTopTracks: `SELECT song_key, COUNT(*) AS plays, MAX(played_at) AS last FROM plays WHERE ${visiblePlays} AND skipped = 0
    GROUP BY song_key ORDER BY plays DESC, last DESC LIMIT ?4`,
});

export class StatsUnavailableError extends Error {
  constructor() { super('Listening stats are unavailable right now.'); this.name = 'StatsUnavailableError'; this.code = 'STATS_UNAVAILABLE'; }
}

const ids = values => JSON.stringify([...new Set(values)].filter(validId));
function reference(row) {
  return { uri: row.uri, sourceName: row.source_name, identifier: row.identifier, title: row.title, author: row.author, duration: row.duration, isStream: false };
}

// A separate durable store for play statistics. Stats are optional: a failed
// open disables the store, and a failed write is logged and dropped, so neither
// can block startup or playback. Writes are batched off the event that caused
// them and committed together.
export class PlayStats {
  constructor(filePath, { now = Date.now, logger = console, limits = STATS_LIMITS, flushDelayMs = 250, sqlite } = {}) {
    Object.assign(this, { filePath, now, logger, limits, flushDelayMs, sqlite });
    this.db = null; this.available = false; this.queue = []; this.timer = null;
    this.counters = { writeFailures: 0, droppedWrites: 0 };
    this.lastFailureLog = 0;
  }

  async open() {
    const { DatabaseSync } = this.sqlite || await import('node:sqlite');
    if (this.filePath !== ':memory:') {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      // Owner-only before SQLite creates it; WAL and SHM files inherit the mode.
      closeSync(openSync(this.filePath, 'a', 0o600));
    }
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA temp_store = MEMORY;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > STATS_SCHEMA_VERSION) throw new Error('Listening stats were written by a newer release.');
      if (version > 0 && db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Listening stats failed an integrity check.');
      // Incremental vacuum must be chosen before the first table exists.
      if (version === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA journal_size_limit = 4194304;');
      for (let next = version; next < STATS_SCHEMA_VERSION; next++) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(MIGRATIONS[next]); db.exec(`PRAGMA user_version = ${next + 1}`); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) { db.close(); throw error; }
    this.db = db; this.available = true;
    this.prepare();
    this.prune();
    return this;
  }

  prepare() {
    const sql = text => this.db.prepare(text);
    this.statements = {
      upsertSong: sql(`INSERT INTO songs (song_key, artist_key, artist, uri, source_name, identifier, title, author, duration, rank, updated_at)
        VALUES (:songKey, :artistKey, :artist, :uri, :sourceName, :identifier, :title, :author, :duration, :rank, :now)
        ON CONFLICT (song_key) DO UPDATE SET artist_key = excluded.artist_key, artist = excluded.artist, uri = excluded.uri,
          source_name = excluded.source_name, identifier = excluded.identifier, title = excluded.title, author = excluded.author,
          duration = excluded.duration, rank = excluded.rank, updated_at = excluded.updated_at
        WHERE excluded.rank > songs.rank`),
      insertPlay: sql(`INSERT OR IGNORE INTO plays (guild_id, song_key, played_at, voice_channel_id, requester_kind, requester_id, duration_ms, played_ms, completed, skipped, origin, history_id)
        VALUES (:guildId, :songKey, :playedAt, :voiceChannelId, :requesterKind, :requesterId, :durationMs, :playedMs, 0, 0, :origin, :historyId)`),
      finishPlay: sql('UPDATE plays SET played_ms = :playedMs, completed = :completed, skipped = :skipped WHERE id = :id'),
      discardPlay: sql('DELETE FROM plays WHERE id = :id'),
    };
  }

  disable() {
    clearTimeout(this.timer); clearInterval(this.pruneTimer); this.timer = null; this.queue.length = 0;
    try { this.db?.close(); } catch {}
    this.db = null; this.available = false;
  }

  failure(event, error) {
    this.counters.writeFailures += 1;
    if (this.now() - this.lastFailureLog < 60_000) return;
    this.lastFailureLog = this.now();
    logEvent(this.logger, 'error', event, error);
  }

  enqueue(operation) {
    if (!this.available) return false;
    if (this.queue.length >= this.limits.pendingWrites) { this.counters.droppedWrites += 1; return false; }
    this.queue.push(operation);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.flushDelayMs);
      this.timer.unref?.();
    }
    return true;
  }

  // One transaction per batch. A failed statement drops only its own write.
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.available || !this.queue.length) return;
    const batch = this.queue.splice(0);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      for (const operation of batch) {
        try { operation(this.statements); } catch (error) { this.failure('stats_write_failed', error); }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      this.failure('stats_commit_failed', error);
    }
  }

  songRow(track) {
    const ref = trackReference(track);
    if (!ref || ref.isStream) return null;
    const identity = songIdentity(ref);
    return { ref, row: { songKey: identity.key, artistKey: identity.artistKey, artist: identity.artist, uri: ref.uri, sourceName: ref.sourceName,
      identifier: ref.identifier, title: ref.title, author: ref.author, duration: ref.duration, rank: referenceRank(ref, { youtubeMusic: isYouTubeMusicSong(track) }), now: this.now() } };
  }

  /**
   * Record that a play started. Never throws.
   * @returns {object|null} handle for finish(), or null when nothing is recorded
   */
  begin({ guildId, voiceChannelId, track, requesterKind, requesterId = null, playedAt = this.now() }) {
    try {
      if (!this.available || !validId(guildId) || !validId(voiceChannelId)) return null;
      if (!['user', 'autoplay', 'unknown'].includes(requesterKind) || (requesterKind === 'user') !== validId(requesterId)) return null;
      const song = this.songRow(track);
      if (!song) return null;
      const handle = { id: null, durationMs: song.ref.duration, guildId };
      const queued = this.enqueue(statements => {
        statements.upsertSong.run(song.row);
        const result = statements.insertPlay.run({ guildId, songKey: song.row.songKey, playedAt, voiceChannelId, requesterKind,
          requesterId: requesterKind === 'user' ? requesterId : null, durationMs: song.ref.duration, playedMs: null, origin: 'live', historyId: null });
        handle.id = Number(result.lastInsertRowid);
      });
      return queued ? handle : null;
    } catch (error) { this.failure('stats_write_failed', error); return null; }
  }

  /** Record how a play ended, or discard one that never really played. Never throws. */
  finish(handle, { playedMs = 0, completed = false, skipped = false, discard = false } = {}) {
    try {
      if (!handle || handle.finished) return;
      handle.finished = true;
      this.enqueue(statements => {
        if (handle.id === null) return;
        if (discard) statements.discardPlay.run({ id: handle.id });
        else statements.finishPlay.run({ id: handle.id, playedMs: Math.max(0, Math.round(playedMs)), completed: completed ? 1 : 0, skipped: skipped ? 1 : 0 });
      });
    } catch (error) { this.failure('stats_write_failed', error); }
  }

  /**
   * Import library history once. Requesters and outcomes were never recorded,
   * so backfilled plays are unattended and neither skipped nor completed.
   * @param {Iterable<[string, {id: string, playedAt: number, voiceChannelId: string, track: object}[]]>} histories
   */
  backfill(histories) {
    this.assertAvailable();
    if (this.db.prepare("SELECT 1 FROM meta WHERE key = 'backfill.history'").get()) return 0;
    let imported = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [guildId, history] of histories) {
        if (!validId(guildId)) continue;
        for (const item of history || []) {
          const song = this.songRow(item.track);
          if (!song || !validId(item.voiceChannelId) || !Number.isSafeInteger(item.playedAt) || typeof item.id !== 'string') continue;
          this.statements.upsertSong.run(song.row);
          imported += Number(this.statements.insertPlay.run({ guildId, songKey: song.row.songKey, playedAt: item.playedAt, voiceChannelId: item.voiceChannelId,
            requesterKind: 'unknown', requesterId: null, durationMs: song.ref.duration, playedMs: null, origin: 'backfill', historyId: item.id.slice(0, 40) }).changes);
        }
      }
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('backfill.history', ?)").run(String(this.now()));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.prune();
    return imported;
  }

  // Retention, per-server and total row caps, then a file-size guard. Never throws.
  prune(now = this.now()) {
    if (!this.available) return;
    try {
      this.flush();
      const { retentionMs, guildPlays, totalPlays, bytes } = this.limits;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM plays WHERE played_at < ? OR played_at > ?').run(now - retentionMs, now + DAY);
        const crowded = this.db.prepare('SELECT guild_id FROM plays GROUP BY guild_id HAVING COUNT(*) > ?').all(guildPlays);
        const trimGuild = this.db.prepare('DELETE FROM plays WHERE id IN (SELECT id FROM plays WHERE guild_id = ? ORDER BY played_at DESC, id DESC LIMIT -1 OFFSET ?)');
        for (const { guild_id: guildId } of crowded) trimGuild.run(guildId, guildPlays);
        this.db.prepare('DELETE FROM plays WHERE id IN (SELECT id FROM plays ORDER BY played_at DESC, id DESC LIMIT -1 OFFSET ?)').run(totalPlays);
        this.db.exec('DELETE FROM songs WHERE song_key NOT IN (SELECT song_key FROM plays)');
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.db.exec('PRAGMA incremental_vacuum');
      for (let attempt = 0; attempt < 8 && this.usedBytes() > bytes; attempt++) {
        // Unusually long titles can outgrow the row estimate; shed the oldest tenth.
        this.db.exec(`DELETE FROM plays WHERE id IN (SELECT id FROM plays ORDER BY played_at ASC, id ASC LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM plays));
          DELETE FROM songs WHERE song_key NOT IN (SELECT song_key FROM plays); PRAGMA incremental_vacuum;`);
      }
    } catch (error) { this.failure('stats_prune_failed', error); }
  }

  usedBytes() {
    const pages = this.db.prepare('PRAGMA page_count').get().page_count - this.db.prepare('PRAGMA freelist_count').get().freelist_count;
    return pages * this.db.prepare('PRAGMA page_size').get().page_size;
  }

  assertAvailable() { if (!this.available) throw new StatsUnavailableError(); }

  /** Recent voice channels with plays, so callers can resolve their visibility. */
  voiceChannelIds(guildId, limit = this.limits.voiceChannels) {
    if (!this.available || !validId(guildId)) return [];
    try {
      this.flush();
      return this.db.prepare('SELECT voice_channel_id AS id FROM plays WHERE guild_id = ? GROUP BY voice_channel_id ORDER BY MAX(played_at) DESC LIMIT ?')
        .all(guildId, limit).map(row => row.id);
    } catch (error) { this.failure('stats_read_failed', error); return []; }
  }

  songs(keys) {
    if (!keys.length) return new Map();
    return new Map(this.db.prepare('SELECT * FROM songs WHERE song_key IN (SELECT value FROM json_each(?))').all(JSON.stringify(keys)).map(row => [row.song_key, row]));
  }

  withTracks(entries) {
    const songs = this.songs(entries.map(entry => entry.songKey));
    return entries.filter(entry => songs.has(entry.songKey)).map(entry => ({ ...entry, track: reference(songs.get(entry.songKey)) }));
  }

  /**
   * Server favorites from plays in channels the viewer can see.
   * @returns {{ onRepeat: Entry[], forgottenGems: Entry[] }} Entry = { songKey, track, plays, lastPlayedAt, score }
   */
  serverFavorites(guildId, { visibleChannelIds = [], now = this.now() } = {}) {
    this.assertAvailable();
    this.flush();
    const plays = this.db.prepare(`SELECT song_key, played_at, requester_kind, requester_id, skipped FROM plays
      WHERE guild_id = ? AND played_at >= ? AND voice_channel_id IN (SELECT value FROM json_each(?))`)
      .all(guildId, now - Math.max(SCORING.gemsFromMs, SCORING.onRepeatWindowMs), ids(visibleChannelIds))
      .map(row => ({ songKey: row.song_key, playedAt: row.played_at, requesterKind: row.requester_kind, requesterId: row.requester_id, skipped: row.skipped === 1 }));
    return { onRepeat: this.withTracks(onRepeat(plays, now)), forgottenGems: this.withTracks(forgottenGems(plays, now)) };
  }

  /** A listener's most requested songs in visible channels, early skips excluded. */
  topTracks(guildId, userId, { since = 0, visibleChannelIds = [], limit = 25 } = {}) {
    this.assertAvailable();
    if (!validId(userId)) return [];
    this.flush();
    return this.withTracks(this.db.prepare(`SELECT song_key, COUNT(*) AS plays, MAX(played_at) AS last FROM plays
      WHERE requester_id = ? AND guild_id = ? AND played_at >= ? AND skipped = 0 AND voice_channel_id IN (SELECT value FROM json_each(?))
      GROUP BY song_key ORDER BY plays DESC, last DESC LIMIT ?`).all(userId, guildId, since, ids(visibleChannelIds), limit)
      .map(row => ({ songKey: row.song_key, plays: row.plays, lastPlayedAt: row.last })));
  }

  /** Songs a listener asked for and then skipped early, most recent first. */
  earlySkips(guildId, userId, { since = 0, visibleChannelIds = [], limit = 50 } = {}) {
    this.assertAvailable();
    if (!validId(userId)) return [];
    this.flush();
    return this.db.prepare(`SELECT song_key FROM plays
      WHERE requester_id = ? AND guild_id = ? AND played_at >= ? AND skipped = 1 AND voice_channel_id IN (SELECT value FROM json_each(?))
      GROUP BY song_key ORDER BY MAX(played_at) DESC LIMIT ?`).all(userId, guildId, since, ids(visibleChannelIds), limit).map(row => row.song_key);
  }

  /** A listener's most requested artists in visible channels, with their top song. */
  topArtists(guildId, userId, { since = 0, visibleChannelIds = [], limit = 10 } = {}) {
    this.assertAvailable();
    if (!validId(userId)) return [];
    this.flush();
    const rows = this.db.prepare(`SELECT s.artist_key, p.song_key, COUNT(*) AS plays, MAX(p.played_at) AS last FROM plays p JOIN songs s ON s.song_key = p.song_key
      WHERE p.requester_id = ? AND p.guild_id = ? AND p.played_at >= ? AND p.skipped = 0 AND p.voice_channel_id IN (SELECT value FROM json_each(?))
      GROUP BY s.artist_key, p.song_key`).all(userId, guildId, since, ids(visibleChannelIds));
    const artists = new Map();
    for (const row of rows) {
      const artist = artists.get(row.artist_key) || { artistKey: row.artist_key, plays: 0, lastPlayedAt: 0, top: null };
      artist.plays += row.plays; artist.lastPlayedAt = Math.max(artist.lastPlayedAt, row.last);
      if (!artist.top || row.plays > artist.top.plays || (row.plays === artist.top.plays && row.last > artist.top.last)) artist.top = row;
      artists.set(row.artist_key, artist);
    }
    const ranked = [...artists.values()].sort((a, b) => b.plays - a.plays || b.lastPlayedAt - a.lastPlayedAt).slice(0, limit);
    const songs = this.songs(ranked.map(artist => artist.top.song_key));
    return ranked.filter(artist => songs.has(artist.top.song_key)).map(({ top, ...artist }) => ({
      ...artist, artist: songs.get(top.song_key).artist, track: reference(songs.get(top.song_key)) }));
  }

  /**
   * A listening recap for one window, computed on read. Personal numbers count
   * only the listener's own requests; server numbers count every visible play and
   * never identify a requester, so cleared requests stay anonymous. Played time
   * comes from recorded playback: imported history and plays in progress add none.
   */
  recap(guildId, userId, { since = 0, visibleChannelIds = [], limit = 10, artistLimit = 5 } = {}) {
    this.assertAvailable();
    this.flush();
    const channels = ids(visibleChannelIds);
    const totals = row => ({ plays: row.plays, playedMs: row.played_ms, songs: row.songs });
    const mine = validId(userId);
    const personal = mine ? totals(this.db.prepare(RECAP_QUERIES.personalTotals).get(guildId, since, channels, userId)) : { plays: 0, playedMs: 0, songs: 0 };
    const scope = { since, visibleChannelIds };
    return {
      personal: { ...personal,
        topTracks: personal.plays ? this.topTracks(guildId, userId, { ...scope, limit }) : [],
        topArtists: personal.plays ? this.topArtists(guildId, userId, { ...scope, limit: artistLimit }) : [] },
      server: { ...totals(this.db.prepare(RECAP_QUERIES.serverTotals).get(guildId, since, channels)),
        topTracks: this.withTracks(this.db.prepare(RECAP_QUERIES.serverTopTracks).all(guildId, since, channels, limit)
          .map(row => ({ songKey: row.song_key, plays: row.plays, lastPlayedAt: row.last }))) },
    };
  }

  /**
   * Songs by one artist that played in visible channels, from every requester.
   * Feeds per-artist mixes; requester identities never leave this query.
   */
  artistSongs(guildId, artistKey, { since = 0, visibleChannelIds = [], limit = 25 } = {}) {
    this.assertAvailable();
    if (typeof artistKey !== 'string' || !artistKey) return [];
    this.flush();
    return this.withTracks(this.db.prepare(`SELECT p.song_key, COUNT(*) AS plays, MAX(p.played_at) AS last FROM plays p JOIN songs s ON s.song_key = p.song_key
      WHERE p.guild_id = ? AND s.artist_key = ? AND p.played_at >= ? AND p.skipped = 0 AND p.voice_channel_id IN (SELECT value FROM json_each(?))
      GROUP BY p.song_key ORDER BY plays DESC, last DESC LIMIT ?`).all(guildId, artistKey, since, ids(visibleChannelIds), limit)
      .map(row => ({ songKey: row.song_key, plays: row.plays, lastPlayedAt: row.last })));
  }

  /**
   * Personal favorites the listener has not requested recently anywhere.
   * Uses only their own requests; previously requested songs come first.
   * @returns {{ index: number, track: object, songKey: string, requests: number, lastRequestedAt: number|null }[]} index is 1-based
   */
  rediscover(userId, favorites, { now = this.now(), quietMs = REDISCOVER_QUIET_MS, limit = 25 } = {}) {
    this.assertAvailable();
    if (!validId(userId) || !favorites.length) return [];
    this.flush();
    const keyed = favorites.map((track, index) => ({ index: index + 1, track, songKey: songKey(track) }));
    const requested = new Map(this.db.prepare(`SELECT song_key, COUNT(*) AS requests, MAX(played_at) AS last FROM plays
      WHERE requester_id = ? AND song_key IN (SELECT value FROM json_each(?)) GROUP BY song_key`)
      .all(userId, JSON.stringify([...new Set(keyed.map(item => item.songKey))])).map(row => [row.song_key, row]));
    return keyed.map(item => ({ ...item, requests: requested.get(item.songKey)?.requests || 0, lastRequestedAt: requested.get(item.songKey)?.last ?? null }))
      .filter(item => item.lastRequestedAt === null || item.lastRequestedAt < now - quietMs)
      .sort((a, b) => (b.requests > 0) - (a.requests > 0) || b.requests - a.requests || a.index - b.index)
      .slice(0, limit);
  }

  /** Remove the listener's ID from every recorded request. Server totals remain, anonymized. */
  clearRequests(userId) {
    this.assertAvailable();
    if (!validId(userId)) return 0;
    this.flush();
    return Number(this.db.prepare("UPDATE plays SET requester_kind = 'cleared', requester_id = NULL WHERE requester_id = ?").run(userId).changes);
  }

  status() {
    return { available: this.available, pendingWrites: this.queue.length, ...this.counters };
  }

  close() {
    if (!this.available) return;
    this.flush();
    // Leave a single self-contained file for volume snapshots.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { this.failure('stats_close_failed', error); }
    this.disable();
  }
}

// Stats never fail startup: an unavailable store leaves playback untouched and
// every stats read answers "unavailable" until an operator repairs the file.
export async function initializeStats(client, { dataDir, logger = console } = {}) {
  const stats = new PlayStats(path.join(dataDir, 'stats.sqlite'), { logger });
  try {
    await stats.open();
    const imported = stats.backfill((client.library?.guildIds?.() || []).map(id => [id, client.library.readGuild(id).history]));
    if (imported) logger.log(JSON.stringify({ event: 'stats_backfilled', plays: imported }));
  } catch (error) {
    logEvent(logger, 'error', 'stats_unavailable', error);
    stats.disable();
  }
  client.stats = stats;
  client.playTracker = createPlayTracker({ stats, botUserId: () => client.user?.id ?? null, logger });
  if (stats.available) {
    stats.pruneTimer = setInterval(() => stats.prune(), 60 * 60_000);
    stats.pruneTimer.unref?.();
  }
  return stats;
}
