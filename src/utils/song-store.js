import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../runtime.js';
import { trackReference } from './library.js';
import { recordingKey, recordingQuery, sameLength } from './song-identity.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// ADR-0017. Fingerprints and alternates arrive in later steps; their budgets
// share this file's guard.
export const SONG_LIMITS = Object.freeze({
  songs: 50_000,
  retentionMs: 365 * DAY,
  // The whole data volume is snapshotted before portal releases (64 MiB cap).
  bytes: 32 * 1024 * 1024,
});
// A catalog lookup that failed for a temporary reason is retried after these
// delays, then only when the song plays again.
export const LOOKUP_RETRY_MS = Object.freeze([HOUR, 6 * HOUR, DAY, DAY, DAY, DAY, DAY, DAY, DAY, DAY]);
// Catalogs whose own entries describe a recording (ISRC, album, artwork).
const CATALOGS = new Set(['spotify']);

const MIGRATIONS = [
  `CREATE TABLE songs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    artist TEXT NOT NULL,
    duration INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used_at INTEGER NOT NULL,
    catalog_status TEXT NOT NULL CHECK (catalog_status IN ('pending', 'linked', 'unmatched')),
    lookup_failures INTEGER NOT NULL DEFAULT 0,
    next_lookup_at INTEGER,
    catalog_source TEXT,
    catalog_id TEXT,
    catalog_uri TEXT,
    isrc TEXT,
    catalog_title TEXT,
    catalog_artist TEXT,
    album TEXT,
    artwork_url TEXT,
    catalog_duration INTEGER,
    linked_at INTEGER,
    CHECK ((catalog_status = 'linked') = (catalog_id IS NOT NULL))
  ) STRICT;
  CREATE INDEX songs_lookup ON songs (next_lookup_at) WHERE next_lookup_at IS NOT NULL;
  CREATE INDEX songs_used ON songs (used_at);
  -- Every reference URL a list can hold, mapped to its song.
  CREATE TABLE refs (
    uri TEXT PRIMARY KEY,
    song_id TEXT NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX refs_song ON refs (song_id);
  -- Uploads and files that play the song. Catalog entries are never sources.
  CREATE TABLE sources (
    uri TEXT PRIMARY KEY,
    song_id TEXT NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    duration INTEGER NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN ('first')),
    added_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sources_song ON sources (song_id);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`,
];
export const SONG_SCHEMA_VERSION = MIGRATIONS.length;

const validIsrc = value => typeof value === 'string' && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value);
const text = (value, maxLength) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null);
const httpsUrl = value => { try { return new URL(value).protocol === 'https:' ? String(value).slice(0, 500) : null; } catch { return null; } };

// The catalog facts kept from one catalog track (LavaSrc's Spotify results).
function catalogEntry(track) {
  const info = track?.info || {};
  const id = text(info.identifier, 120);
  if (!CATALOGS.has(info.sourceName) || !id || !(info.duration > 0)) return null;
  return {
    catalogSource: info.sourceName, catalogId: id, catalogUri: httpsUrl(info.uri), isrc: validIsrc(info.isrc) ? info.isrc.toUpperCase() : null,
    catalogTitle: text(info.title, 180) || 'Unknown track', catalogArtist: text(info.author, 120) || 'Unknown artist',
    album: text(track.pluginInfo?.albumName, 180), artworkUrl: httpsUrl(info.artworkUrl), catalogDuration: Math.round(info.duration),
  };
}

/**
 * Whether a catalog entry may describe a song's recording (ADR-0017): the same
 * artist and title once upload descriptors are removed, and the same length.
 * It links the song for display; it never makes two sources one song.
 */
export function catalogMatches(reference, catalogTrack) {
  const info = catalogTrack?.info || {};
  const key = recordingKey(reference);
  return Boolean(key) && key === recordingKey(info) && sameLength(reference.duration, info.duration);
}

/**
 * Songs as recordings, with the references and sources that point at them
 * (ADR-0017). Like stats, the store is optional: a failed open disables it and
 * every entry point catches its own failure, so it never blocks playback.
 */
export class SongStore {
  constructor(filePath, { now = Date.now, logger = console, limits = SONG_LIMITS, sqlite, newId } = {}) {
    Object.assign(this, { filePath, now, logger, limits, sqlite });
    this.newId = newId || (() => `song:${randomBytes(12).toString('base64url')}`);
    this.db = null; this.available = false; this.lastFailureLog = 0;
    this.counters = { failures: 0 };
  }

