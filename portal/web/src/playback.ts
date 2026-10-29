import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errorMessage, publicUrl } from './api';
import { timestamp } from './format';
import type { Capability, Command, GuildSnapshot, Track } from './types';
import type { RemotePortal } from './usePortal';
import { isLink } from './suggestions';
import { youtubeId } from './youtube';
import { useShared, useStableObject } from './stable';
import { NativeError, nativePlayer, type NativeControl, type NativePlayer, type NativeState } from './native';
import {
  advanced, asTrack, batches, cacheView, cachedView, clock, forgetCachedViews, forgetLegacyDeck, legacyDeck, loadIdentity, newEntryId, playerTrack, playheadAt,
  saveIdentity, syncClock, validName, validPlayer, validView,
  type Advance, type ControlAction, type Device, type Identity, type LegacyDeck, type Player, type PlayerCommand, type PlayerEntry, type PlayerTrack, type PlayerView, type Repeat,
} from './shared';

// Where music plays: the shared Discord session (the bot is the authority), or
// the listener's own player, which their devices share (ADR-0018): one of them
// plays it, streamed by the bot through the portal, and the others show it and
// control it. Search, favorites and stats still come from the bot either way.
// Listeners outside voice start on their player; a session moves between the two
// like casting, carrying its songs, place, volume and repeat.
export type PlaybackTarget = 'discord' | 'local';
type Status = 'idle' | 'playing' | 'paused';
// What this device does with the player while it is the active device.
interface Deck {
  owner: boolean; entryId: string | null; track: PlayerTrack | null; status: Status;
  // Position at `at`; playing positions advance from there once the audio is moving, not while it loads.
  positionMs: number; at: number; waiting: boolean; durationMs: number; volume: number; repeat: Repeat;
}
// One of the listener's devices, as the player menu offers it.
export interface DeviceChoice extends Device { self: boolean; playable: boolean; note: string }
export type Portal = Omit<RemotePortal, 'run'> & {
  // `tracks` names the songs a list command means, for lists only the server knows by name.
  run: (body: Command, capability: Capability, tracks?: Track[]) => Promise<boolean>;
  target: PlaybackTarget;
  // The server's own session, whichever target is showing.
  discord: GuildSnapshot['session'] | null;
  // Moves the player's songs into the viewer's voice channel, or joins the one already playing there.
  moveToDiscord: () => Promise<boolean>;
  // Brings the Discord session here; `stop` ends it in Discord, otherwise it keeps playing there too.
  moveHere: (stop: boolean) => Promise<boolean>;
  // The listener's devices, this one first, and moving playback to one of them.
  devices: DeviceChoice[];
  playOn: (deviceId: string) => Promise<boolean>;
  renameDevice: (name: string) => Promise<boolean>;
  // The name of another of the listener's devices while it plays their player.
  playingOn: string | null;
  // Songs in this browser's old deck, until the listener says whether to add them to their player.
  legacySongs: number;
  answerLegacy: (add: boolean) => Promise<void>;
};

const MAX_QUEUE = 500;
// Early in a song Back goes to the previous one; later it restarts this one.
export const RESTART_AFTER_MS = 3000;
// The active device reports its position this often while it plays (ADR-0018).
const REPORT_EVERY_MS = 15_000;
const idleDeck: Deck = { owner: false, entryId: null, track: null, status: 'idle', positionMs: 0, at: 0, waiting: false, durationMs: 0, volume: 100, repeat: 'off' };
export const DISCORD_ONLY = 'That works in a Discord session. Choose Discord under Play on in the player menu to use it.';
// The bot resolves each song it receives; the rest of a long queue stays behind.
export const TRANSFER_TRACKS = 100;
const STALE = 'Your queue just changed. Try that again.';

const volumeOf = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value)))) || 0;
const repeatOf = (value: unknown): Repeat => value === 'track' || value === 'queue' ? value : 'off';
const bare = ({ requestedBy: _requestedBy, suggested: _suggested, entryId: _entryId, ...track }: Track & { entryId?: unknown }): PlayerTrack => track;
// The entry the page named when it handed the song to the Android app, which keeps the object as given.
const entryOf = (track: Track | null | undefined) => typeof (track as { entryId?: unknown } | null)?.entryId === 'string' ? (track as unknown as { entryId: string }).entryId : null;
const position = (deck: Deck) => deck.status === 'playing' && !deck.waiting ? deck.positionMs + Math.max(0, Date.now() - deck.at) : deck.positionMs;
const snowflake = (id: string) => /^\d{1,20}$/.test(id);
function milliseconds(value: unknown) {
  const parts = String(value ?? '').split(':').map(Number);
  return parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0) ? null : parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}
function shuffled<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) { const swap = Math.floor(Math.random() * (index + 1)); [copy[index], copy[swap]] = [copy[swap], copy[index]]; }
  return copy;
}

// Typed text plays its best match; a link adds everything it names.
async function lookUp(remote: RemotePortal, query: string) {
  const { tracks } = await api.search(remote.guildId, query);
  if (!tracks.length) throw new Error(`No tracks found for “${query}”.`);
  return isLink(query) ? tracks : tracks.slice(0, 1);
}
async function tracksFor(remote: RemotePortal, body: Command, hint?: Track[]): Promise<Track[] | null> {
  const o = body.options || {}; const library = remote.library;
  if (hint) return o.shuffle === true ? shuffled(hint) : hint;
  switch (`${body.command}:${body.subcommand || ''}`) {
    case 'play:': case 'playnext:': return typeof o.query === 'string' ? lookUp(remote, o.query) : null;
    case 'favorite:play': { const track = library?.favorites[Number(o.index) - 1]; return track && track.id === body.expectedTrackId ? [track] : null; }
    case 'replay:': { const entry = library?.history[Number(o.index) - 1]; return entry && entry.id === body.expectedHistoryId ? [entry.track] : null; }
    case 'mix:load': return library?.mixes.find(mix => mix.name === o.name)?.tracks ?? null;
    default: return null;
  }
}
const ADDS = new Set(['play:', 'playnext:', 'replay:', 'favorite:play', 'mix:load', 'top:play', 'mymix:play']);
const LIBRARY = new Set(['favorite:remove', 'favorite:clear', 'mix:delete', 'favorite:import', 'mix:import']);

// What plays the player's songs on this device while it is the active device.
interface Engine {
  // Starts as the active device: the player's current song from `positionMs`. `keep`
  // takes over music the Android app kept playing while this page was gone.
  begin: (player: Player, positionMs: number, playing: boolean, keep?: boolean) => void;
  // The player changed while this device plays it: an edit from any device, or a report's answer.
  follow: (player: Player) => void;
  // A control, from this page or relayed from another device.
  act: (action: ControlAction, value?: number | Repeat) => boolean;
  // Another device plays now: stop at once.
  halt: () => void;
  // Stop: the current song is let go (whatever repeat says) and nothing plays.
  stop: () => void;
}
interface EngineParts {
  commit: (change: Partial<Deck>) => void; deck: () => Deck; shown: () => Player | null;
  // A song change this device made, reported and shown before the store confirms it.
  advance: (step: Advance) => void;
  report: (body: { volume?: number; repeat?: Repeat }) => void;
  notify: RemotePortal['notify']; guildId: () => string; owning: () => boolean; steady: () => boolean;
}

