import { api } from './api';
import type { Track } from './types';
import type { NativePlayer } from './native';

// The listener's one player, shared by their devices (ADR-0018, docs/portal-contract.md).
// The bot's store keeps it; the portal pushes every change to each device's
// listener stream and relays controls to the device that plays.
export type Repeat = 'off' | 'track' | 'queue';
export type PlayerTrack = Omit<Track, 'requestedBy' | 'suggested'>;
export interface PlayerEntry { entryId: string; track: PlayerTrack }
export interface Playhead { positionMs: number; at: number; playing: boolean }
export interface Player {
  guildId: string | null; revision: number; generation: number; generationAt: number; activeDeviceId: string | null; playbackVersion: number;
  current: PlayerEntry | null; queue: PlayerEntry[]; history: PlayerEntry[]; playhead: Playhead; volume: number; repeat: Repeat; updatedAt: number;
}
export type DeviceKind = 'browser' | 'android' | 'tv';
export interface Device { deviceId: string; name: string; kind: DeviceKind; lastSeen: number; connected: boolean; active: boolean }
export interface PlayerView { player: Player; devices: Device[] }
export type ControlAction = 'play' | 'pause' | 'seek' | 'next' | 'previous' | 'volume' | 'repeat';
export interface PlayerCommand { action: ControlAction; value?: number | Repeat; generation: number }
// What the active device reports about a song change.
export interface Advance { from: string | null; to: string | null; track?: PlayerTrack }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const entry = (value: unknown) => object(value) && typeof value.entryId === 'string' && object(value.track) && typeof value.track.id === 'string' && typeof value.track.title === 'string';
export function validPlayer(value: unknown): value is Player {
  return object(value) && count(value.revision) && count(value.generation) && count(value.updatedAt) && (value.activeDeviceId === null || typeof value.activeDeviceId === 'string')
    && (value.current === null || entry(value.current)) && Array.isArray(value.queue) && value.queue.every(entry) && Array.isArray(value.history) && value.history.every(entry)
    && object(value.playhead) && Number.isFinite(value.playhead.positionMs) && Number.isFinite(value.playhead.at) && typeof value.playhead.playing === 'boolean';
}
export function validView(value: unknown): value is PlayerView {
  return object(value) && validPlayer(value.player) && Array.isArray(value.devices)
    && value.devices.every(device => object(device) && typeof device.deviceId === 'string' && typeof device.name === 'string');
}

/** Where the playhead is at server time `now`. */
export function playheadAt(player: Player, now: number) {
  const { positionMs, at, playing } = player.playhead;
  const position = playing && player.activeDeviceId ? positionMs + Math.max(0, now - at) : positionMs;
  const duration = player.current?.track.durationMs;
  return Math.max(0, Math.floor(duration ? Math.min(position, duration) : position));
}

// A song as the player keeps it; one the store can't take (no public https link) is left out.
const https = (value: string | null | undefined) => typeof value === 'string' && value.startsWith('https://');
export function playerTrack(track: Track | PlayerTrack): PlayerTrack | null {
  if (!https(track.uri)) return null;
  const { id, title, author, uri, source, durationMs, artworkUrl, isStream } = track;
  return { id, title, author, uri, source: source || 'unknown', durationMs: Math.max(0, Math.floor(durationMs || 0)), artworkUrl: https(artworkUrl) ? artworkUrl : null, isStream: !!isStream };
}
export const asTrack = (track: PlayerTrack): Track => ({ ...track, requestedBy: null });
// Songs go to the store at most 50 at a time, and each request stays inside the portal's 16 KiB body limit.
export function batches<T>(items: T[], limit = 50, budget = 12_000): T[][] {
  const out: T[][] = []; let batch: T[] = []; let size = 0;
  for (const item of items) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
    if (batch.length && (batch.length >= limit || size + bytes > budget)) { out.push(batch); batch = []; size = 0; }
    batch.push(item); size += bytes;
  }
  if (batch.length) out.push(batch);
  return out;
}

/**
 * A song change, applied the way the store applies it, for showing a change this
 * device made before the store confirms it. Applying it again changes nothing.
 */
export function advanced(player: Player, { from, to, track }: Advance): Player {
  if ((player.current?.entryId ?? null) === to) return player;
  let queue = player.queue; let history = player.history; let next: PlayerEntry | null = null; let back = false;
  if (to !== null) {
    const queued = queue.findIndex(item => item.entryId === to); const played = history.findIndex(item => item.entryId === to);
    if (queued >= 0) { next = queue[queued]; queue = queue.filter((_, index) => index !== queued); }
    else if (played >= 0) { next = history[played]; history = history.filter((_, index) => index !== played); back = true; }
    else if (track) next = { entryId: to, track };
    else return player;
  }
  const done = player.current;
  if (done && !back && done.entryId === from) history = [done, ...history].slice(0, 50);
  else if (done) queue = [done, ...queue].slice(0, 500);
  return { ...player, current: next, queue, history, playhead: { positionMs: 0, at: player.playhead.at, playing: !!next } };
}