  async open() {
    const { DatabaseSync } = this.sqlite || await import('node:sqlite');
    if (this.filePath !== ':memory:') {
      mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      closeSync(openSync(this.filePath, 'a', 0o600));
    }
    const db = new DatabaseSync(this.filePath);
    try {
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = ON;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > SONG_SCHEMA_VERSION) throw new Error('The song store was written by a newer release.');
      if (version > 0 && db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The song store failed an integrity check.');
      if (version === 0) db.exec('PRAGMA auto_vacuum = INCREMENTAL;');
      // Normal, not full, sync: a song lost to power failure is recorded again
      // on its next play, and a track start never waits for a disk flush.
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 4194304;');
      for (let next = version; next < SONG_SCHEMA_VERSION; next++) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(MIGRATIONS[next]); db.exec(`PRAGMA user_version = ${next + 1}`); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    } catch (error) { db.close(); throw error; }
    this.db = db; this.available = true;
    this.prune();
    return this;
  }

  failure(event, error) {
    this.counters.failures += 1;
    if (this.now() - this.lastFailureLog < 60_000) return;
    this.lastFailureLog = this.now();
    logEvent(this.logger, 'error', event, error);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  /**
   * Record that a track started playing: its reference URL maps to a song, and
   * an upload becomes that song's first source. A song with no catalog link is
   * scheduled for a lookup. Never throws.
   * @returns {string|null} the song ID
   */
  record(track, now = this.now()) {
    try {
      if (!this.available) return null;
      const ref = trackReference(track);
      if (!ref || ref.isStream || !(ref.duration > 0)) return null;
      return this.transaction(() => {
        const known = this.db.prepare('SELECT s.id, s.catalog_status, s.next_lookup_at FROM refs r JOIN songs s ON s.id = r.song_id WHERE r.uri = ?').get(ref.uri);
        if (known) {
          // An exhausted lookup gets one more try each time the song plays.
          const retry = known.catalog_status === 'pending' && known.next_lookup_at === null ? now : known.next_lookup_at;
          this.db.prepare('UPDATE songs SET used_at = ?, next_lookup_at = ? WHERE id = ?').run(now, retry, known.id);
          return known.id;
        }
        const id = this.newId();
        const catalog = catalogEntry(track);
        this.db.prepare(`INSERT INTO songs (id, title, artist, duration, created_at, used_at, catalog_status, next_lookup_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, ref.title, ref.author, ref.duration, now, now, catalog ? null : now);
        if (catalog) this.linkRow(id, catalog, now);
        this.db.prepare('INSERT INTO refs (uri, song_id, added_at) VALUES (?, ?, ?)').run(ref.uri, id, now);
        if (!CATALOGS.has(ref.sourceName)) {
          this.db.prepare(`INSERT INTO sources (uri, song_id, source_name, identifier, title, author, duration, verification, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'first', ?)`).run(ref.uri, id, ref.sourceName, ref.identifier, ref.title, ref.author, ref.duration, now);
        }
        return id;
      });
    } catch (error) { this.failure('songs_write_failed', error); return null; }
  }

  linkRow(id, catalog, now) {
    this.db.prepare(`UPDATE songs SET catalog_status = 'linked', next_lookup_at = NULL, lookup_failures = 0, catalog_source = :catalogSource,
      catalog_id = :catalogId, catalog_uri = :catalogUri, isrc = :isrc, catalog_title = :catalogTitle, catalog_artist = :catalogArtist,
      album = :album, artwork_url = :artworkUrl, catalog_duration = :catalogDuration, linked_at = :now WHERE id = :id`).run({ ...catalog, now, id });
  }

  /** Songs whose catalog lookup is due, oldest first. */
  dueLookups(limit = 1, now = this.now()) {
    if (!this.available) return [];
    try {
      return this.db.prepare(`SELECT id, title, artist, duration FROM songs WHERE catalog_status = 'pending' AND next_lookup_at <= ?
        ORDER BY next_lookup_at, id LIMIT ?`).all(now, limit).map(row => ({ id: row.id, title: row.title, author: row.artist, duration: row.duration }));
    } catch (error) { this.failure('songs_read_failed', error); return []; }
  }

  /**
   * The outcome of one lookup: the first catalog result that matches links the
   * song; none means the catalog doesn't know this recording; null means the
   * lookup itself failed and is retried later. Never throws.
   */
  resolveLookup(id, results, now = this.now()) {
    try {
      if (!this.available) return;
      const song = this.db.prepare("SELECT title, artist AS author, duration, lookup_failures FROM songs WHERE id = ? AND catalog_status = 'pending'").get(id);
      if (!song) return;
      if (results === null) {
        const delay = LOOKUP_RETRY_MS[song.lookup_failures];
        this.db.prepare('UPDATE songs SET lookup_failures = lookup_failures + 1, next_lookup_at = ? WHERE id = ?').run(delay === undefined ? null : now + delay, id);
        return;
      }
      const catalog = results.map(track => catalogMatches(song, track) && catalogEntry(track)).find(Boolean);
      if (catalog) this.transaction(() => this.linkRow(id, catalog, now));
      else this.db.prepare("UPDATE songs SET catalog_status = 'unmatched', next_lookup_at = NULL WHERE id = ?").run(id);
    } catch (error) { this.failure('songs_write_failed', error); }
  }

  /** The song a reference URL belongs to, or null. */
  songOf(uri) {
    if (!this.available) return null;
    try {
      const row = this.db.prepare('SELECT s.* FROM refs r JOIN songs s ON s.id = r.song_id WHERE r.uri = ?').get(uri);
      if (!row) return null;
      const sources = this.db.prepare('SELECT uri, source_name, verification FROM sources WHERE song_id = ? ORDER BY added_at, uri').all(row.id)
        .map(source => ({ uri: source.uri, sourceName: source.source_name, verification: source.verification }));
      return {
        id: row.id, title: row.title, author: row.artist, duration: row.duration, catalogStatus: row.catalog_status, sources,
        catalog: row.catalog_status === 'linked' ? { source: row.catalog_source, id: row.catalog_id, uri: row.catalog_uri, isrc: row.isrc,
          title: row.catalog_title, author: row.catalog_artist, album: row.album, artworkUrl: row.artwork_url, duration: row.catalog_duration } : null,
      };
    } catch (error) { this.failure('songs_read_failed', error); return null; }
  }

  // Retention, the song cap, then the file-size guard, each shedding the songs
  // unused for longest. References and sources go with their song. Never throws.
  prune(now = this.now()) {
    if (!this.available) return;
    try {
      const { retentionMs, songs, bytes } = this.limits;
      this.transaction(() => {
        this.db.prepare('DELETE FROM songs WHERE used_at < ?').run(now - retentionMs);
        this.db.prepare('DELETE FROM songs WHERE id IN (SELECT id FROM songs ORDER BY used_at DESC, id DESC LIMIT -1 OFFSET ?)').run(songs);
      });
      this.db.exec('PRAGMA incremental_vacuum');
      for (let attempt = 0; attempt < 8 && this.usedBytes() > bytes; attempt++) {
        this.db.exec(`DELETE FROM songs WHERE id IN (SELECT id FROM songs ORDER BY used_at ASC, id ASC LIMIT (SELECT MAX(1, COUNT(*) / 10) FROM songs));
          PRAGMA incremental_vacuum;`);
      }
    } catch (error) { this.failure('songs_prune_failed', error); }
  }

  usedBytes() {
    const pages = this.db.prepare('PRAGMA page_count').get().page_count - this.db.prepare('PRAGMA freelist_count').get().freelist_count;
    return pages * this.db.prepare('PRAGMA page_size').get().page_size;
  }

  status() {
    if (!this.available) return { available: false, ...this.counters };
    try {
      const counts = this.db.prepare("SELECT COUNT(*) AS songs, COALESCE(SUM(catalog_status = 'linked'), 0) AS linked FROM songs").get();
      return { available: true, songs: counts.songs, linked: counts.linked, ...this.counters };
    } catch { return { available: true, ...this.counters }; }
  }

  disable() {
    clearInterval(this.pruneTimer); clearInterval(this.lookupTimer);
    try { this.db?.close(); } catch {}
    this.db = null; this.available = false;
  }

  close() {
    if (!this.available) return;
    // Leave a single self-contained file for volume snapshots.
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (error) { this.failure('songs_close_failed', error); }
    this.disable();
  }
}

/**
 * Looks up one due song in the catalog at a time, through Lavalink's LavaSrc.
 * Search failures, and an unavailable node, count as temporary.
 */
export async function lookupNextSong(store, search, { timeoutMs = 10_000 } = {}) {
  const [song] = store.dueLookups(1);
  if (!song) return false;
  let results = null;
  try {
    let timer;
    const found = await Promise.race([search(recordingQuery(song)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Catalog lookup timed out.')), timeoutMs); })]).finally(() => clearTimeout(timer));
    if (found && found.loadType !== 'error') results = Array.isArray(found.tracks) ? found.tracks : [];
  } catch { results = null; }
  store.resolveLookup(song.id, results);
  return true;
}

// The store never fails startup: unavailable, it records nothing and playback
// is exactly as before. Lookups run one at a time, at most one a minute.
export async function initializeSongs(client, { dataDir, logger = console, lookupIntervalMs = 60_000 } = {}) {
  const store = new SongStore(path.join(dataDir, 'songs.sqlite'), { logger });
  try { await store.open(); }
  catch (error) { logEvent(logger, 'error', 'songs_unavailable', error); store.disable(); }
  client.songs = store;
  if (!store.available) return store;
  store.pruneTimer = setInterval(() => store.prune(), 60 * 60_000);
  store.pruneTimer.unref?.();
  let running = false;
  store.lookupTimer = setInterval(() => {
    const node = client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
    if (running || !store.available || !node?.connected || !node.search) return;
    running = true;
    void lookupNextSong(store, query => node.search({ query, source: 'spsearch' }, client.user))
      .catch(error => store.failure('songs_lookup_failed', error)).finally(() => { running = false; });
  }, lookupIntervalMs);
  store.lookupTimer.unref?.();
  return store;
}