// In a browser the page plays the songs: one audio element, streamed by the bot through the portal.
function webEngine(parts: EngineParts): Engine {
  const { commit, deck, shown, advance, report, notify, guildId, owning } = parts;
  let element: HTMLAudioElement | null = null;
  // The YouTube video whose audio the element holds, if any.
  let loaded: string | null = null;
  // Each load supersedes the previous one, including its late lookup or media events.
  let token = 0;
  const retried = new Set<string>(); const warmed = new Set<string>();
  // One audio element for the whole session: phones keep it playing in the
  // background and on the lock screen, and it plays audio only, never video.
  const audio = () => {
    if (element) return element;
    const media = new Audio(); media.preload = 'auto';
    const current = () => owning() && loaded !== null && media.dataset.video === loaded && !!deck().entryId;
    const anchor = () => ({ positionMs: media.currentTime * 1000, at: Date.now() });
    media.addEventListener('playing', () => {
      if (!current()) return;
      commit({ status: 'playing', waiting: false, ...anchor(), ...(Number.isFinite(media.duration) && { durationMs: media.duration * 1000 }) });
      warmNext();
    });
    media.addEventListener('pause', () => { if (current() && !media.ended) commit({ status: 'paused', waiting: false, ...anchor() }); });
    media.addEventListener('seeked', () => { if (current()) commit(anchor()); });
    media.addEventListener('waiting', () => { if (current()) commit({ waiting: true, ...anchor() }); });
    media.addEventListener('ended', () => { if (current()) forward(false); });
    media.addEventListener('error', () => { if (current() && media.error) void failed(media.dataset.video!); });
    element = media;
    return media;
  };
  const source = (videoId: string) => `/api/guilds/${encodeURIComponent(guildId())}/audio/${videoId}`;
  // The next song downloads into the bot's cache while this one plays, so
  // the change between songs is quick even with the screen off.
  const warmNext = () => {
    const videoId = youtubeId(shown()?.queue[0]?.track.uri);
    if (!videoId || warmed.has(videoId)) return;
    warmed.add(videoId);
    void fetch(source(videoId), { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' })
      .then(response => response.body?.cancel()).catch(() => warmed.delete(videoId));
  };
  const describe = (track: PlayerTrack) => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const artwork = publicUrl(track.artworkUrl);
    navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.author, album: 'Vybatron', artwork: artwork ? [{ src: artwork }] : [] });
  };
  // Songs from other catalogs play through their closest YouTube match.
  const playable = async (track: PlayerTrack): Promise<PlayerTrack | null> => {
    const { tracks } = await api.search(guildId(), `${track.author} ${track.title}`);
    const match = tracks.find(candidate => youtubeId(candidate.uri));
    return match ? bare(match) : null;
  };
  const load = (track: PlayerTrack, startMs: number, autoplay: boolean) => {
    const videoId = youtubeId(track.uri)!; const media = audio();
    loaded = videoId; media.dataset.video = videoId;
    // A media fragment starts at the saved place; the bot serves byte ranges.
    media.src = `${source(videoId)}${startMs >= 1000 ? `#t=${Math.floor(startMs / 1000)}` : ''}`;
    media.volume = deck().volume / 100;
    describe(track);
    if (!autoplay) return;
    commit({ waiting: true });
    media.play().catch((error: unknown) => {
      // A newer song replaced this one (AbortError), or the browser wants a tap first.
      if (loaded !== videoId || (error as Error)?.name !== 'NotAllowedError') return;
      commit({ status: 'paused', positionMs: startMs, at: Date.now(), waiting: false });
      notify('Tap play to start listening on this device.', 'info');
    });
  };
  // A song with a YouTube link starts synchronously, inside the tap that asked
  // for it, which is the only way iOS lets audio begin.
  const start = (track: PlayerTrack, startMs: number, autoplay: boolean) => {
    const turn = ++token;
    if (youtubeId(track.uri)) { load(track, startMs, autoplay); return; }
    loaded = null;
    void playable(track).then(resolved => {
      if (turn !== token) return;
      if (!resolved) { notify(`“${track.title}” has no version this device can play. Skipping it.`, 'error'); forward(true, true); return; }
      commit({ track: resolved, durationMs: resolved.durationMs });
      load(resolved, startMs, autoplay);
    }).catch(error => {
      if (turn !== token) return;
      const now = deck();
      commit({ status: now.entryId ? 'paused' : 'idle', positionMs: position(now), at: Date.now(), waiting: false });
      notify(errorMessage(error), 'error');
    });
  };
  // Media errors carry no reason; the portal's answer for the same song does.
  const failed = async (videoId: string) => {
    const turn = token; const now = deck();
    let status = 0; let message = 'This song couldn’t load on this device.';
    try {
      const response = await fetch(source(videoId), { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' });
      status = response.status;
      if (!response.ok) message = (await response.json().catch(() => null))?.error?.message || message;
      else await response.body?.cancel();
    } catch { status = 0; }
    if (turn !== token || !now.track) return;
    // Busy, briefly unreachable, or a dropped connection: one quiet retry from the same place.
    if ([0, 206, 429, 503].includes(status) && !retried.has(videoId)) {
      retried.add(videoId);
      setTimeout(() => {
        const later = deck();
        if (turn === token && later.track) start(later.track, position(later), later.status === 'playing');
      }, 1500);
      return;
    }
    notify(`“${now.track.title}”: ${message} Skipping it.`, 'error');
    forward(true, true);
  };
  const play = (entry: PlayerEntry, startMs: number, autoplay: boolean) => {
    commit({ entryId: entry.entryId, track: entry.track, status: autoplay ? 'playing' : 'paused', positionMs: startMs, at: Date.now(), waiting: autoplay, durationMs: entry.track.durationMs });
    start(entry.track, startMs, autoplay);
  };
  const silence = () => {
    ++token; loaded = null;
    if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
  };
  const idle = () => { silence(); commit({ entryId: null, track: null, status: 'idle', positionMs: 0, at: Date.now(), waiting: false, durationMs: 0 }); };
  // The element, when it already holds the current song.
  const ready = () => (loaded && element?.dataset.video === loaded ? element : null);
  const restart = () => {
    const media = ready(); const player = shown();
    if (media) { media.currentTime = 0; void media.play().catch(() => {}); } else if (player?.current) play(player.current, 0, true);
  };
  // `drop` moves on from a song that cannot play, so repeat never retries it forever.
  const forward = (manual: boolean, drop = false) => {
    const now = deck(); const player = shown();
    if (!player) return;
    if (!manual && now.repeat === 'track' && now.entryId) { restart(); return; }
    const next = player.queue[0] ?? null;
    if (!next && now.repeat === 'queue' && player.current && !drop) { restart(); return; }
    advance({ from: now.entryId ?? player.current?.entryId ?? null, to: next?.entryId ?? null, ...(next && { track: next.track }) });
    if (next) play(next, 0, true); else idle();
  };
  const act = (action: ControlAction, value?: number | Repeat): boolean => {
    const now = deck(); const player = shown(); const at = Date.now();
    switch (action) {
      case 'pause':
        if (now.status !== 'playing') return true;
        commit({ status: 'paused', positionMs: position(now), at, waiting: false }); ready()?.pause(); return true;
      case 'play': {
        if (!now.entryId || !now.track) {
          if (player?.current) { play(player.current, playheadAt(player, clock.now()), true); return true; }
          if (player?.queue.length) { forward(true); return true; }
          return false;
        }
        if (now.status === 'playing') return true;
        commit({ status: 'playing', at, waiting: true });
        const media = ready();
        if (media) void media.play().catch(() => commit({ status: 'paused', at: Date.now(), waiting: false })); else start(now.track, now.positionMs, true);
        return true;
      }
      case 'seek': {
        const target = Math.max(0, Math.floor(Number(value) || 0));
        if (!now.entryId || !now.track) return false;
        commit({ positionMs: target, at });
        const media = ready();
        if (media) media.currentTime = target / 1000; else start(now.track, target, now.status === 'playing');
        return true;
      }
      case 'next': if (!now.entryId && !player?.queue.length) return false; forward(true); return true;
      case 'previous': {
        const previous = player?.history[0];
        if (!previous || (now.entryId && position(now) > RESTART_AFTER_MS)) return !!now.entryId && act('seek', 0);
        advance({ from: now.entryId, to: previous.entryId, track: previous.track });
        play(previous, 0, true);
        return true;
      }
      case 'volume': { const volume = volumeOf(value); commit({ volume }); if (element) element.volume = volume / 100; report({ volume }); return true; }
      case 'repeat': { const repeat = repeatOf(value); commit({ repeat }); report({ repeat }); return true; }
    }
  };
  // Lock-screen, headset and car controls act on the player.
  return {
    begin: (player, positionMs, playing) => {
      if (element) element.volume = player.volume / 100;
      if (player.current) play(player.current, positionMs, playing);
      else if (playing && player.queue.length) forward(true);
      else idle();
    },
    follow: player => {
      const now = deck();
      if ((player.current?.entryId ?? null) === now.entryId) return;
      if (!player.current) { idle(); return; }
      play(player.current, playheadAt(player, clock.now()), now.status === 'playing' || player.playhead.playing);
    },
    act,
    halt: silence,
    stop: () => {
      const from = deck().entryId ?? shown()?.current?.entryId ?? null;
      if (from) advance({ from, to: null });
      idle();
    },
  };
}

// Inside the Android app the app plays the songs (ADR-0014): it keeps a copy of the
// queue and moves on by itself with the screen off. While this device is the active
// one, the page loads the player into the app, keeps its queue in step with the
// store's, and reports what the app does on its behalf.
function nativeEngine(device: NativePlayer, parts: EngineParts, subscribed: (playing: boolean) => void): Engine {
  const { commit, deck, shown, advance, report, notify, guildId, owning, steady } = parts;
  let revision = -1; let last: NativeState | null = null;
  // The entry the page just loaded, for the app's first state after loading it.
  let expect: string | null | undefined; let queueing = false;
  const tracks = (entries: PlayerEntry[]) => entries.map(entry => ({ ...asTrack(entry.track), entryId: entry.entryId }));
  const send = async (call: () => Promise<NativeState>) => {
    try { apply(await call()); return true; }
    catch (error) {
      notify(error instanceof NativeError && error.message === 'stale' ? 'Your queue just changed. Try that again.' : 'This device’s player didn’t answer. Try again.', 'error');
      return false;
    }
  };
  const same = (a?: { id: string } | null, b?: { id: string } | null) => !!a && !!b && a.id === b.id;
  // Which of the player's songs the app plays now, from how its state moved.
  const locate = (player: Player, before: NativeState | null, state: NativeState): PlayerEntry | 'same' => {
    const song = state.current!;
    const held = !!before?.current && before.history.length === state.history.length && (before.history.length === 0 || same(before.history[0], state.history[0]));
    if (held && deck().entryId) return 'same';
    const queued = player.queue.find(entry => same(entry.track, song));
    if (same(state.history[0], before?.current) && queued) return queued;
    if (same(player.history[0]?.track, song)) return player.history[0];
    return queued ?? player.history.find(entry => same(entry.track, song)) ?? (same(player.current?.track, song) ? player.current! : { entryId: newEntryId(), track: bare(song) });
  };
  const fields = (state: NativeState): Partial<Deck> => ({ track: state.current ? bare(state.current) : null, status: state.status, positionMs: state.positionMs, at: state.at,
    waiting: state.waiting, durationMs: state.durationMs, volume: state.volume, repeat: state.repeat });
  const apply = (state: NativeState) => {
    const before = last; last = state; revision = state.revision;
    if (!owning()) return;
    const now = deck(); const player = shown();
    let entryId = now.entryId;
    if (expect !== undefined) { entryId = state.current ? expect : null; expect = undefined; }
    else if (!state.current) {
      // The app reached the end of its queue.
      entryId = null;
      if (now.entryId) advance({ from: now.entryId, to: null });
    } else if (player) {
      const found = locate(player, before, state);
      if (found !== 'same' && found.entryId !== now.entryId) { advance({ from: now.entryId, to: found.entryId, track: found.track }); entryId = found.entryId; }
    }
    if (state.volume !== now.volume) report({ volume: state.volume });
    if (state.repeat !== now.repeat) report({ repeat: state.repeat });
    commit({ entryId, ...fields(state) });
    keepQueue();
  };
  // The store's queue is the record: the app's copy follows it.
  const keepQueue = () => {
    const player = shown(); const state = last;
    if (!owning() || !steady() || queueing || !player || !state?.current || player.current?.entryId !== deck().entryId) return;
    if (player.queue.length === state.queue.length && player.queue.every((entry, index) => same(entry.track, state.queue[index]))) return;
    queueing = true;
    void device.setQueue(tracks(player.queue), revision).then(apply, () => undefined).finally(() => { queueing = false; });
  };
  const load = (player: Player, positionMs: number, playing: boolean) => {
    expect = player.current?.entryId ?? null;
    commit({ entryId: expect, track: player.current?.track ?? null, status: player.current ? playing ? 'playing' : 'paused' : 'idle', positionMs, at: Date.now(), waiting: playing,
      durationMs: player.current?.track.durationMs ?? 0 });
    return send(() => device.load({ guildId: guildId(), current: player.current ? tracks([player.current])[0] : null, queue: tracks(player.queue), history: tracks(player.history),
      positionMs: Math.max(0, Math.floor(positionMs)), playing, volume: deck().volume, repeat: deck().repeat }));
  };
  device.onState(apply); device.onNotice(notify);
  // Music the app kept playing while this page was gone becomes the player's.
  void device.subscribe().then(state => { last = state; revision = state.revision; subscribed(!!state.current && state.status === 'playing'); }, () => subscribed(false));
  return {
    begin: (player, positionMs, playing, keep) => {
      const state = last;
      if (keep && state?.current) {
        const song = state.current;
        const known = [player.current, ...player.queue, ...player.history];
        const entryFor = (track: Track) => known.find(item => item && entryOf(track) === item.entryId)
          ?? (entryOf(track) ? { entryId: entryOf(track)!, track: bare(track) } : known.find(item => same(item?.track, track))) ?? { entryId: newEntryId(), track: bare(track) };
        const entry = entryFor(song);
        // The songs the app played on to while the page was gone, from its own history, oldest
        // first, are reported in order: they go to history, and songs it never played stay queued.
        // The player's current song in the app's history: by its entry, or by the song for a track
        // handed over without one (or replaced by its YouTube match).
        const since = !player.current ? -1 : Math.max(state.history.findIndex(track => entryOf(track) === player.current!.entryId),
          state.history.findIndex(track => !entryOf(track) && same(track, player.current!.track)));
        let from = player.current?.entryId ?? null;
        for (const track of since > 0 ? state.history.slice(0, since).reverse() : []) {
          const step = entryFor(track);
          advance({ from, to: step.entryId, track: step.track }); from = step.entryId;
        }
        if (entry.entryId !== from) advance({ from, to: entry.entryId, track: entry.track });
        if (state.volume !== player.volume) report({ volume: state.volume });
        if (state.repeat !== player.repeat) report({ repeat: state.repeat });
        commit({ entryId: entry.entryId, ...fields(state) });
        keepQueue();
        return;
      }
      void load(player, positionMs, playing);
    },
    follow: player => {
      const now = deck();
      if ((player.current?.entryId ?? null) !== now.entryId) {
        if (player.current) void load(player, playheadAt(player, clock.now()), now.status === 'playing' || player.playhead.playing);
        else { if (last?.current) void send(() => device.control({ action: 'stop' })); commit({ entryId: null, track: null, status: 'idle', positionMs: 0, at: Date.now(), waiting: false, durationMs: 0 }); }
        return;
      }
      keepQueue();
    },
    act: (action, value) => {
      const now = deck(); const player = shown();
      if (action === 'volume' || action === 'repeat') {
        const request: NativeControl = action === 'volume' ? { action, level: volumeOf(value) } : { action, mode: repeatOf(value) };
        if (last?.current && now.entryId) void send(() => device.control(request));
        else { commit(action === 'volume' ? { volume: volumeOf(value) } : { repeat: repeatOf(value) }); report(action === 'volume' ? { volume: volumeOf(value) } : { repeat: repeatOf(value) }); }
        return true;
      }
      // Nothing loaded in the app yet: Play loads the player's song there.
      if (!last?.current || !now.entryId) {
        if (action === 'play' && player?.current) { void load(player, playheadAt(player, clock.now()), true); return true; }
        if ((action === 'play' || action === 'next') && player?.queue.length) {
          const [next] = player.queue;
          advance({ from: player.current?.entryId ?? null, to: next.entryId, track: next.track });
          void load(shown()!, 0, true); return true;
        }
        return action === 'pause';
      }
      const request: NativeControl = action === 'seek' ? { action, positionMs: Math.max(0, Math.floor(Number(value) || 0)) } : { action };
      void send(() => device.control(request));
      return true;
    },
    stop: () => {
      const from = deck().entryId ?? shown()?.current?.entryId ?? null;
      if (from) advance({ from, to: null });
      expect = undefined;
      commit({ entryId: null, track: null, status: 'idle', positionMs: 0, at: Date.now(), waiting: false, durationMs: 0 });
      if (last?.current) void send(() => device.control({ action: 'stop' }));
    },
    halt: () => {
      expect = undefined;
      if (last?.current) void device.control({ action: 'stop' }).then(state => { last = state; revision = state.revision; }, () => undefined);
    },
  };
}

export function useListening(remote: RemotePortal): Portal {
  // An explicit move this page; otherwise the target follows voice presence.
  const [choice, setChoice] = useState<PlaybackTarget | null>(null);
  const [deck, setDeck] = useState<Deck>(idleDeck);
  // The player as shown: the newest from the portal, with this device's unconfirmed song changes.
  const [view, setView] = useState<PlayerView | null>(null);
  // Whether `view` came from the live stream, rather than this browser's copy.
  const [streaming, setStreaming] = useState(false);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [legacy, setLegacy] = useState<LegacyDeck | null>(null);
  const deckRef = useRef(deck);
  // Lookups for songs added from this device run one at a time, in the order tapped.
  const line = useRef<{ tail: Promise<unknown>; keys: string[] }>({ tail: Promise.resolve(), keys: [] });
  const latest = useRef(remote); latest.current = remote;

  const core = useMemo(() => {
    const notify: RemotePortal['notify'] = (message, kind) => latest.current.notify(message, kind);
    const device = nativePlayer();
    let me: Identity | null = null; let actor: string | null = null;
    // The newest player and devices from the portal.
    let server: PlayerView | null = null;
    // This device's song changes that the store hasn't confirmed yet.
    let steps: Advance[] = [];
    // Set while this device is the active one: the generation it plays under and its last report number.
    let own: { generation: number; seq: number } | null = null;
    let activating = 0;
    // The generation of the last player this page applied from its stream.
    let seen: number | null = null;
    type Head = { entryId: string | null; positionMs: number; at: number; playing: boolean };
    let lastPlayhead: Head | null = null;
    // Inside the Android app: whether the app was playing when this page loaded (null until it says).
    let nativePlaying: boolean | null = device ? null : false;
    let started = false;
    type Report = { generation: number; seq: number; advance?: Advance; playhead?: Head; volume?: number; repeat?: Repeat };
    const outbox: Report[] = []; let sending: Report | null = null; let flushing = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined; let retryAttempt = 0;

    const shown = (): Player | null => server && steps.reduce(advanced, server.player);
    const publish = () => { const player = shown(); setView(server && player ? { player, devices: server.devices } : null); };
    const commit = (change: Partial<Deck>) => {
      const next = { ...deckRef.current, ...change }; deckRef.current = next; setDeck(next);
      if ('mediaSession' in navigator && next.entryId) navigator.mediaSession.playbackState = next.status === 'playing' ? 'playing' : 'paused';
      if (own) sync();
    };
    const unavailable = () => new ApiError(503, 'invalid_response', 'Your player is unavailable right now. Try again.');
    const send = async (body: object) => {
      const csrf = latest.current.bootstrap?.csrfToken;
      if (!csrf) throw new ApiError(401, 'unauthenticated', 'Sign in again to use your player.');
      return api.player(csrf, body);
    };
    const asView = (result: unknown): PlayerView => {
      if (!validView(result)) throw unavailable();
      return { player: result.player, devices: result.devices };
    };
    const guild = () => snowflake(latest.current.guildId) ? { guildId: latest.current.guildId } : {};

    // Reports from the active device go one at a time, in order; one that can't be
    // delivered now goes again with the same number, so the store applies it once.
    const report = (body: Omit<Report, 'generation' | 'seq'>) => {
      if (!own) return;
      const last = outbox.at(-1);
      if (last && last !== sending && body.playhead && Object.keys(body).length === 1 && last.playhead && Object.keys(last).length === 3) { last.playhead = body.playhead; return; }
      outbox.push({ ...body, generation: own.generation, seq: ++own.seq });
      void flush();
    };
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (outbox.length) {
          const item = outbox[0];
          if (!own || !me || item.generation !== own.generation) { outbox.shift(); continue; }
          sending = item;
          try {
            const result = await send({ op: 'report', deviceId: me.deviceId, ...item });
            outbox.shift(); retryAttempt = 0;
            if (item.advance) steps = steps.filter(step => step !== item.advance);
            receive(asView(result));
          } catch (error) {
            if (error instanceof ApiError && error.code === 'replaced') {
              outbox.length = 0;
              const player = (error.body as { player?: unknown } | null)?.player;
              if (validPlayer(player)) receive({ player });
              if (own) halt(true);
              return;
            }
            if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
              // A report the store can't take is dropped; the next one says where things are.
              outbox.shift();
              if (item.advance) { steps = steps.filter(step => step !== item.advance); publish(); }
              continue;
            }
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => void flush(), Math.min(30_000, 1000 * 2 ** retryAttempt++));
            return;
          } finally { sending = null; }
        }
      } finally { flushing = false; }
    };
    // The playhead, reported whenever it moves other than by playing on: play, pause, seek, a new song.
    const sync = (force = false) => {
      const now = deckRef.current;
      if (!own || now.waiting) return;
      const playing = now.status === 'playing' && !!now.entryId;
      const head = { entryId: now.entryId, positionMs: Math.max(0, Math.min(86_400_000, Math.floor(position(now)))), at: Math.round(clock.now()), playing };
      const last = lastPlayhead;
      const expected = last ? last.positionMs + (last.playing ? head.at - last.at : 0) : 0;
      if (!force && last && last.entryId === head.entryId && last.playing === playing && Math.abs(expected - head.positionMs) < 1500) return;
      lastPlayhead = head;
      report({ playhead: head });
    };
    const parts: EngineParts = {
      commit, deck: () => deckRef.current, shown, notify, report,
      advance: step => { steps.push(step); lastPlayhead = null; report({ advance: step }); publish(); },
      guildId: () => {
        const id = server?.player.guildId;
        return id && latest.current.bootstrap?.guilds.some(item => item.id === id) ? id : latest.current.guildId;
      },
      owning: () => !!own, steady: () => !steps.length,
    };
    const engine = device ? nativeEngine(device, parts, playing => { nativePlaying = playing; start(); }) : webEngine(parts);
    // Tabs of one browser are one device; the tab that plays answers for it.
    const tabs = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('vybertron.player');
    if (tabs) tabs.onmessage = event => { if (own && event.data?.ask === own.generation) tabs.postMessage({ playing: own.generation }); };
    const playingInAnotherTab = (generation: number) => new Promise<boolean>(resolve => {
      if (!tabs) { resolve(false); return; }
      const listen = (event: MessageEvent) => { if (event.data?.playing === generation) finish(true); };
      const timer = setTimeout(() => finish(false), 300);
      const finish = (answer: boolean) => { clearTimeout(timer); tabs.removeEventListener('message', listen); resolve(answer); };
      tabs.addEventListener('message', listen);
      tabs.postMessage({ ask: generation });
    });

    // Tabs of one browser are one device, and only one of them plays: the one holding this
    // lock. The tab that asked to play takes it; when another device makes this one play,
    // the first tab to claim it does (a hidden tab waits a moment, so a visible one is preferred).
    // Nothing takes the lock from a tab: it plays until it stops, and the tab that asked waits
    // briefly for it (a tab that played before lets go as it stops) and otherwise stays a remote.
    let unlock: (() => void) | null = null;
    const claim = async (asked: boolean) => {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (!locks || !me) return true;
      if (unlock) return true;
      if (!asked && document.hidden) await new Promise(resolve => setTimeout(resolve, 200));
      return new Promise<boolean>(resolve => {
        locks.request(`vybertron-player-${me!.deviceId}`, asked ? { signal: AbortSignal.timeout(1500) } : { ifAvailable: true }, lock => {
          if (!lock) { resolve(false); return; }
          resolve(true);
          return new Promise<void>(done => { unlock = done; });
        }).catch(() => resolve(false));
      });
    };
    const halt = (announce: boolean) => {
      unlock?.(); unlock = null;
      own = null; outbox.length = 0; steps = []; lastPlayhead = null; clearTimeout(retryTimer);
      engine.halt();
      commit({ owner: false, entryId: null, track: null, status: 'idle', positionMs: 0, at: Date.now(), waiting: false, durationMs: 0 });
      publish();
      if (!announce) return;
      const active = server?.devices.find(item => item.deviceId === server?.player.activeDeviceId);
      notify(active ? `Playing on ${active.name} now.` : 'Another device is playing now.', 'info');
    };
    const begin = (player: Player, positionMs: number, playing: boolean, keep = false) => {
      commit({ owner: true, volume: player.volume, repeat: player.repeat });
      own = { generation: player.generation, seq: 0 }; outbox.length = 0; steps = []; lastPlayhead = null;
      engine.begin(player, positionMs, playing, keep);
    };
    // Still the active device under the generation it plays? Otherwise it stops at once.
    const check = () => {
      if (!own || activating || !server || !me) return;
      if (server.player.activeDeviceId !== me.deviceId || server.player.generation !== own.generation) halt(true);
      else if (!steps.length) engine.follow(shown()!);
    };
    const receive = (next: { player: Player; devices?: Device[] }, fromStream = false) => {
      if (server && next.player.updatedAt < server.player.updatedAt) return;
      server = { player: next.player, devices: next.devices ?? server?.devices ?? [] };
      if (actor) cacheView(actor, server);
      // A name this device was given on another device is its name here too.
      const mine = me && server.devices.find(item => item.deviceId === me!.deviceId);
      if (me && mine && mine.name !== me.name && validName(mine.name)) { me = { ...me, name: mine.name }; saveIdentity(me); setIdentity(me); }
      const player = server.player;
      // Made the active device from another device while connected: play here.
      if (fromStream && !own && !activating && me && player.activeDeviceId === me.deviceId && seen !== null && player.generation > seen) {
        const { generation } = player;
        void claim(false).then(mine => {
          const now = server?.player;
          if (mine && !own && !activating && now?.generation === generation && now.activeDeviceId === me?.deviceId) begin(now, playheadAt(now, clock.now()), now.playhead.playing);
          else if (mine && !own) { unlock?.(); unlock = null; }
        });
      }
      if (fromStream) { seen = player.generation; setStreaming(true); }
      publish();
      check();
      if (fromStream) start();
    };
    // Once per page, with its first player and (in the app) the app's state: a page that
    // finds this device the active one while nothing plays here (it was reloaded, or
    // closed without a word) lets go, so the player waits paused. Music the Android app
    // kept playing while its page was gone becomes the player's instead, under a new
    // generation so its reports count, unless another device plays now.
    const start = () => {
      if (started || !server || !me || seen === null || nativePlaying === null) return;
      started = true;
      const player = server.player; const mine = player.activeDeviceId === me.deviceId;
      if (nativePlaying) {
        if (!mine && reachable(player)) engine.halt(); else void activate(me.deviceId, { keep: true });
        return;
      }
      if (!mine || own || activating) return;
      const generation = player.generation; const deviceId = me.deviceId;
      void playingInAnotherTab(generation).then(async elsewhere => {
        if (elsewhere || own || server?.player.generation !== generation || server.player.activeDeviceId !== deviceId) return;
        try { receive(asView(await send({ op: 'deactivate', deviceId, generation }))); } catch { /* Another device took over meanwhile. */ }
      });
    };
    const activate = async (deviceId: string, how: { positionMs?: number; playing?: boolean; volume?: number; repeat?: Repeat; keep?: boolean; idle?: boolean } = {}) => {
      if (!me) return false;
      const self = deviceId === me.deviceId;
      if (self) activating++;
      try {
        const result = asView(await send({ op: 'activate', deviceId, ...guild() }));
        receive(result);
        if (!self) return true;
        const player = result.player;
        // Another tab of this browser plays it: this one stays a remote.
        if (!await claim(true)) return !how.idle;
        if (how.idle) { commit({ owner: true, entryId: player.current?.entryId ?? null, volume: player.volume, repeat: player.repeat }); own = { generation: player.generation, seq: 0 }; outbox.length = 0; steps = []; lastPlayhead = null; return true; }
        begin(player, how.positionMs ?? playheadAt(player, clock.now()), how.playing ?? player.playhead.playing, how.keep);
        if (how.volume !== undefined && how.volume !== player.volume) engine.act('volume', how.volume);
        if (how.repeat !== undefined && how.repeat !== player.repeat) engine.act('repeat', how.repeat);
        return true;
      } catch (error) {
        notify(errorMessage(error), 'error');
        return false;
      } finally {
        if (self) { activating--; check(); }
      }
    };
    // A queue edit by entry, against the revision shown. Refused as stale, it is
    // built again on the newer player and sent once more, if it still means something.
    const edit = async (build: (player: Player) => Record<string, unknown> | null, retried = false): Promise<PlayerView | null> => {
      const player = shown();
      if (!player) { notify('Your player is still connecting. Try again in a moment.', 'error'); return null; }
      const body = build(player);
      if (!body) { notify(STALE, 'error'); return null; }
      try { const result = asView(await send(body)); receive(result); return result; }
      catch (error) {
        const fresh = (error as ApiError)?.body as { player?: unknown } | null;
        if (error instanceof ApiError && error.code === 'stale' && validPlayer(fresh?.player)) {
          receive({ player: fresh.player });
          if (!retried) return edit(build, true);
        }
        notify(errorMessage(error), 'error');
        return null;
      }
    };
    const control = async (action: ControlAction, value?: number | Repeat) => {
      try {
        const result = await send({ op: 'control', action, ...(value !== undefined && { value }) });
        if (result.relayed !== true) receive(asView(result));
        return true;
      } catch (error) { notify(errorMessage(error), 'error'); return false; }
    };
    // Whether another device plays the player and can be reached to carry out a control. One
    // that is gone (switched off, out of network) passes playback on to whichever device plays next.
    const reachable = (player: Player | null) => {
      const active = player?.activeDeviceId;
      return !!active && active !== me?.deviceId && !!server?.devices.some(item => item.deviceId === active && item.connected);
    };
    // Play, pause and the rest: carried out here while this device plays, otherwise sent
    // to the device that plays. Play with no device playing makes this one play.
    const transport = (action: ControlAction, value?: number | Repeat): boolean | Promise<boolean> => {
      if (own) return engine.act(action, value);
      const player = shown();
      if (action === 'play' && me && !reachable(player)) {
        if (!player?.current && !player?.queue.length) return false;
        return activate(me.deviceId, { playing: true });
      }
      return control(action, value);
    };
    // After an edit that should start the music (Play now, or the first song added).
    const playAfter = (player: Player) => {
      if (own) return engine.act('play');
      if (me && !reachable(player)) return activate(me.deviceId, { playing: true });
      return player.playhead.playing || control('play');
    };
    // Until the store has this device's song changes (or it stops playing), at most a few seconds.
    const confirmed = () => new Promise<boolean>(resolve => {
      const until = Date.now() + 5000;
      const wait = () => { if (!own || Date.now() > until) resolve(false); else if (!steps.length) resolve(true); else setTimeout(wait, 50); };
      wait();
    });
    const has = (list: PlayerEntry[], entryId: string) => list.some(entry => entry.entryId === entryId);

    const enqueue = async (tracks: Track[], next: boolean) => {
      const songs = tracks.map(playerTrack).filter((track): track is PlayerTrack => !!track);
      if (!songs.length) { notify('Nothing here has a public source this device can play.', 'error'); return false; }
      const player = shown();
      if (!player) { notify('Your player is still connecting. Try again in a moment.', 'error'); return false; }
      const empty = !player.current;
      const added = songs.slice(0, Math.max(0, MAX_QUEUE - player.queue.length + (empty ? 1 : 0)));
      if (!added.length) { notify(`Your queue is full at ${MAX_QUEUE} songs.`, 'error'); return false; }
      // Large additions go in batches; songs played next stay together, in order.
      let after: string | null = null; let placed = 0; let result: PlayerView | null = null;
      for (const [index, batch] of batches(added).entries()) {
        const where = !next ? 'end' : after ? { after } : 'next';
        result = await edit(current => ({ op: 'add', expectedRevision: current.revision, tracks: batch, position: where, ...guild() }));
        if (!result) return false;
        placed += batch.length - (index === 0 && empty ? 1 : 0);
        after = result.player.queue[placed - 1]?.entryId ?? null;
      }
      notify(added.length === 1 ? `Added “${added[0].title}” to your queue.` : `Added ${added.length} songs to your queue.`, 'success');
      if (empty && result) await playAfter(result.player);
      return true;
    };
    const skipTo = async (entryId: string) => {
      const result = await edit(player => has(player.queue, entryId) ? { op: 'skipTo', expectedRevision: player.revision, entryId } : null);
      return !!result && await playAfter(result.player);
    };

    const run = async (body: Command, capability: Capability, hint?: Track[]): Promise<boolean> => {
      const o = body.options || {}; const player = shown();
      const key = `${body.command}:${body.subcommand || ''}`;
      // A song chosen by its place in the queue on screen.
      const at = (value: unknown) => {
        const index = Number(value) - 1;
        if (!player || !Number.isInteger(index) || index < 0 || index >= player.queue.length) return null;
        if (body.expectedRevision && body.expectedRevision !== revisionOf(player)) { notify(STALE, 'error'); return null; }
        return player.queue[index];
      };
      switch (key) {
        case 'pause:': return transport('pause');
        case 'resume:': return transport('play');
        case 'seek:': { const target = milliseconds(o.timestamp); return target !== null && transport('seek', target); }
        case 'back:': return transport('previous');
        case 'skip:': return transport('next');
        case 'volume:': return transport('volume', volumeOf(o.level));
        case 'loop:': return transport('repeat', repeatOf(o.mode));
        case 'skipto:': { const entry = at(o.position); return !!entry && skipTo(entry.entryId); }
        case 'remove:': {
          const entry = at(o.position);
          return !!entry && !!await edit(current => has(current.queue, entry.entryId) ? { op: 'remove', expectedRevision: current.revision, entryId: entry.entryId } : null);
        }
        case 'move:': {
          const entry = at(o.from); const to = Number(o.to) - 1;
          if (!entry || !Number.isInteger(to) || to < 0) return false;
          return !!await edit(current => {
            if (!has(current.queue, entry.entryId)) return null;
            const rest = current.queue.filter(item => item.entryId !== entry.entryId);
            return { op: 'move', expectedRevision: current.revision, entryId: entry.entryId, before: rest[to]?.entryId ?? null };
          });
        }
        case 'clear:': return !!await edit(current => ({ op: 'clear', expectedRevision: current.revision }));
        case 'shuffle:': return !!await edit(current => ({ op: 'shuffle', expectedRevision: current.revision }));
        // Stop clears what's next, then moves past the current song to nothing.
        // Stop lets go of the current song and empties what's next, whatever repeat says. Only the
        // device that plays can let go of a song, so another device becomes it to stop.
        // Stop lets go of the current song and empties what's next, whatever repeat says. Only the
        // device that plays can let go of a song, so another device becomes it to stop. On repeat the
        // store puts the song it lets go back at the end of the queue, so the queue clears after that.
        case 'stop:': {
          if (shown()?.current) {
            if (!own && !(me && await activate(me.deviceId, { idle: true }))) return false;
            engine.stop();
            if (!await confirmed()) { notify('Your player didn’t confirm the stop. Check where it is, then try again.', 'error'); return false; }
          }
          return !shown()?.queue.length || !!await edit(current => ({ op: 'clear', expectedRevision: current.revision }));
        }
        default:
          // Library edits don't touch playback, so the bot still owns them.
          if (LIBRARY.has(key)) return latest.current.run(body, capability);
          if (ADDS.has(key)) return inLine(key, async () => {
            const tracks = await tracksFor(latest.current, body, hint);
            if (!tracks) { notify('That list changed. Refresh it and try again.', 'error'); return false; }
            return enqueue(tracks, key === 'playnext:' || key === 'replay:');
          });
          notify(DISCORD_ONLY, 'info'); return false;
      }
    };
    // Additions run one at a time, in the order tapped, and show as pending meanwhile.
    const inLine = async (key: string, work: () => Promise<boolean>) => {
      const queue = line.current;
      queue.keys = [...queue.keys, key]; setPending(queue.keys);
      const turn = queue.tail.then(work);
      queue.tail = turn.catch(() => undefined);
      try { return await turn; } catch (error) { notify(errorMessage(error), 'error'); return false; }
      finally { const index = queue.keys.indexOf(key); queue.keys = queue.keys.filter((_, at) => at !== index); setPending(queue.keys); }
    };

    // Lock-screen, headset and car controls act on the player.
    if ('mediaSession' in navigator && !device) {
      const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => void run({ command: 'resume' }, 'control')], ['pause', () => void run({ command: 'pause' }, 'control')],
        ['nexttrack', () => void run({ command: 'skip' }, 'control')], ['previoustrack', () => void run({ command: 'back' }, 'control')],
        ['seekto', details => { if (details.seekTime !== undefined) void run({ command: 'seek', options: { timestamp: timestamp(details.seekTime * 1000) } }, 'control'); }],
      ];
      for (const [action, handler] of actions) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } }
    }

    return {
      device, run, transport, control, activate, edit, shown, receive, halt, send,
      own: () => own, identity: () => me,
      identify: (identity: Identity) => { me = identity; },
      // Before its stream connects, a page shows only the same listener's last copy of their player.
      signedIn: (actorId: string) => {
        if (actor === actorId) return;
        if (own) halt(false);
        actor = actorId; server = null; seen = null; steps = []; started = false;
        setStreaming(false); setView(cachedView(actorId));
      },
      signedOut: () => { if (own) halt(false); actor = null; server = null; seen = null; started = false; setStreaming(false); setView(null); },
      disconnected: () => setStreaming(false),
      command: (data: PlayerCommand) => { if (own && data.generation === own.generation) engine.act(data.action, data.value); },
      tick: () => { if (own && deckRef.current.status === 'playing') sync(true); },
      // A page going away lets go of playback, so the player waits paused where it stopped.
      // The Android app keeps playing without its page, so it keeps playback.
      leave: () => {
        if (!own || !me || device) return;
        const csrf = latest.current.bootstrap?.csrfToken; const generation = own.generation;
        halt(false);
        if (csrf) void fetch('/api/me/player', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ op: 'deactivate', deviceId: me.deviceId, generation }) }).catch(() => undefined);
      },
      hold: () => { const wasPlaying = !!own && deckRef.current.status === 'playing'; if (wasPlaying) engine.act('pause'); return wasPlaying; },
      proceed: () => { if (own) engine.act('play'); },
      rename: async (value: string) => {
        const name = validName(value);
        if (!name || !me) { notify('Give this device a name of up to 40 characters.', 'error'); return false; }
        me = { ...me, name }; saveIdentity(me); setIdentity(me);
        try { receive(asView(await send({ op: 'rename', deviceId: me.deviceId, name }))); }
        catch (error) { if (!(error instanceof ApiError && error.code === 'unknown_device')) { notify(errorMessage(error), 'error'); return false; } }
        return true;
      },
      // The old deck joins the player's queue, in batches, with its place when the player is empty.
      adoptLegacy: async (deck: LegacyDeck) => {
        const room = MAX_QUEUE - (deck.current ? 1 : 0);
        let dropped = Math.max(0, deck.tracks.length - room);
        const groups = batches(deck.tracks.slice(0, room));
        try {
          for (const [index, tracks] of (groups.length ? groups : [[]]).entries()) {
            const first = index === 0;
            const result = await send({ op: 'adopt', tracks, ...(first && { current: deck.current, positionMs: deck.positionMs, volume: deck.volume, repeat: deck.repeat, ...guild() }) });
            receive(asView(result));
            if (Number.isSafeInteger(result.dropped)) dropped += result.dropped as number;
          }
        } catch (error) { notify(errorMessage(error), 'error'); return; }
        notify(dropped ? `Added this device’s songs to your player. ${dropped} ${dropped === 1 ? 'song didn’t' : 'songs didn’t'} fit in your queue.` : 'Added this device’s songs to your player.', dropped ? 'info' : 'success');
      },
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void loadIdentity(core.device).then(found => { if (!alive) return; core.identify(found); setIdentity(found); });
    return () => { alive = false; };
  }, [core]);
  // While signed in, this device keeps its listener stream open: the player, the devices, and controls for it.
  const viewerId = remote.auth === 'ready' ? remote.bootstrap?.viewer.id : undefined;
  const deviceId = identity?.deviceId;
  useEffect(() => {
    if (!viewerId || !deviceId) return;
    core.signedIn(viewerId);
    const abort = new AbortController();
    let source: EventSource | undefined; let timer: ReturnType<typeof setTimeout> | undefined; let attempt = 0;
    const open = () => {
      const me = core.identity();
      if (abort.signal.aborted || !me) return;
      const stream = new EventSource(api.playerEventsUrl(me), { withCredentials: true }); source = stream;
      const mine = () => source === stream && !abort.signal.aborted;
      stream.addEventListener('player', event => {
        if (!mine()) return;
        try { const data = JSON.parse((event as MessageEvent).data); if (validView(data)) { attempt = 0; core.receive(data, true); } } catch { /* The next frame replaces it. */ }
      });
      stream.addEventListener('command', event => {
        if (!mine()) return;
        try { core.command(JSON.parse((event as MessageEvent).data)); } catch { /* Not for this device. */ }
      });
      // The portal retires a stream after a while and says so first: open the next one at once.
      stream.addEventListener('rotate', () => { if (mine()) { stream.close(); open(); } });
      stream.onerror = () => {
        if (!mine()) return;
        stream.close(); source = undefined; core.disconnected();
        clearTimeout(timer); timer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempt++));
      };
      void syncClock(abort.signal);
    };
    open();
    return () => { abort.abort(); source?.close(); source = undefined; clearTimeout(timer); core.disconnected(); };
  }, [viewerId, deviceId, core]);
  // The active device reports where it is every 15 seconds while it plays.
  useEffect(() => { const timer = setInterval(core.tick, REPORT_EVERY_MS); return () => clearInterval(timer); }, [core]);
  useEffect(() => { window.addEventListener('pagehide', core.leave); return () => window.removeEventListener('pagehide', core.leave); }, [core]);
  // A signed-out device keeps nobody's player.
  useEffect(() => {
    if (remote.auth !== 'signed-out') return;
    core.signedOut(); forgetCachedViews(); setLegacy(null);
  }, [remote.auth, core]);
  // This browser's old deck belongs to no account: once connected, ask whether to add it. Never upload it unasked.
  const asked = useRef(false);
  useEffect(() => {
    if (!streaming || asked.current) return;
    asked.current = true;
    setLegacy(legacyDeck());
  }, [streaming]);
  const answerLegacy = useCallback(async (add: boolean) => {
    const deck = legacy; setLegacy(null); forgetLegacyDeck();
    if (add && deck) await core.adoptLegacy(deck);
  }, [legacy, core]);

  // Older bots don't report the viewer's voice (or accept a transfer): stay with Discord there.
  const viewerVoice = remote.snapshot?.session.viewerVoice;
  const inVoice = viewerVoice !== null;
  const [automatic, setAutomatic] = useState<PlaybackTarget>(inVoice ? 'discord' : 'local');
  useEffect(() => {
    // Joining voice never cuts off music already playing here.
    if (!(inVoice && deckRef.current.owner && deckRef.current.status === 'playing')) setAutomatic(inVoice ? 'discord' : 'local');
  }, [inVoice]);
  useEffect(() => setChoice(null), [remote.guildId]);
  const target = choice ?? automatic;
  const local = target === 'local';
  // Playing in Discord silences this device; the player waits, paused.
  useEffect(() => { if (!local) core.hold(); }, [local, core]);
  const base = remote.snapshot;
  const discord = base?.session ?? null;
  const moveToDiscord = useCallback(async () => {
    const player = core.shown(); const session = latest.current.snapshot?.session; const owner = core.own();
    // A session already playing there is joined, not replaced; the player waits, paused.
    if (!player?.current || session?.current || session?.queue.length) { core.hold(); setChoice('discord'); return true; }
    const tracks = [player.current, ...player.queue].flatMap(entry => entry.track.uri ? [entry.track.uri] : []).slice(0, TRANSFER_TRACKS);
    const now = deckRef.current;
    const at = owner ? position(now) : playheadAt(player, clock.now());
    const volume = owner ? now.volume : player.volume; const repeat = owner ? now.repeat : player.repeat;
    const elsewhere = !owner && !!player.activeDeviceId && player.playhead.playing;
    const wasPlaying = owner ? core.hold() : elsewhere;
    setPending(['transfer:']);
    try {
      const ok = await latest.current.run({ command: 'transfer', options: { position: Math.min(Math.floor(at), 86_400_000), paused: !wasPlaying, volume, repeat }, tracks }, 'add');
      if (!ok) { if (wasPlaying && owner) core.proceed(); return false; }
      // The music moved: this device lets go of the player, which waits paused where it was.
      const playing = core.own(); const me = core.identity();
      if (playing && me) {
        core.halt(false);
        await core.send({ op: 'deactivate', deviceId: me.deviceId, generation: playing.generation }).then(result => { if (validView(result)) core.receive(result); }, () => undefined);
      } else if (elsewhere) await core.control('pause');
      setChoice('discord');
      return true;
    } finally { setPending([]); }
  }, [core]);
  const moveHere = useCallback(async (stop: boolean) => {
    const live = latest.current; const session = live.snapshot?.session; const me = core.identity();
    if (!session?.current || !me) { setChoice('local'); return true; }
    const elapsed = session.status === 'playing' ? Math.max(0, Date.now() - live.receivedAt) : 0;
    const at = Math.min(session.positionMs + elapsed, session.durationMs || Infinity);
    if (stop && !await live.run({ command: 'stop' }, 'control')) return false;
    setChoice('local');
    // The Discord session becomes the player's: its songs replace what's next, then this device plays them.
    const songs = [session.current, ...session.queue].map(playerTrack).filter((track): track is PlayerTrack => !!track).slice(0, MAX_QUEUE);
    if (!songs.length) { live.notify('Nothing here has a public source this device can play.', 'error'); return false; }
    const [first, ...rest] = batches(songs);
    const guildId = snowflake(live.guildId) ? { guildId: live.guildId } : {};
    if (!await core.edit(player => ({ op: 'play', expectedRevision: player.revision, tracks: first, startIndex: 0, ...guildId }))) return false;
    for (const tracks of rest) if (!await core.edit(player => ({ op: 'add', expectedRevision: player.revision, tracks, position: 'end' }))) break;
    return core.activate(me.deviceId, { positionMs: at, playing: session.status === 'playing', volume: session.volume, repeat: session.repeat });
  }, [core]);
  const playOn = useCallback(async (id: string) => {
    const me = core.identity();
    setChoice('local');
    if (!me) return false;
    if (id === me.deviceId) {
      if (core.own()) return true;
      const player = core.shown();
      return core.activate(id, { playing: !!player?.activeDeviceId && player.playhead.playing });
    }
    return core.activate(id);
  }, [core]);
  // Listener actions keep one identity, so memoized views that receive them can skip a render.
  const events = useMemo(() => ({
    refreshLibrary: () => latest.current.refreshLibrary(), reconnect: () => latest.current.reconnect(),
    dismissNotice: () => latest.current.dismissNotice(), logout: () => latest.current.logout(), selectGuild: (id: string) => latest.current.selectGuild(id),
    renameDevice: core.rename,
  }), [core]);
  const player = view?.player ?? null;
  const owner = deck.owner;
  const active = player?.activeDeviceId ?? null;
  const devices = useMemo((): DeviceChoice[] => {
    if (!identity) return [];
    const listed = (view?.devices ?? []).map(item => ({ ...item, self: item.deviceId === identity.deviceId, active: item.deviceId === active }));
    if (!listed.some(item => item.self)) listed.push({ deviceId: identity.deviceId, name: identity.name, kind: identity.kind, lastSeen: 0, connected: streaming, active: false, self: true });
    const gesture = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive ?? true;
    return listed.map(item => {
      const playable = item.self ? item.kind !== 'browser' || gesture : item.connected;
      const note = item.active ? player?.playhead.playing ? 'Playing' : 'Paused here'
        : item.self ? playable ? '' : 'Tap to play here'
        : item.connected ? '' : item.kind === 'browser' ? 'Open the portal there to play' : 'Open the app to play here';
      return { ...item, playable, note };
    }).sort((a, b) => Number(b.self) - Number(a.self) || Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
  }, [view, identity, active, streaming, player?.playhead.playing]);
  const playingOn = local && active && active !== identity?.deviceId ? devices.find(item => item.deviceId === active)?.name ?? null : null;
  const revision = player ? revisionOf(player) : 'player:none';
  const receivedAt = owner ? deck.at : player ? clock.local(player.playhead.at) : 0;
  const snapshot = useMemo((): GuildSnapshot | null => {
    if (!local || !base) return base;
    const entry = player?.current ?? null;
    const mine = owner && !!entry && deck.entryId === entry.entryId;
    const current = entry ? asTrack(mine && deck.track ? deck.track : entry.track) : null;
    // The device that plays owns the playhead; elsewhere it moves on from its last report.
    const status = !current ? 'idle' : mine ? deck.status : player!.playhead.playing && !!active && streaming ? 'playing' : 'paused';
    return {
      ...base, revision,
      session: { ...base.session, status, voiceChannel: null, textChannel: null, current, queue: (player?.queue ?? []).map(item => asTrack(item.track)), hasPrevious: !!player?.history.length,
        positionMs: mine ? deck.positionMs : player?.playhead.positionMs ?? 0, starting: mine && deck.status === 'playing' && deck.waiting,
        durationMs: mine ? deck.durationMs : entry?.track.durationMs ?? 0, suggestions: [], volume: owner ? deck.volume : player?.volume ?? 100, repeat: owner ? deck.repeat : player?.repeat ?? 'off',
        radio: false, autoplay: 'off', fairQueue: false, listeners: [], canAdd: true, canControl: true, canVote: false, reason: null },
      savedSession: { ...base.savedSession, exists: false, canResume: false },
    };
  }, [local, base, player, owner, deck, active, streaming, revision]);
  const can = useCallback((capability: Capability) => {
    if (!local) return remote.can(capability);
    if (capability === 'add' || capability === 'control') return !!remote.snapshot;
    return capability === 'vote' || capability === 'resume' ? false : remote.can(capability);
  }, [local, remote.can, remote.snapshot]);
  // Each live frame is new JSON; its unchanged songs, listeners and settings keep their identity.
  const shown = useShared(local ? snapshot : base);
  const moves = { target, discord: local ? discord : shown?.session ?? null, moveToDiscord, moveHere, devices, playOn, playingOn, legacySongs: legacy?.songs ?? 0, answerLegacy };
  // One object for as long as nothing in it changes; a re-render elsewhere doesn't make a new portal.
  return useStableObject(!local ? { ...remote, ...events, ...moves, snapshot: shown }
    : { ...remote, ...events, snapshot: shown, receivedAt, can, pending, confirming: pending.length > 0, queued: 0, syncing: false, run: core.run, ...moves,
      blockedReason: remote.snapshot ? remote.blockedReason : 'Connecting to your server. Search and your library load from Discord.' });
}
// What the queue on screen was drawn from: an edit by position needs the same one.
const revisionOf = (player: Player) => `player:${player.revision}:${player.current?.entryId ?? ''}`;
