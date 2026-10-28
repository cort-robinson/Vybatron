import { randomBytes, randomInt } from 'node:crypto';

// Each listener's one player, shared by their devices (ADR-0018). The store
// owns the queue by entry and checks every edit against the player's revision;
// the active device owns the playhead, and its reports are fenced by the
// generation it plays under. Every change is one transaction in the library's
// write queue. Players live in the listening-state store, not library.json.
export const PLAYER_LIMITS = Object.freeze({ queue: 500, history: 50, bytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, batch: 50, devices: 10 });
export const DEVICE_KINDS = Object.freeze(['browser', 'android', 'tv']);
export const REPEAT_MODES = Object.freeze(['off', 'track', 'queue']);
export const EDIT_OPS = Object.freeze(['add', 'remove', 'move', 'clear', 'shuffle', 'play', 'skipTo']);
export const CONTROL_ACTIONS = Object.freeze(['play', 'pause', 'seek', 'next', 'previous', 'volume', 'repeat']);
// Early in a song Previous goes back a song; later it restarts this one, as the deck does.
const RESTART_AFTER_MS = 3000;
// A reported position this far from where the last report puts it is a seek.
const SEEK_MS = 2000;
// Positions are in server time; a device whose clock sync is further off than this is refused.
const CLOCK_SKEW_MS = 10 * 60_000;
const MAX_POSITION_MS = 24 * 60 * 60_000;
const FULL = 'Your queue is full.';

export class PlayerError extends Error {
  constructor(status, code, message, player) { super(message); this.name = 'PlayerError'; this.status = status; this.code = code; if (player) this.player = player; }
}
const invalid = () => new PlayerError(400, 'invalid_input', 'That player change is invalid.');
const unknownEntry = () => new PlayerError(400, 'unknown_entry', 'That song is no longer in your queue.');
const unknownDevice = () => new PlayerError(404, 'unknown_device', 'That device is no longer signed in.');

export const validDeviceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
export const validEntryId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value);
const validActor = value => typeof value === 'string' && /^\d{1,22}$/.test(value);
const validGuild = validActor;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const newEntryId = () => randomBytes(9).toString('base64url');
const clean = (value, max) => value.replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, max);
function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 512 || /\s/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}

/** A device's name: trimmed, at most 40 characters, no control characters. */
export function deviceName(value) {
  if (typeof value !== 'string' || /[\0-\x1f\x7f]/.test(value)) return null;
  const name = value.trim();
  return name && name.length <= 40 ? name : null;
}

/** What the portal's deck keeps for a song (portal/web Track), bounded; null when it can't play. */
export function playerTrack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, title, author, uri, source = 'unknown', durationMs, artworkUrl = null, isStream = false } = value;
  if (typeof id !== 'string' || !/^[\w:-]{1,64}$/.test(id) || typeof title !== 'string' || typeof author !== 'string' || typeof source !== 'string'
    || !httpsUrl(uri) || (artworkUrl !== null && !httpsUrl(artworkUrl)) || !Number.isFinite(durationMs) || durationMs < 0 || typeof isStream !== 'boolean') return null;
  return { id, title: clean(title, 200) || 'Unknown track', author: clean(author, 200) || 'Unknown artist', uri, source: clean(source, 40) || 'unknown',
    durationMs: Math.min(Math.floor(durationMs), Number.MAX_SAFE_INTEGER), artworkUrl, isStream };
}
function playerTracks(value, min = 1) {
  if (!Array.isArray(value) || value.length < min || value.length > PLAYER_LIMITS.batch) throw invalid();
  const tracks = value.map(playerTrack);
  if (tracks.includes(null)) throw invalid();
  return tracks;
}

export function emptyPlayer() {
  return { guildId: null, revision: 0, generation: 0, generationAt: 0, activeDeviceId: null, playbackVersion: 0,
    current: null, queue: [], history: [], playhead: { positionMs: 0, at: 0, playing: false }, volume: 100, repeat: 'off', updatedAt: 0 };
}

