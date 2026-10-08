import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { plainText } from './presentation.js';
import { attachSessionSnapshots } from './sessions.js';

export const LIBRARY_LIMITS = Object.freeze({ favorites: 1000, mixes: 25, mixTracks: 100, queue: 500, history: 100, activity: 200, bytes: 5 * 1024 * 1024, guilds: 1000 });
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const ACTIVITY_RETENTION_MS = 24 * 60 * 60_000;
// Smart autoplay (ADR-0007): off, on, or on only while someone in voice is listening.
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
      if (!Array.isArray(guild.history) || guild.history.length > LIBRARY_LIMITS.history || guild.history.some(item =>
        typeof item.id !== 'string' || item.id.length > 40 || !Number.isSafeInteger(item.playedAt) || item.playedAt < 0 || !validId(item.voiceChannelId) || !validReference(item.track))) throw new Error('Invalid saved history.');
      if (!Array.isArray(guild.activity) || guild.activity.length > LIBRARY_LIMITS.activity || guild.activity.some(item =>
        typeof item.id !== 'string' || item.id.length > 40 || !Number.isSafeInteger(item.at) || item.at < 0 || !validId(item.actor?.id)
        || typeof item.actor.displayName !== 'string' || item.actor.displayName.length > 80 || !/^[a-z ]{1,40}$/.test(item.action)
        || typeof item.detail !== 'string' || item.detail.length > 120)) throw new Error('Invalid saved activity.');
    }
    if (Object.keys(guild.mixes).length > LIBRARY_LIMITS.mixes) throw new Error('Saved mix limit reached.');
    for (const [key, mix] of Object.entries(guild.mixes)) {
      if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(key) || !validId(mix.ownerId) || !Array.isArray(mix.tracks) || !mix.tracks.length || mix.tracks.length > LIBRARY_LIMITS.mixTracks || mix.tracks.some(t => !validReference(t))) throw new Error('Invalid saved mix.');
    }
    if (guild.session) {
      const session = guild.session;
      if (!validId(session.voiceChannelId) || !validId(session.textChannelId) || !Number.isFinite(session.savedAt) || session.savedAt < 0
        || !Number.isSafeInteger(session.position) || session.position < 0 || !Number.isInteger(session.volume) || session.volume < 0 || session.volume > 100
        || typeof session.paused !== 'boolean' || !['off', 'track', 'queue'].includes(session.repeatMode)
        || !Array.isArray(session.tracks) || !session.tracks.length || session.tracks.length > LIBRARY_LIMITS.queue + 1 || session.tracks.some(t => !validReference(t))) throw new Error('Invalid saved listening session.');
    }
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

function prune(guild, now = Date.now()) {
  guild.history = guild.history.filter(item => item.playedAt <= now + 60_000 && now - item.playedAt <= HISTORY_RETENTION_MS).slice(0, LIBRARY_LIMITS.history);
  guild.activity = guild.activity.filter(item => item.at <= now + 60_000 && now - item.at <= ACTIVITY_RETENTION_MS).slice(0, LIBRARY_LIMITS.activity);
}

// One transaction queue and atomic replacement: failed disk writes never publish
// a half-saved library in memory, and simultaneous saves cannot lose each other.
export class MusicLibrary {
  constructor(filePath, { io = fs } = {}) {
    this.filePath = filePath; this.io = io;
    this.document = { version: 2, guilds: {}, favorites: {}, favoriteOverflow: {} };
    this.pending = Promise.resolve();
  }
  async open() {
    await this.io.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    let json;
    try {
      const stat = await this.io.stat(this.filePath);
      if (stat.size > LIBRARY_LIMITS.bytes) throw new Error('Music library exceeds its size limit.');
      json = await this.io.readFile(this.filePath, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return this; throw error; }
    const original = validateDocument(JSON.parse(json));
    const migrated = migrateLibrary(original);
    const beforePrune = JSON.stringify(migrated);
    for (const guild of Object.values(migrated.guilds)) prune(guild);
    if (original.version === 1) {
      // Exact original bytes are durable before atomic replacement. A failed
      // migration keeps v1 readable and never silently drops overflow.
      const backup = await this.io.open(`${this.filePath}.v1.${randomUUID()}.bak`, 'wx', 0o600);
      try { await backup.writeFile(json); await backup.sync(); } finally { await backup.close(); }
      await this.writeDocument(migrated);
    } else if (beforePrune !== JSON.stringify(migrated)) await this.writeDocument(migrated);
    this.document = migrated;
    return this;
  }
  readGuild(guildId) { assertId(guildId); const guild = structuredClone(this.document.guilds[guildId] || emptyGuild()); prune(guild); return guild; }
  settings(guildId) { assertId(guildId); return { ...DEFAULT_SETTINGS, ...this.document.guilds[guildId]?.settings }; }
  favorites(userId) { assertId(userId); return structuredClone(this.document.favorites[userId] || []); }
  favoriteOverflowCount(userId) { assertId(userId); return this.document.favoriteOverflow[userId]?.length || 0; }
  async writeDocument(draft) {
    validateDocument(draft);
    const json = JSON.stringify(draft);
    if (Buffer.byteLength(json) > LIBRARY_LIMITS.bytes) throw new Error('Music library is full. Remove unused favorites or mixes.');
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const file = await this.io.open(temporary, 'wx', 0o600);
      try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
      await this.io.rename(temporary, this.filePath);
    } finally { await this.io.unlink(temporary).catch(() => {}); }
  }
  async updateDocument(mutate) {
    const transaction = this.pending.catch(() => {}).then(async () => {
      const draft = structuredClone(this.document);
      const result = await mutate(draft);
      for (const guild of Object.values(draft.guilds)) prune(guild);
      await this.writeDocument(draft);
      this.document = draft;
      return result;
    });
    this.pending = transaction;
    return transaction;
  }
  async updateGuild(guildId, mutate) {
    assertId(guildId);
    return this.updateDocument(async draft => {
      const guild = draft.guilds[guildId] ||= emptyGuild();
      return mutate(guild);
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
    return this.updateGuild(player.guildId, guild => { guild.history.unshift(item); guild.history.length = Math.min(guild.history.length, LIBRARY_LIMITS.history); });
  }
  async recordActivity(guildId, actor, action) {
    if (!validId(actor?.id)) return;
    const item = { id: randomUUID(), at: Date.now(), actor: { id: actor.id, displayName: plainText(actor.globalName || actor.displayName || actor.username, { maxLength: 80 }) }, action, detail: action === 'settings' ? 'Listening defaults updated.' : 'Listening queue updated.' };
    return this.updateGuild(guildId, guild => { guild.activity.unshift(item); guild.activity.length = Math.min(guild.activity.length, LIBRARY_LIMITS.activity); });
  }
  async close() { clearInterval(this.retentionTimer); await this.stopSnapshots?.(); await this.pending; }
}

export async function initializeLibrary(client) {
  const dataDir = config.dataDir || path.resolve(process.env.VYBERTRON_DATA_DIR || 'data');
  client.library = await new MusicLibrary(path.join(dataDir, 'library.json')).open();
  client.library.stopSnapshots = attachSessionSnapshots(client);
  client.library.retentionTimer = setInterval(() => {
    void client.library.updateDocument(() => {}).catch(() => console.error('[Library] Retention cleanup failed.'));
  }, 60 * 60_000);
  client.library.retentionTimer.unref?.();
  return client.library;
}
