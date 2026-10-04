import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { plainText } from './presentation.js';
import { attachSessionSnapshots } from './sessions.js';

export const LIBRARY_LIMITS = Object.freeze({ favorites: 100, mixes: 25, mixTracks: 100, queue: 500, bytes: 5 * 1024 * 1024, guilds: 1000 });
export const DEFAULT_SETTINGS = Object.freeze({ volume: 100, fairQueue: false, djRoleId: null });
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

function emptyGuild() { return { settings: { ...DEFAULT_SETTINGS }, favorites: {}, mixes: {}, session: null }; }
function assertId(value) { if (!validId(value)) throw new Error('A valid Discord ID is required.'); }
function validReference(value) {
  const canonical = trackReference(value);
  if (!canonical || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(Object.keys(canonical).sort())) return false;
  return Object.entries(canonical).every(([key, expected]) => value[key] === expected);
}

function validateDocument(value) {
  if (value?.version !== 1 || !value.guilds || typeof value.guilds !== 'object' || Array.isArray(value.guilds)) throw new Error('Unsupported or damaged music library. Restore the data volume from a backup.');
  if (Object.keys(value.guilds).length > LIBRARY_LIMITS.guilds) throw new Error('Music library server limit reached.');
  for (const [guildId, guild] of Object.entries(value.guilds)) {
    assertId(guildId);
    const settings = guild.settings;
    if (!settings || !Number.isInteger(settings.volume) || settings.volume < 0 || settings.volume > 100 || typeof settings.fairQueue !== 'boolean' || (settings.djRoleId !== null && !validId(settings.djRoleId))) throw new Error('Invalid saved server settings.');
    if (!guild.favorites || !guild.mixes || typeof guild.favorites !== 'object' || Array.isArray(guild.favorites) || typeof guild.mixes !== 'object' || Array.isArray(guild.mixes)) throw new Error('Invalid saved music collections.');
    for (const [userId, tracks] of Object.entries(guild.favorites)) {
      assertId(userId);
      if (!Array.isArray(tracks) || tracks.length > LIBRARY_LIMITS.favorites || tracks.some(t => !validReference(t))) throw new Error('Invalid favorites collection.');
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

// One transaction queue and atomic replacement: failed disk writes never publish
// a half-saved library in memory, and simultaneous saves cannot lose each other.
export class MusicLibrary {
  constructor(filePath, { io = fs } = {}) {
    this.filePath = filePath; this.io = io;
    this.document = { version: 1, guilds: {} };
    this.pending = Promise.resolve();
  }
  async open() {
    await this.io.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const stat = await this.io.stat(this.filePath);
      if (stat.size > LIBRARY_LIMITS.bytes) throw new Error('Music library exceeds its size limit.');
      this.document = validateDocument(JSON.parse(await this.io.readFile(this.filePath, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this;
  }
  readGuild(guildId) { assertId(guildId); return structuredClone(this.document.guilds[guildId] || emptyGuild()); }
  settings(guildId) { assertId(guildId); return { ...(this.document.guilds[guildId]?.settings || DEFAULT_SETTINGS) }; }
  async updateGuild(guildId, mutate) {
    assertId(guildId);
    const transaction = this.pending.catch(() => {}).then(async () => {
      const draft = structuredClone(this.document);
      const guild = draft.guilds[guildId] ||= emptyGuild();
      const result = await mutate(guild);
      validateDocument(draft);
      const json = JSON.stringify(draft);
      if (Buffer.byteLength(json) > LIBRARY_LIMITS.bytes) throw new Error('Music library is full. Remove unused favorites or mixes.');
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        const file = await this.io.open(temporary, 'wx', 0o600);
        try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
        await this.io.rename(temporary, this.filePath);
      } finally { await this.io.unlink(temporary).catch(() => {}); }
      this.document = draft;
      return result;
    });
    this.pending = transaction;
    return transaction;
  }
  async close() { await this.stopSnapshots?.(); await this.pending; }
}

export async function initializeLibrary(client) {
  const dataDir = config.dataDir || path.resolve(process.env.VYBERTRON_DATA_DIR || 'data');
  client.library = await new MusicLibrary(path.join(dataDir, 'library.json')).open();
  client.library.stopSnapshots = attachSessionSnapshots(client);
  return client.library;
}
