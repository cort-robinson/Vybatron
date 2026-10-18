import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { plainText } from './presentation.js';
import { attachSessionSnapshots } from './sessions.js';
import { ListeningState, mirrorDigest } from './listening-state.js';
import { logEvent } from '../runtime.js';

export const LIBRARY_LIMITS = Object.freeze({ favorites: 1000, mixes: 25, mixTracks: 100, queue: 500, history: 100, activity: 200, bytes: 5 * 1024 * 1024, guilds: 1000 });
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ACTIVITY_RETENTION_MS = 24 * 60 * 60_000;
// One size cap is shared by every server, so warn operators well before it fills.
export const LIBRARY_WARNING_RATIO = 0.8;
const LIBRARY_WARNING_INTERVAL_MS = 60 * 60_000;
// Smart autoplay (ADR-0008): off, on, or on only while someone in voice is listening.
export const AUTOPLAY_MODES = Object.freeze(['off', 'on', 'listening']);
export const DEFAULT_SETTINGS = Object.freeze({ volume: 100, fairQueue: false, djRoleId: null, musicTextChannelId: null, autoplay: 'off' });
const SOURCES = new Set(['youtube', 'soundcloud', 'spotify', 'bandcamp']);
const PUBLIC_HOSTS = /^(?:(?:www|music|m)\.)?youtube\.com$|^youtu\.be$|^(?:(?:www|m|on)\.)?soundcloud\.com$|^(?:open\.)?spotify\.com$|^(?:[a-z0-9-]+\.)?bandcamp\.com$/i;

export function validId(value) { return /^\d{1,22}$/.test(String(value || '')); }

export function catalogUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !PUBLIC_HOSTS.test(url.hostname)) return null;
    // Persist public catalog addresses, never cookies, signed audio URLs or tokens.
    if (/youtube\.com$/i.test(url.hostname)) {
      const id = url.searchParams.get('v');
      if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
      const short = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/);
      return short ? `https://www.youtube.com/watch?v=${short[1]}` : null;
    }
    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('/')[0];
      return /^[\w-]{11}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
    }
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

export function trackReference(track) {
  const info = track?.info || track || {};
  const uri = catalogUrl(info.uri);
  if (!uri || !SOURCES.has(info.sourceName)) return null;
  return {
    uri, sourceName: info.sourceName,
    identifier: plainText(info.identifier, { fallback: '', maxLength: 120 }),
    title: plainText(info.title, { fallback: 'Unknown track', maxLength: 180 }),
    author: plainText(info.author, { fallback: 'Unknown artist', maxLength: 120 }),
    duration: Number.isFinite(info.duration) && info.duration >= 0 ? info.duration : 0,
    isStream: Boolean(info.isStream),
  };
}

function emptyGuild() { return { settings: { ...DEFAULT_SETTINGS }, mixes: {}, session: null, history: [], activity: [] }; }
function assertId(value) { if (!validId(value)) throw new Error('A valid Discord ID is required.'); }
function validReference(value) {
  const canonical = trackReference(value);
  if (!canonical || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(canonical).sort())) return false;
  return Object.entries(canonical).every(([key, expected]) => value[key] === expected);
}

const validHistoryItem = item => typeof item?.id === 'string' && item.id.length <= 40 && Number.isSafeInteger(item.playedAt) && item.playedAt >= 0
  && validId(item.voiceChannelId) && validReference(item.track);
const validActivityItem = item => typeof item?.id === 'string' && item.id.length <= 40 && Number.isSafeInteger(item.at) && item.at >= 0 && validId(item.actor?.id)
  && typeof item.actor.displayName === 'string' && item.actor.displayName.length <= 80 && /^[a-z ]{1,40}$/.test(item.action)
  && typeof item.detail === 'string' && item.detail.length <= 120;
const validSession = session => validId(session?.voiceChannelId) && validId(session.textChannelId) && Number.isFinite(session.savedAt) && session.savedAt >= 0
  && Number.isSafeInteger(session.position) && session.position >= 0 && Number.isInteger(session.volume) && session.volume >= 0 && session.volume <= 100
  && typeof session.paused === 'boolean' && ['off', 'track', 'queue'].includes(session.repeatMode)
  && Array.isArray(session.tracks) && session.tracks.length > 0 && session.tracks.length <= LIBRARY_LIMITS.queue + 1 && session.tracks.every(validReference);

