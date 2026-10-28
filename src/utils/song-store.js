import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { logEvent } from '../runtime.js';
import { trackReference } from './library.js';
import { isYouTubeMusicSong, recordingKey, recordingQuery, sameLength } from './song-identity.js';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// ADR-0017's budget. Fingerprints are at most 2 KB, so 10,000 of them stay near
// 20 MB inside the file guard.
export const SONG_LIMITS = Object.freeze({
  songs: 50_000,
  sources: 8,
  fingerprints: 10_000,
  retentionMs: 365 * DAY,
  // The whole data volume is snapshotted before portal releases (64 MiB cap).
  bytes: 32 * 1024 * 1024,
});
// A source that failed is skipped this long; a fingerprint that failed is retried after it.
export const SOURCE_COOLDOWN_MS = 6 * HOUR;
// Alternates are looked for again after this long.
export const ALTERNATES_RECHECK_MS = 30 * DAY;
// A catalog lookup that failed for a temporary reason is retried after these
// delays, then only when the song plays again.
export const LOOKUP_RETRY_MS = Object.freeze([HOUR, 6 * HOUR, DAY, DAY, DAY, DAY, DAY, DAY, DAY, DAY]);
// Catalogs whose own entries describe a recording (ISRC, album, artwork).
const CATALOGS = new Set(['spotify']);

// Exported for the migration test.
export const MIGRATIONS = [
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
  // Step 2: fingerprints, sources verified by audio, and merged songs' old IDs.
  `ALTER TABLE songs ADD COLUMN fingerprint BLOB;
  ALTER TABLE songs ADD COLUMN fingerprinted_at INTEGER;
  ALTER TABLE songs ADD COLUMN fingerprint_failed_at INTEGER;
  ALTER TABLE songs ADD COLUMN alternates_checked_at INTEGER;
  CREATE TABLE sources_v2 (
    uri TEXT PRIMARY KEY,
    song_id TEXT NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    duration INTEGER NOT NULL,
    verification TEXT NOT NULL CHECK (verification IN ('first', 'audio')),
    -- A YouTube Music song: a Topic upload, or a Music result naming the artist.
    music INTEGER NOT NULL DEFAULT 0 CHECK (music IN (0, 1)),
    similarity REAL,
    added_at INTEGER NOT NULL,
    last_played_at INTEGER,
    last_failed_at INTEGER
  ) STRICT;
  INSERT INTO sources_v2 (uri, song_id, source_name, identifier, title, author, duration, verification, music, added_at)
    SELECT uri, song_id, source_name, identifier, title, author, duration, verification, author LIKE '% - Topic', added_at FROM sources;
  DROP TABLE sources;
  ALTER TABLE sources_v2 RENAME TO sources;
  CREATE INDEX sources_song ON sources (song_id);
  CREATE TABLE aliases (
    alias TEXT PRIMARY KEY,
    song_id TEXT NOT NULL REFERENCES songs (id) ON DELETE CASCADE,
    merged_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX aliases_song ON aliases (song_id);`,
];
export const SONG_SCHEMA_VERSION = MIGRATIONS.length;