/** Where the playhead is at server time `now`. */
export function playheadPosition(player, now) {
  const { positionMs, at, playing } = player.playhead;
  const position = playing ? positionMs + Math.max(0, now - at) : positionMs;
  const duration = player.current?.track.durationMs;
  return Math.floor(duration > 0 ? Math.min(position, duration) : position);
}

const entries = tracks => tracks.map(track => ({ entryId: newEntryId(), track }));
const indexOf = (list, entryId) => list.findIndex(entry => entry.entryId === entryId);
function retire(player, entry) {
  player.history = [entry, ...player.history.filter(item => item.entryId !== entry.entryId)].slice(0, PLAYER_LIMITS.history);
}
// A song change. Without an active device the player is always paused.
function setCurrent(player, entry, now, playing) {
  player.current = entry;
  player.playhead = { positionMs: 0, at: now, playing: Boolean(entry && playing && player.activeDeviceId) };
  player.playbackVersion++;
}
function pause(player, now) {
  if (!player.playhead.playing) return;
  player.playhead = { positionMs: playheadPosition(player, now), at: now, playing: false };
  player.playbackVersion++;
}
// Next: the current song goes to history (and, on repeat queue, to the end of the queue).
function skip(player, now) {
  const done = player.current;
  if (done) {
    retire(player, done);
    if (player.repeat === 'queue' && player.queue.length < PLAYER_LIMITS.queue) player.queue.push({ entryId: newEntryId(), track: done.track });
  }
  setCurrent(player, player.queue.shift() ?? null, now, player.playhead.playing);
  player.revision++;
}

export class SharedPlayers {
  constructor(library, { now = Date.now } = {}) { this.library = library; this.now = now; }
  get state() { return this.library.state; }

  read(actorId) { return { player: this.state.readPlayer(actorId) || emptyPlayer(), devices: this.state.devices(actorId) }; }

  /** The listener's player (an empty one if they have none) and their devices. */
  get(actorId) {
    if (!validActor(actorId)) throw invalid();
    return this.read(actorId);
  }

  // One transaction in the library's write queue, answered with the result.
  update(actorId, change, options) {
    if (!validActor(actorId)) return Promise.reject(invalid());
    return this.library.transact(() => this.state.transaction(() => ({ ...this.apply(actorId, change, options), ...this.read(actorId) })));
  }

  // Read, change, bound and save. `strict` changes are refused when they don't
  // fit; others shed history, then the end of the queue.
  apply(actorId, change, { strict = false } = {}) {
    const before = this.state.readPlayer(actorId) || emptyPlayer();
    const player = structuredClone(before);
    const now = this.now();
    const extra = change(player, now, before) || {};
    // Strictly increasing, so the portal can tell a newer player from an older one.
    player.updatedAt = Math.max(now, before.updatedAt + 1);
    let serialized = JSON.stringify(player);
    while (Buffer.byteLength(serialized) > PLAYER_LIMITS.bytes) {
      if (strict) throw new PlayerError(400, 'queue_full', FULL);
      if (player.history.length) player.history.pop();
      else if (player.queue.length) { player.queue.pop(); if (extra.dropped !== undefined) extra.dropped++; }
      else throw new PlayerError(400, 'queue_full', FULL);
      serialized = JSON.stringify(player);
    }
    this.state.writePlayer(actorId, serialized, player.updatedAt, PLAYER_LIMITS.totalBytes);
    return extra;
  }