function validateDocument(value) {
  const legacy = value?.version === 1;
  if ((!legacy && value?.version !== 2) || !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) throw new Error('Unsupported or damaged music library. Restore the data volume from a backup.');
  if (!legacy) {
    for (const [name, limit] of [['favorites', LIBRARY_LIMITS.favorites], ['favoriteOverflow', Infinity]]) {
      if (!value[name] || typeof value[name] !== 'object' || Array.isArray(value[name])) throw new Error('Invalid favorites collection.');
      for (const [userId, tracks] of Object.entries(value[name])) {
        assertId(userId);
        if (!Array.isArray(tracks) || tracks.length > limit || tracks.some(t => !validReference(t))) throw new Error('Invalid favorites collection.');
      }
    }
  }
  if (Object.keys(value.guilds).length > LIBRARY_LIMITS.guilds) throw new Error('Music library server limit reached.');
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    assertId(guildId);
    const settings = guild.settings;
    if (!legacy && guild.favorites !== undefined) throw new Error('Invalid guild favorites in global music library.');
    if (!settings || !Number.isInteger(settings.volume) || settings.volume < 0 || settings.volume > 100 || typeof settings.fairQueue !== 'boolean' || (settings.djRoleId !== null && !validId(settings.djRoleId)) || (!legacy && settings.musicTextChannelId !== null && !validId(settings.musicTextChannelId))
      // Documents saved before autoplay existed omit the field; migration adds it.
      || (settings.autoplay !== undefined && !AUTOPLAY_MODES.includes(settings.autoplay))) throw new Error('Invalid saved server settings.');
    if (!guild.mixes || typeof guild.mixes !== 'object' || Array.isArray(guild.mixes) || (legacy && (!guild.favorites || typeof guild.favorites !== 'object' || Array.isArray(guild.favorites)))) throw new Error('Invalid saved music collections.');
    for (const [userId, tracks] of Object.entries(legacy ? guild.favorites : {})) {
      assertId(userId);
      if (!Array.isArray(tracks) || tracks.length > 100 || tracks.some(t => !validReference(t))) throw new Error('Invalid favorites collection.');
    }
    if (!legacy) {
      if (!Array.isArray(guild.history) || guild.history.length > LIBRARY_LIMITS.history || !guild.history.every(validHistoryItem)) throw new Error('Invalid saved history.');
      if (!Array.isArray(guild.activity) || guild.activity.length > LIBRARY_LIMITS.activity || !guild.activity.every(validActivityItem)) throw new Error('Invalid saved activity.');
    }
    if (Object.keys(guild.mixes).length > LIBRARY_LIMITS.mixes) throw new Error('Saved mix limit reached.');
    for (const [key, mix] of Object.entries(guild.mixes)) {
      if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(key) || !validId(mix.ownerId) || !Array.isArray(mix.tracks) || !mix.tracks.length || mix.tracks.length > LIBRARY_LIMITS.mixTracks || mix.tracks.some(t => !validReference(t))) throw new Error('Invalid saved mix.');
    }
    if (guild.session && !validSession(guild.session)) throw new Error('Invalid saved listening session.');
  }
  return value;
}

// Adds settings introduced within version 2 with their defaults. Existing
// values are never changed, so older documents keep their behavior.
function withCurrentSettings(document) {
  for (const guild of Object.values(document.guilds)) guild.settings = { ...DEFAULT_SETTINGS, ...guild.settings };
  return document;
}

export function migrateLibrary(value) {
  validateDocument(value);
  if (value.version === 2) return withCurrentSettings(value);
  const migrated = { version: 2, guilds: {}, favorites: {}, favoriteOverflow: {} };
  const merged = new Map();
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    migrated.guilds[guildId] = { ...guild, settings: { ...DEFAULT_SETTINGS, ...guild.settings, musicTextChannelId: null }, history: [], activity: [] };
    delete migrated.guilds[guildId].favorites;
    for (const [userId, tracks] of Object.entries(guild.favorites)) {
      if (!merged.has(userId)) merged.set(userId, new Map());
      for (const reference of tracks) if (!merged.get(userId).has(reference.uri)) merged.get(userId).set(reference.uri, reference);
    }
  }
  for (const [userId, references] of merged) {
    const tracks = [...references.values()];
    migrated.favorites[userId] = tracks.slice(0, LIBRARY_LIMITS.favorites);
    if (tracks.length > LIBRARY_LIMITS.favorites) migrated.favoriteOverflow[userId] = tracks.slice(LIBRARY_LIMITS.favorites);
  }
  return validateDocument(migrated);
}