const musicSong = track => (isYouTubeMusicSong(track) || / - Topic$/i.test(String((track?.info || track)?.author || ''))) ? 1 : 0;
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
  constructor(filePath, { now = Date.now, logger = console, limits = {}, sqlite, newId } = {}) {
    Object.assign(this, { filePath, now, logger, limits: { ...SONG_LIMITS, ...limits }, sqlite });
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
        // A track that starts is a source that plays.
        this.db.prepare('UPDATE sources SET last_played_at = ? WHERE uri = ?').run(now, ref.uri);
        if (known) {
          this.db.prepare('UPDATE sources SET music = MAX(music, ?) WHERE uri = ?').run(musicSong(track), ref.uri);
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
          this.db.prepare(`INSERT INTO sources (uri, song_id, source_name, identifier, title, author, duration, verification, music, added_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'first', ?, ?)`).run(ref.uri, id, ref.sourceName, ref.identifier, ref.title, ref.author, ref.duration, musicSong(track), now);
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

  /** Marks a known reference as played again; false when the store doesn't know it. */
  touch(uri, now = this.now()) {
    if (!this.available) return false;
    try { return Number(this.db.prepare('UPDATE songs SET used_at = ? WHERE id = (SELECT song_id FROM refs WHERE uri = ?)').run(now, uri).changes) > 0; }
    catch (error) { this.failure('songs_write_failed', error); return false; }
  }

  /**
   * The most recently used song still without a fingerprint, among the songs
   * allowed one, with the YouTube source to measure. Never throws.
   * @returns {{ id: string, identifier: string }|null}
   */
  fingerprintDue(now = this.now()) {
    if (!this.available) return null;
    try {
      const row = this.db.prepare(`SELECT s.id, src.identifier FROM songs s JOIN sources src ON src.song_id = s.id AND src.source_name = 'youtube'
        WHERE s.fingerprint IS NULL AND (s.fingerprint_failed_at IS NULL OR s.fingerprint_failed_at <= ?)
          AND s.id IN (SELECT id FROM songs ORDER BY used_at DESC, id DESC LIMIT ?)
        ORDER BY s.used_at DESC, src.verification = 'first' DESC, src.added_at LIMIT 1`).get(now - SOURCE_COOLDOWN_MS, this.limits.fingerprints);
      return row ? { id: row.id, identifier: row.identifier } : null;
    } catch (error) { this.failure('songs_read_failed', error); return null; }
  }

  /** Stores a song's fingerprint, or with null records that measuring failed. Never throws. */
  setFingerprint(id, fingerprint, now = this.now()) {
    if (!this.available) return;
    try {
      if (fingerprint) this.db.prepare('UPDATE songs SET fingerprint = ?, fingerprinted_at = ?, fingerprint_failed_at = NULL WHERE id = ?').run(fingerprint, now, id);
      else this.db.prepare('UPDATE songs SET fingerprint_failed_at = ? WHERE id = ?').run(now, id);
    } catch (error) { this.failure('songs_write_failed', error); }
  }

  /**
   * The most recently used fingerprinted song due an alternates check, with
   * what candidates are compared against. Never throws.
   */
  alternatesDue(now = this.now()) {
    if (!this.available) return null;
    try {
      const row = this.db.prepare(`SELECT id, title, artist, duration, isrc, fingerprint FROM songs WHERE fingerprint IS NOT NULL
        AND (alternates_checked_at IS NULL OR alternates_checked_at <= ?) ORDER BY used_at DESC, id DESC LIMIT 1`).get(now - ALTERNATES_RECHECK_MS);
      if (!row) return null;
      const sources = this.db.prepare('SELECT uri FROM sources WHERE song_id = ?').all(row.id).map(source => source.uri);
      return { id: row.id, title: row.title, author: row.artist, duration: row.duration, isrc: row.isrc, fingerprint: Buffer.from(row.fingerprint), sources };
    } catch (error) { this.failure('songs_read_failed', error); return null; }
  }

  /** Records an alternates check; `retryAfterMs` brings a failed one back sooner. Never throws. */
  alternatesChecked(id, { now = this.now(), retryAfterMs = null } = {}) {
    if (!this.available) return;
    const at = retryAfterMs === null ? now : now - ALTERNATES_RECHECK_MS + retryAfterMs;
    try { this.db.prepare('UPDATE songs SET alternates_checked_at = ? WHERE id = ?').run(at, id); }
    catch (error) { this.failure('songs_write_failed', error); }
  }

  /**
   * Adds an upload whose audio matched the song's fingerprint. If the upload
   * was already another song, the two are one recording and merge: the older
   * song survives and the other becomes its alias. Never throws.
   * @returns {string|null} the song the source now belongs to
   */
  addVerifiedSource(id, track, similarity, now = this.now()) {
    try {
      if (!this.available) return null;
      const ref = trackReference(track);
      if (!ref || ref.isStream || CATALOGS.has(ref.sourceName)) return null;
      return this.transaction(() => {
        let songId = id;
        // Music recognition only ever upgrades, and before a merge trims sources.
        this.db.prepare('UPDATE sources SET music = MAX(music, ?) WHERE uri = ?').run(musicSong(track), ref.uri);
        const owner = this.db.prepare('SELECT song_id FROM refs WHERE uri = ?').get(ref.uri)?.song_id;
        if (owner && owner !== id) songId = this.mergeRows(id, owner, now);
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE song_id = ?').get(songId).n;
        const known = this.db.prepare('SELECT 1 FROM sources WHERE uri = ?').get(ref.uri);
        if (!known && count >= this.limits.sources) return songId;
        this.db.prepare('INSERT OR IGNORE INTO refs (uri, song_id, added_at) VALUES (?, ?, ?)').run(ref.uri, songId, now);
        this.db.prepare(`INSERT INTO sources (uri, song_id, source_name, identifier, title, author, duration, verification, music, similarity, added_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'audio', ?, ?, ?) ON CONFLICT (uri) DO NOTHING`)
          .run(ref.uri, songId, ref.sourceName, ref.identifier, ref.title, ref.author, ref.duration, musicSong(track), similarity, now);
        return songId;
      });
    } catch (error) { this.failure('songs_write_failed', error); return null; }
  }

  // Inside a transaction: merges two songs and returns the survivor's ID.
  mergeRows(a, b, now) {
    const [survivor, merged] = this.db.prepare('SELECT id FROM songs WHERE id IN (?, ?) ORDER BY created_at, id').all(a, b).map(row => row.id);
    if (!merged) return survivor || a;
    const gone = this.db.prepare('SELECT * FROM songs WHERE id = ?').get(merged);
    this.db.prepare('UPDATE refs SET song_id = ? WHERE song_id = ?').run(survivor, merged);
    this.db.prepare('UPDATE sources SET song_id = ? WHERE song_id = ?').run(survivor, merged);
    this.db.prepare('UPDATE aliases SET song_id = ? WHERE song_id = ?').run(survivor, merged);
    this.db.prepare('INSERT OR REPLACE INTO aliases (alias, song_id, merged_at) VALUES (?, ?, ?)').run(merged, survivor, now);
    this.db.prepare('UPDATE songs SET used_at = MAX(used_at, ?), fingerprint = COALESCE(fingerprint, ?) WHERE id = ?').run(gone.used_at, gone.fingerprint, survivor);
    // The survivor keeps its own catalog link; an unlinked one takes the other's.
    if (gone.catalog_status === 'linked') {
      this.db.prepare(`UPDATE songs SET catalog_status = 'linked', next_lookup_at = NULL, catalog_source = ?, catalog_id = ?, catalog_uri = ?, isrc = ?,
        catalog_title = ?, catalog_artist = ?, album = ?, artwork_url = ?, catalog_duration = ?, linked_at = ? WHERE id = ? AND catalog_status <> 'linked'`)
        .run(gone.catalog_source, gone.catalog_id, gone.catalog_uri, gone.isrc, gone.catalog_title, gone.catalog_artist, gone.album,
          gone.artwork_url, gone.catalog_duration, gone.linked_at, survivor);
    }
    this.db.prepare('DELETE FROM songs WHERE id = ?').run(merged);
    // Within the source budget, keeping what played, then first sources and Music songs. URLs stay mapped.
    this.db.prepare(`DELETE FROM sources WHERE uri IN (SELECT uri FROM sources WHERE song_id = ?
      ORDER BY last_played_at IS NULL, last_played_at DESC, verification = 'first' DESC, music DESC, added_at, uri LIMIT -1 OFFSET ?)`).run(survivor, this.limits.sources);
    return survivor;
  }

  /**
   * The sources to try for a reference's song, best first: last success, then
   * YouTube Music Topic uploads, then the rest. Sources that failed in the last
   * six hours are left out. Empty when the store doesn't know the reference.
   * @returns {{ uri: string, sourceName: string, identifier: string }[]}
   */
  playbackSources(uri, now = this.now()) {
    if (!this.available) return [];
    try {
      return this.db.prepare(`SELECT uri, source_name, identifier FROM sources WHERE song_id = (SELECT song_id FROM refs WHERE uri = ?)
          AND (last_failed_at IS NULL OR last_failed_at <= ? OR (last_played_at IS NOT NULL AND last_played_at > last_failed_at))
        ORDER BY last_played_at IS NULL, last_played_at DESC, music DESC, added_at, uri`)
        .all(uri, now - SOURCE_COOLDOWN_MS).map(row => ({ uri: row.uri, sourceName: row.source_name, identifier: row.identifier }));
    } catch (error) { this.failure('songs_read_failed', error); return []; }
  }

  /** Records whether a source played. Never throws. */
  sourceResult(uri, played, now = this.now()) {
    if (!this.available) return;
    try { this.db.prepare(`UPDATE sources SET ${played ? 'last_played_at' : 'last_failed_at'} = ? WHERE uri = ?`).run(now, uri); }
    catch (error) { this.failure('songs_write_failed', error); }
  }

  // Retention, the song cap, then the file-size guard, each shedding the songs
  // unused for longest. References and sources go with their song. Never throws.
  prune(now = this.now()) {
    if (!this.available) return;
    try {
      const { retentionMs, songs, bytes } = this.limits;
      this.db.exec('DELETE FROM aliases WHERE song_id NOT IN (SELECT id FROM songs)');
      this.transaction(() => {
        this.db.prepare('DELETE FROM songs WHERE used_at < ?').run(now - retentionMs);
        this.db.prepare('DELETE FROM songs WHERE id IN (SELECT id FROM songs ORDER BY used_at DESC, id DESC LIMIT -1 OFFSET ?)').run(songs);
        // Only the most recently used songs keep a fingerprint; the rest are measured again when they play.
        this.db.prepare(`UPDATE songs SET fingerprint = NULL, fingerprinted_at = NULL WHERE fingerprint IS NOT NULL
          AND id NOT IN (SELECT id FROM songs ORDER BY used_at DESC, id DESC LIMIT ?)`).run(this.limits.fingerprints);
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