// This device: a random ID kept in its storage, and a name the listener can change.
const DEVICE_KEY = 'vybertron.device';
export interface Identity { deviceId: string; name: string; kind: DeviceKind }
const randomId = (bytes: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const newEntryId = () => randomId(9);
export function defaultName(agent = navigator.userAgent) {
  const browser = /Edg\//.test(agent) ? 'Edge' : /OPR\//.test(agent) ? 'Opera' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
  const platform = /Android/.test(agent) ? 'Android' : /iPhone|iPad|iPod/.test(agent) ? 'iOS' : /CrOS/.test(agent) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(agent) ? 'macOS'
    : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return platform ? `${browser} on ${platform}` : browser;
}
export const validName = (value: string) => { const name = value.trim(); return name && name.length <= 40 && !/[\0-\x1f\x7f]/.test(name) ? name : null; };
function storedIdentity(): Partial<Identity> {
  try { const saved = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null'); return saved && typeof saved === 'object' ? saved : {}; } catch { return {}; }
}
export function saveIdentity(identity: Identity) {
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify({ deviceId: identity.deviceId, name: identity.name })); } catch { /* A new ID next time; the old one is forgotten after 30 days. */ }
}
/** This device's ID and name. Inside the Android app it is the app (ADR-0016's `app.info`). */
export async function loadIdentity(device: NativePlayer | null): Promise<Identity> {
  let kind: DeviceKind = 'browser';
  if (device) kind = await device.info().then(info => info.platform === 'android' ? 'android' as const : 'browser' as const, () => 'android' as const);
  const saved = storedIdentity();
  const deviceId = typeof saved.deviceId === 'string' && /^[\w-]{22}$/.test(saved.deviceId) ? saved.deviceId : randomId(16);
  const name = (typeof saved.name === 'string' && validName(saved.name)) || (kind === 'android' ? 'Android app' : defaultName());
  const identity = { deviceId, name, kind };
  saveIdentity(identity);
  return identity;
}

// One shared clock: the server's time, measured with round trips; the shortest one wins.
export const clock = {
  offset: 0, uncertainty: Infinity,
  now: () => Date.now() + clock.offset,
  local: (server: number) => server - clock.offset,
};
export async function syncClock(signal?: AbortSignal, samples = 5) {
  let best: { rtt: number; offset: number } | null = null;
  for (let index = 0; index < samples && !signal?.aborted; index++) {
    const sent = Date.now(); const started = performance.now();
    try {
      const { now } = await api.time(signal);
      const rtt = performance.now() - started;
      if (Number.isFinite(now) && (!best || rtt < best.rtt)) best = { rtt, offset: now - (sent + rtt / 2) };
    } catch { /* A lost sample; the others still count. */ }
  }
  if (best && !signal?.aborted) { clock.offset = best.offset; clock.uncertainty = best.rtt / 2; }
}

// The last player this browser saw, kept only to show the same listener before their stream connects.
const CACHE_KEY = 'vybertron.player.';
export function cachedView(actorId: string): PlayerView | null {
  try { const saved = JSON.parse(localStorage.getItem(CACHE_KEY + actorId) || 'null'); return validView(saved) ? saved : null; } catch { return null; }
}
export function cacheView(actorId: string, view: PlayerView) {
  try { localStorage.setItem(CACHE_KEY + actorId, JSON.stringify(view)); } catch { /* Shown again once the stream connects. */ }
}
export function forgetCachedViews() {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(CACHE_KEY)) localStorage.removeItem(key); } catch { /* Nothing stored. */ }
}

// The old per-browser deck, which belongs to no account (ADR-0018: asked about once, then deleted).
export const LEGACY_DECK_KEY = 'vybertron.local';
export interface LegacyDeck { current: PlayerTrack | null; tracks: PlayerTrack[]; positionMs: number; volume?: number; repeat?: Repeat; songs: number }
export function legacyDeck(): LegacyDeck | null {
  try {
    const saved = JSON.parse(localStorage.getItem(LEGACY_DECK_KEY) || 'null');
    if (!object(saved)) { if (saved !== null) forgetLegacyDeck(); return null; }
    const songs = (value: unknown) => Array.isArray(value) ? value.filter(item => object(item) && typeof item.id === 'string' && typeof item.title === 'string').map(item => playerTrack(item as unknown as Track)).filter((item): item is PlayerTrack => !!item) : [];
    const current = object(saved.current) && typeof saved.current.id === 'string' ? playerTrack(saved.current as unknown as Track) : null;
    const tracks = songs(saved.queue);
    if (!current && !tracks.length) { forgetLegacyDeck(); return null; }
    const volume = Number(saved.volume); const repeat = saved.repeat;
    return { current, tracks, positionMs: current ? Math.max(0, Math.min(24 * 3_600_000, Math.floor(Number(saved.positionMs) || 0))) : 0,
      ...(Number.isInteger(volume) && volume >= 0 && volume <= 100 && { volume }), ...((repeat === 'off' || repeat === 'track' || repeat === 'queue') && { repeat }),
      songs: tracks.length + (current ? 1 : 0) };
  } catch { forgetLegacyDeck(); return null; }
}
export function forgetLegacyDeck() { try { localStorage.removeItem(LEGACY_DECK_KEY); } catch { /* Nothing stored. */ } }