// Server history, activity and session checkpoints live in the listening state
// store (ADR-0009). library.json keeps their last mirror so older images still
// open it after a rollback; the mirror is rewritten only at shutdown.
const LISTENING_FIELDS = ['history', 'activity', 'session'];
const RETENTION = Object.freeze({
  history: { maxAgeMs: HISTORY_RETENTION_MS, limit: LIBRARY_LIMITS.history },
  activity: { maxAgeMs: ACTIVITY_RETENTION_MS, limit: LIBRARY_LIMITS.activity },
});
export const LISTENING_STATE_BACKUP = '.pre-listening-state.bak';
const mirrorOf = guild => ({ history: guild?.history || [], activity: guild?.activity || [], session: guild?.session || null });
function documentPart(guild) {
  const part = { ...guild };
  for (const field of LISTENING_FIELDS) delete part[field];
  return part;
}
// Bytes each mirrored field adds to library.json beyond its empty value.
const FIELD_BYTES = { history: value => Buffer.byteLength(JSON.stringify(value)) - 2, activity: value => Buffer.byteLength(JSON.stringify(value)) - 2,
  session: value => Buffer.byteLength(JSON.stringify(value ?? null)) - 4 };
const withoutMirrors = document => ({ ...document, guilds: Object.fromEntries(Object.entries(document.guilds).map(([id, guild]) => [id, { ...guild, ...mirrorOf(null) }])) });
const FULL = 'Music library is full. Remove unused favorites or mixes.';
function assertListening(guild) {
  if (!Array.isArray(guild.history) || !guild.history.every(validHistoryItem)) throw new Error('Invalid saved history.');
  if (!Array.isArray(guild.activity) || !guild.activity.every(validActivityItem)) throw new Error('Invalid saved activity.');
  if (guild.session && !validSession(guild.session)) throw new Error('Invalid saved listening session.');
}