  /** A queue edit by entry, against the revision the device saw. */
  async edit(actorId, { op, expectedRevision, guildId, tracks, position, startIndex, entryId, before } = {}) {
    if (!EDIT_OPS.includes(op) || !integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER) || (guildId !== undefined && !validGuild(guildId))) throw invalid();
    const added = ['add', 'play'].includes(op) ? playerTracks(tracks) : null;
    if (op === 'add' && !['next', 'end'].includes(position) && !validEntryId(position?.after)) throw invalid();
    if (op === 'play' && !integer(startIndex, 0, added.length - 1)) throw invalid();
    if (['remove', 'move', 'skipTo'].includes(op) && !validEntryId(entryId)) throw invalid();
    if (op === 'move' && before !== null && !validEntryId(before)) throw invalid();
    return this.update(actorId, (player, now, stored) => {
      if (player.revision !== expectedRevision) throw new PlayerError(409, 'stale', 'Your queue changed. Try again.', stored);
      if (guildId && ['add', 'play'].includes(op)) player.guildId = guildId;
      const queue = player.queue;
      if (op === 'add') {
        const list = entries(added);
        if (queue.length + list.length - (player.current ? 0 : 1) > PLAYER_LIMITS.queue) throw new PlayerError(400, 'queue_full', FULL);
        let at = position === 'end' ? queue.length : 0;
        if (position.after && position.after !== player.current?.entryId) {
          at = indexOf(queue, position.after) + 1;
          if (!at) throw unknownEntry();
        }
        if (!player.current) setCurrent(player, list.shift(), now, false);
        queue.splice(at, 0, ...list);
      } else if (op === 'remove') {
        const at = indexOf(queue, entryId);
        if (at < 0) throw unknownEntry();
        queue.splice(at, 1);
      } else if (op === 'move') {
        const from = indexOf(queue, entryId);
        if (from < 0 || (before !== null && indexOf(queue, before) < 0)) throw unknownEntry();
        if (before !== entryId) {
          const [entry] = queue.splice(from, 1);
          queue.splice(before === null ? queue.length : indexOf(queue, before), 0, entry);
        }
      } else if (op === 'clear') queue.length = 0;
      else if (op === 'shuffle') {
        for (let index = queue.length - 1; index > 0; index--) { const swap = randomInt(index + 1); [queue[index], queue[swap]] = [queue[swap], queue[index]]; }
      } else if (op === 'play') {
        // Like playing a list: its songs replace the queue, from the chosen one on.
        const list = entries(added);
        if (player.current) retire(player, player.current);
        setCurrent(player, list[startIndex], now, true);
        player.queue = list.slice(startIndex + 1);
      } else if (op === 'skipTo') {
        const at = indexOf(queue, entryId);
        if (at < 0) throw unknownEntry();
        if (player.current) retire(player, player.current);
        setCurrent(player, queue[at], now, player.playhead.playing);
        player.queue = queue.slice(at + 1);
      }
      player.revision++;
    }, { strict: ['add', 'play'].includes(op) });
  }

  /**
   * What the active device did: a song change, its playhead, volume or repeat.
   * Refused with `replaced` unless it comes from the active device under the
   * current generation. An advance already applied is a no-op, so a device
   * that played on while offline can send its advances again in order.
   */
  async report(actorId, { deviceId, generation, advance, playhead, volume, repeat } = {}) {
    if (!validDeviceId(deviceId) || !integer(generation, 0, Number.MAX_SAFE_INTEGER)
      || (advance === undefined && playhead === undefined && volume === undefined && repeat === undefined)) throw invalid();
    let to = null, track = null;
    if (advance !== undefined) {
      if (!advance || typeof advance !== 'object' || ![advance.from, advance.to].every(id => id === null || validEntryId(id))) throw invalid();
      to = advance.to;
      if (advance.track !== undefined && !(track = playerTrack(advance.track))) throw invalid();
    }
    if (playhead !== undefined && (!playhead || !integer(playhead.positionMs, 0, MAX_POSITION_MS) || !Number.isSafeInteger(playhead.at)
      || Math.abs(playhead.at - this.now()) > CLOCK_SKEW_MS || typeof playhead.playing !== 'boolean')) throw invalid();
    if ((volume !== undefined && !integer(volume, 0, 100)) || (repeat !== undefined && !REPEAT_MODES.includes(repeat))) throw invalid();
    return this.update(actorId, (player, now, stored) => {
      if (generation !== player.generation || deviceId !== player.activeDeviceId) throw new PlayerError(409, 'replaced', 'Another device is playing now.', stored);
      const applied = to === null ? !player.current : player.current?.entryId === to || indexOf(player.history, to) >= 0;
      if (advance !== undefined && !applied) {
        let next = null;
        if (to !== null) {
          const at = indexOf(player.queue, to);
          // A song removed meanwhile still becomes current: it is what's playing.
          if (at >= 0) [next] = player.queue.splice(at, 1);
          else if (track) next = { entryId: to, track };
          else throw unknownEntry();
        }
        const done = player.current;
        if (done?.entryId === advance.from) {
          retire(player, done);
          if (player.repeat === 'queue' && player.queue.length < PLAYER_LIMITS.queue) player.queue.push({ entryId: newEntryId(), track: done.track });
        } else if (done) {
          // An edit put a song in place that this device never played: it waits next.
          player.queue.unshift(done);
          player.queue.length = Math.min(player.queue.length, PLAYER_LIMITS.queue);
        }
        setCurrent(player, next, now, true);
        player.revision++;
      }
      if (playhead) {
        // Play, pause and seek change the playback version; a periodic report doesn't.
        if (playhead.playing !== player.playhead.playing || Math.abs(playhead.positionMs - playheadPosition(player, playhead.at)) > SEEK_MS) player.playbackVersion++;
        player.playhead = { positionMs: playhead.positionMs, at: playhead.at, playing: playhead.playing && Boolean(player.current) };
      }
      if (volume !== undefined) player.volume = volume;
      if (repeat !== undefined) player.repeat = repeat;
    });
  }

  /** Make a device the active one: a new generation starting now, at the playhead's place. */
  async activate(actorId, { deviceId, guildId } = {}) {
    if (!validDeviceId(deviceId) || (guildId !== undefined && !validGuild(guildId))) throw invalid();
    return this.update(actorId, (player, now) => {
      if (!this.state.devices(actorId).some(device => device.deviceId === deviceId)) throw unknownDevice();
      if (guildId) player.guildId = guildId;
      player.playhead = { positionMs: playheadPosition(player, now), at: now, playing: player.playhead.playing };
      player.generation++; player.generationAt = now; player.activeDeviceId = deviceId;
      player.playbackVersion++;
    });
  }

  /** The active device lets go: the player pauses where it is. */
  async deactivate(actorId, { deviceId, generation } = {}) {
    if (!validDeviceId(deviceId) || !integer(generation, 0, Number.MAX_SAFE_INTEGER)) throw invalid();
    return this.update(actorId, (player, now, stored) => {
      if (generation !== player.generation || deviceId !== player.activeDeviceId) throw new PlayerError(409, 'replaced', 'Another device is playing now.', stored);
      pause(player, now);
      player.activeDeviceId = null;
    });
  }

  /** A control applied to the stored player, for when no active device is connected to carry it out. */
  async control(actorId, { action, value } = {}) {
    if (!CONTROL_ACTIONS.includes(action)) throw invalid();
    if (action === 'seek' ? !integer(value, 0, MAX_POSITION_MS) : action === 'volume' ? !integer(value, 0, 100)
      : action === 'repeat' ? !REPEAT_MODES.includes(value) : value !== undefined) throw invalid();
    return this.update(actorId, (player, now) => {
      if (action === 'play') {
        if (!player.current && player.queue.length) { setCurrent(player, player.queue.shift(), now, false); player.revision++; }
        // Only an active device plays; without one, Play just readies the song.
        if (player.current && player.activeDeviceId && !player.playhead.playing) {
          player.playhead = { positionMs: player.playhead.positionMs, at: now, playing: true }; player.playbackVersion++;
        }
      } else if (action === 'pause') pause(player, now);
      else if (action === 'seek' && player.current) {
        const duration = player.current.track.durationMs;
        player.playhead = { positionMs: duration > 0 ? Math.min(value, duration) : value, at: now, playing: player.playhead.playing };
        player.playbackVersion++;
      } else if (action === 'next' && (player.current || player.queue.length)) skip(player, now);
      else if (action === 'previous' && player.current && (!player.history.length || playheadPosition(player, now) > RESTART_AFTER_MS)) {
        player.playhead = { positionMs: 0, at: now, playing: player.playhead.playing }; player.playbackVersion++;
      } else if (action === 'previous' && player.history.length) {
        const [previous, ...history] = player.history;
        // The current song waits at the front of the queue, so Next returns to it.
        if (player.current) player.queue = [player.current, ...player.queue].slice(0, PLAYER_LIMITS.queue);
        player.history = history;
        setCurrent(player, previous, now, player.playhead.playing);
        player.revision++;
      } else if (action === 'volume') player.volume = value;
      else if (action === 'repeat') player.repeat = value;
    });
  }

  /**
   * Add a device's old, account-less deck (`vybertron.local`) to the player, in
   * batches: its songs join the end of the queue, or the first becomes current
   * when nothing is. Songs past the bounds are dropped and counted.
   */
  async adopt(actorId, { tracks = [], current = null, positionMs = 0, volume, repeat, guildId } = {}) {
    const songs = playerTracks(tracks, 0);
    const first = current === null ? null : playerTrack(current);
    if ((current !== null && !first) || !integer(positionMs, 0, MAX_POSITION_MS) || (volume !== undefined && !integer(volume, 0, 100))
      || (repeat !== undefined && !REPEAT_MODES.includes(repeat)) || (guildId !== undefined && !validGuild(guildId)) || (!first && !songs.length)) throw invalid();
    return this.update(actorId, (player, now) => {
      const list = entries(first ? [first, ...songs] : songs);
      if (!player.current) {
        // An empty player takes the deck's place, volume and repeat with its first song.
        setCurrent(player, list.shift(), now, false);
        if (first) player.playhead.positionMs = Math.min(positionMs, first.durationMs || positionMs);
        if (volume !== undefined) player.volume = volume;
        if (repeat !== undefined) player.repeat = repeat;
        if (guildId) player.guildId = guildId;
      }
      const room = Math.max(0, PLAYER_LIMITS.queue - player.queue.length);
      player.queue.push(...list.slice(0, room));
      player.revision++;
      return { dropped: Math.max(0, list.length - room) };
    });
  }

  // Device changes, in one transaction with pausing a player whose active device was forgotten.
  devices(actorId, work) {
    if (!validActor(actorId)) return Promise.reject(invalid());
    return this.library.transact(() => this.state.transaction(() => {
      work(this.now());
      const active = this.state.readPlayer(actorId)?.activeDeviceId;
      if (active && !this.state.devices(actorId).some(device => device.deviceId === active)) {
        this.apply(actorId, (player, now) => { pause(player, now); player.activeDeviceId = null; });
      }
      return this.read(actorId);
    }));
  }

  /** A signed-in device connecting. Past 10 the least recently seen is forgotten. */
  async register(actorId, { deviceId, name, kind, sessionRef } = {}) {
    const label = deviceName(name);
    if (!validDeviceId(deviceId) || !label || !DEVICE_KINDS.includes(kind) || typeof sessionRef !== 'string' || !/^[\w-]{1,64}$/.test(sessionRef)) throw invalid();
    return this.devices(actorId, now => this.state.saveDevice(actorId, { deviceId, name: label, kind, sessionRef, lastSeen: now }, PLAYER_LIMITS.devices));
  }

  async rename(actorId, { deviceId, name } = {}) {
    const label = deviceName(name);
    if (!validDeviceId(deviceId) || !label) throw invalid();
    return this.devices(actorId, () => { if (!this.state.renameDevice(actorId, deviceId, label)) throw unknownDevice(); });
  }

  async forget(actorId, { deviceId } = {}) {
    if (!validDeviceId(deviceId)) throw invalid();
    return this.devices(actorId, () => { this.state.deleteDevice(actorId, deviceId); });
  }

  /** Signing out forgets the devices that session registered. */
  async forgetSession(actorId, { sessionRef } = {}) {
    if (typeof sessionRef !== 'string' || !/^[\w-]{1,64}$/.test(sessionRef)) throw invalid();
    return this.devices(actorId, () => { for (const deviceId of this.state.sessionDevices(actorId, sessionRef)) this.state.deleteDevice(actorId, deviceId); });
  }
}