// One transaction queue and atomic replacement: failed disk writes never publish
// a half-saved library in memory, and simultaneous saves cannot lose each other.
export class MusicLibrary {
  constructor(filePath, { io = fs, statePath, sqlite, logger = console, now = Date.now } = {}) {
    this.filePath = filePath; this.io = io; this.logger = logger; this.now = now;
    this.warnedAt = -Infinity;
    this.state = new ListeningState(statePath ?? path.join(path.dirname(filePath), 'listening-state.sqlite'), { retention: RETENTION, sqlite, logger });
    this.document = { version: 2, guilds: {}, favorites: {}, favoriteOverflow: {} };
    this.pending = Promise.resolve();
    // The shutdown mirror must fit library.json, so listening state shares its
    // size cap, as it did inside the document (ADR-0009).
    this.baseBytes = Buffer.byteLength(JSON.stringify(this.document)); this.mirrorBytes = new Map();
  }
  async open() {
    await this.io.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let json = null;
    try {
      const stat = await this.io.stat(this.filePath);
      if (stat.size > LIBRARY_LIMITS.bytes) throw new Error('Music library exceeds its size limit.');
      json = await this.io.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (json !== null) {
      const original = validateDocument(JSON.parse(json));
      const migrated = migrateLibrary(original);
      if (original.version === 1) {
        // Exact original bytes are durable before atomic replacement. A failed
        // migration keeps v1 readable and never silently drops overflow.
        await this.backup(`${this.filePath}.v1.${randomUUID()}.bak`, json);
        await this.writeDocument(migrated);
        json = JSON.stringify(migrated);
      }
      this.document = migrated;
    }
    this.baseBytes = Buffer.byteLength(JSON.stringify(withoutMirrors(this.document)));
    await this.state.open();
    try { await this.initializeState(json); }
    catch (error) {
      // Listening state never blocks startup: run from memory seeded from library.json.
      if (!this.state.durable) { this.state.close(); throw error; }
      this.state.fallBack(error);
      await this.initializeState(json);
    }
    this.warnIfNearlyFull();
    return this;
  }
  async initializeState(json) {
    // Backup first: exact bytes before the first adoption, never overwritten.
    if (this.state.durable && !this.state.meta('adopted') && json !== null) await this.publishBackup(`${this.filePath}${LISTENING_STATE_BACKUP}`, json);
    this.state.adopt(Object.entries(this.document.guilds).map(([id, guild]) => [id, mirrorOf(guild)]));
    if (this.state.durable && !this.state.meta('adopted')) this.state.meta('adopted', Date.now());
    this.state.prune();
    this.measure();
    this.fitMirror();
  }
  // Adopting an older image's mirror can add history the store already had.
  // Shed the oldest listening state until the mirror fits library.json again.
  // It can also add servers: keep the most recently active listening-only ones.
  fitMirror() {
    while (this.projectedBytes() > LIBRARY_LIMITS.bytes && this.state.shedOldest()) this.measure();
    const extra = this.guildIds().length - LIBRARY_LIMITS.guilds;
    if (extra <= 0) return;
    const latest = ({ history, activity, session }) => Math.max(0, history[0]?.playedAt ?? 0, activity[0]?.at ?? 0, session?.savedAt ?? 0);
    const listeningOnly = this.state.guildIds().filter(guildId => !this.document.guilds[guildId])
      .map(guildId => [guildId, latest(this.state.read(guildId))]).sort((a, b) => a[1] - b[1]);
    this.state.transaction(() => { for (const [guildId] of listeningOnly.slice(0, extra)) this.state.forget(guildId); });
    this.measure();
  }
  async backup(file, json) {
    const backup = await this.io.open(file, 'wx', 0o600);
    try { await backup.writeFile(json); await backup.sync(); } finally { await backup.close(); }
  }
  // Only a complete, synced backup ever appears under its final name.
  async publishBackup(file, json) {
    try { await this.io.stat(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await this.backup(temporary, json); await this.io.rename(temporary, file); }
    finally { await this.io.unlink(temporary).catch(() => {}); }
  }
  // Records how many bytes each guild's mirror adds to library.json.
  measure(guildIds, fields = LISTENING_FIELDS) {
    // A full measurement starts over, so guilds pruned away stop counting.
    if (!guildIds) { this.mirrorBytes = new Map(); guildIds = this.guildIds(); }
    for (const guildId of guildIds) {
      const state = this.state.read(guildId);
      const sizes = { ...this.mirrorBytes.get(guildId) };
      for (const field of fields) sizes[field] = FIELD_BYTES[field](state[field]);
      this.mirrorBytes.set(guildId, sizes);
    }
  }
  projectedBytes(baseBytes = this.baseBytes, document = this.document) {
    let total = baseBytes;
    for (const [guildId, sizes] of this.mirrorBytes) {
      const bytes = (sizes.history || 0) + (sizes.activity || 0) + (sizes.session || 0);
      if (!bytes) continue;
      total += bytes + (document.guilds[guildId] ? 0 : Buffer.byteLength(`,"${guildId}":${JSON.stringify(emptyGuild())}`));
    }
    return total;
  }
  // Applies one listening change and keeps it only if the mirror still fits.
  writeListening(guildId, fields, write) {
    const previous = this.mirrorBytes.get(guildId);
    try {
      this.state.transaction(() => {
        write();
        this.measure([guildId], fields);
        if (this.projectedBytes() > LIBRARY_LIMITS.bytes) throw new Error(FULL);
      });
    } catch (error) {
      if (previous) this.mirrorBytes.set(guildId, previous); else this.mirrorBytes.delete(guildId);
      throw error;
    }
    this.warnIfNearlyFull();
  }
  // Size only: no server, listener or track details. Counts listening state as
  // the shutdown mirror will store it.
  capacity() { return { bytes: this.projectedBytes(), limitBytes: LIBRARY_LIMITS.bytes }; }
  warnIfNearlyFull() {
    const now = this.now(), bytes = this.projectedBytes();
    if (bytes < LIBRARY_LIMITS.bytes * LIBRARY_WARNING_RATIO || now - this.warnedAt < LIBRARY_WARNING_INTERVAL_MS) return;
    this.warnedAt = now;
    this.logger.warn(`[Library] Music library is ${Math.floor(bytes / LIBRARY_LIMITS.bytes * 100)}% full (${bytes} of ${LIBRARY_LIMITS.bytes} bytes). Saves fail for every server once it is full.`);
  }
  guildIds() { return [...new Set([...Object.keys(this.document.guilds), ...this.state.guildIds()])]; }
  readGuild(guildId) {
    assertId(guildId);
    return { ...structuredClone(documentPart(this.document.guilds[guildId] || emptyGuild())), ...this.state.read(guildId) };
  }
  settings(guildId) { assertId(guildId); return { ...DEFAULT_SETTINGS, ...this.document.guilds[guildId]?.settings }; }
  favorites(userId) { assertId(userId); return structuredClone(this.document.favorites[userId] || []); }
  favoriteOverflowCount(userId) { assertId(userId); return this.document.favoriteOverflow[userId]?.length || 0; }
  async writeDocument(draft) {
    validateDocument(draft);
    let json = JSON.stringify(draft);
    const baseBytes = Buffer.byteLength(JSON.stringify(withoutMirrors(draft)));
    if (this.projectedBytes(baseBytes, draft) > LIBRARY_LIMITS.bytes) throw new Error(FULL);
    let digests = null;
    if (Buffer.byteLength(json) > LIBRARY_LIMITS.bytes && this.state.db) {
      // Only the frozen mirror is too large (retention has since shrunk it): refresh it.
      digests = this.refreshMirrors(draft).digests;
      validateDocument(draft);
      json = JSON.stringify(draft);
    }
    if (Buffer.byteLength(json) > LIBRARY_LIMITS.bytes) throw new Error(FULL);
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const file = await this.io.open(temporary, 'wx', 0o600);
      try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
      await this.io.rename(temporary, this.filePath);
    } finally { await this.io.unlink(temporary).catch(() => {}); }
    this.baseBytes = baseBytes;
    if (digests) this.state.markMirrored(digests);
    this.warnIfNearlyFull();
  }
  // Copies the store's current state into a draft's mirror fields.
  refreshMirrors(draft) {
    const digests = [];
    let changed = false;
    for (const guildId of this.guildIds()) {
      const mirror = this.state.read(guildId);
      const digest = mirrorDigest(mirror);
      digests.push([guildId, digest]);
      if (mirrorDigest(mirrorOf(draft.guilds[guildId])) === digest) continue;
      Object.assign(draft.guilds[guildId] ||= emptyGuild(), mirror);
      changed = true;
    }
    return { digests, changed };
  }
  transact(work) {
    const transaction = this.pending.catch(() => {}).then(work);
    this.pending = transaction;
    return transaction;
  }
  async updateDocument(mutate) {
    return this.transact(async () => {
      const draft = structuredClone(this.document);
      const result = await mutate(draft);
      await this.writeDocument(draft);
      this.document = draft;
      return result;
    });
  }
  assertGuildCapacity(guildId) {
    if (this.document.guilds[guildId]) return;
    const known = this.guildIds();
    if (known.length >= LIBRARY_LIMITS.guilds && !known.includes(guildId)) throw new Error('Music library server limit reached.');
  }
  // The guild keeps its usual shape. Only changed parts are written: settings
  // and mixes to library.json, listening state to its store.
  async updateGuild(guildId, mutate) {
    assertId(guildId);
    return this.transact(async () => {
      const stored = this.document.guilds[guildId];
      const guild = { ...structuredClone(stored || emptyGuild()), ...this.state.read(guildId) };
      const before = { document: JSON.stringify(documentPart(guild)), ...Object.fromEntries(LISTENING_FIELDS.map(field => [field, JSON.stringify(guild[field])])) };
      const result = await mutate(guild);
      const changed = LISTENING_FIELDS.filter(field => JSON.stringify(guild[field]) !== before[field]);
      if (changed.length) { assertListening(guild); this.assertGuildCapacity(guildId); }
      if (JSON.stringify(documentPart(guild)) !== before.document) {
        this.assertGuildCapacity(guildId);
        const draft = structuredClone(this.document);
        draft.guilds[guildId] = { ...structuredClone(documentPart(guild)), ...mirrorOf(stored) };
        await this.writeDocument(draft);
        this.document = draft;
      }
      if (changed.length) this.writeListening(guildId, changed, () => this.state.replace(guildId, Object.fromEntries(changed.map(field => [field, guild[field] ?? null]))));
      return result;
    });
  }
  async updateFavorites(userId, mutate, { clearOverflow = false } = {}) {
    assertId(userId);
    return this.updateDocument(async draft => {
      const list = draft.favorites[userId] ||= [];
      const result = await mutate(list);
      if (clearOverflow) delete draft.favoriteOverflow[userId];
      const overflow = draft.favoriteOverflow[userId] || [];
      while (list.length < LIBRARY_LIMITS.favorites && overflow.length) list.push(overflow.shift());
      if (!overflow.length) delete draft.favoriteOverflow[userId];
      return result;
    });
  }
  async recordHistory(player, track) {
    const reference = trackReference(track);
    if (!reference || !validId(player?.voiceChannelId) || !validId(player?.guildId)) return;
    const item = { id: randomUUID(), playedAt: Date.now(), voiceChannelId: player.voiceChannelId, track: reference };
    return this.transact(() => { this.assertGuildCapacity(player.guildId); this.writeListening(player.guildId, ['history'], () => this.state.add('history', player.guildId, item)); });
  }
  async recordActivity(guildId, actor, action) {
    if (!validId(actor?.id)) return;
    assertId(guildId);
    const item = { id: randomUUID(), at: Date.now(), actor: { id: actor.id, displayName: plainText(actor.globalName || actor.displayName || actor.username, { maxLength: 80 }) }, action, detail: action === 'settings' ? 'Listening defaults updated.' : 'Listening queue updated.' };
    if (!validActivityItem(item)) throw new Error('Invalid saved activity.');
    return this.transact(() => { this.assertGuildCapacity(guildId); this.writeListening(guildId, ['activity'], () => this.state.add('activity', guildId, item)); });
  }
  /**
   * Save, or clear with null, a guild's session checkpoint.
   * @param {{ skip?: (saved: object|null) => boolean }} [options] skip sees the stored checkpoint; true leaves it.
   */
  async saveSession(guildId, session, { skip } = {}) {
    assertId(guildId);
    if (session && !validSession(session)) throw new Error('Invalid saved listening session.');
    return this.transact(() => {
      if (skip?.(this.state.read(guildId).session)) return;
      if (session) this.assertGuildCapacity(guildId); this.writeListening(guildId, ['session'], () => this.state.setSession(guildId, session)); });
  }
  // Rewrites the library.json mirror where it differs from the store, then
  // records it so the next start adopts nothing. A mirror that does not fit is
  // skipped: the store keeps the data and the previous mirror stays recorded.
  async mirror() {
    return this.transact(async () => {
      const draft = structuredClone(this.document);
      const { digests, changed } = this.refreshMirrors(draft);
      if (changed) { await this.writeDocument(draft); this.document = draft; }
      this.state.markMirrored(digests);
      return changed;
    });
  }
  maintain() {
    try { this.state.prune(); this.measure(); this.fitMirror(); } catch (error) { logEvent(this.logger, 'error', 'listening_state_prune_failed', error); }
    // A store running from memory has only library.json to survive a restart.
    if (!this.state.durable) void this.mirror().catch(error => logEvent(this.logger, 'error', 'listening_state_mirror_failed', error));
  }
  async close() {
    clearInterval(this.retentionTimer);
    // A checkpoint that cannot be saved must not cost every guild its mirror.
    try { await this.stopSnapshots?.(); } catch (error) { logEvent(this.logger, 'error', 'listening_state_checkpoint_failed', error); }
    await this.pending.catch(() => {});
    if (!this.state.db) return;
    // Compact before the pre-deploy snapshot copies the volume.
    try { this.state.prune(); } catch (error) { logEvent(this.logger, 'error', 'listening_state_prune_failed', error); }
    try { await this.mirror(); } catch (error) { logEvent(this.logger, 'error', 'listening_state_mirror_failed', error); }
    this.state.close();
  }
}

export async function initializeLibrary(client) {
  const dataDir = config.dataDir || path.resolve(process.env.VYBERTRON_DATA_DIR || 'data');
  client.library = await new MusicLibrary(path.join(dataDir, 'library.json')).open();
  client.library.stopSnapshots = attachSessionSnapshots(client);
  client.library.retentionTimer = setInterval(() => client.library.maintain(), 60 * 60_000);
  client.library.retentionTimer.unref?.();
  return client.library;
}
