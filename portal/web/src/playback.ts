import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, publicUrl } from './api';
import { timestamp } from './format';
import type { Capability, Command, GuildSnapshot, Track } from './types';
import type { RemotePortal } from './usePortal';
import { isLink } from './suggestions';
import { youtubeId } from './youtube';

// Where music plays: the shared Discord session (the bot is the authority), or
// this device, where the portal keeps a private queue and plays its audio,
// streamed by the bot through the portal. Search, favorites and stats still come from the bot either way.
// Listeners outside voice start on this device; a session moves between the two
// like casting, carrying its songs, place, volume and repeat.
export type PlaybackTarget = 'discord' | 'local';
type Repeat = 'off' | 'track' | 'queue';
interface Deck {
  current: Track | null; queue: Track[]; status: 'idle' | 'playing' | 'paused';
  // Songs this session already played, most recent first, for Back.
  history: Track[];
  // Position at `at`; playing positions advance from there.
  positionMs: number; at: number; durationMs: number; volume: number; repeat: Repeat;
  // Bumped by queue edits so drag-and-drop can detect a changed queue.
  revision: number;
}
export type Portal = Omit<RemotePortal, 'run'> & {
  // `tracks` names the songs a list command means, for lists only the server knows by name.
  run: (body: Command, capability: Capability, tracks?: Track[]) => Promise<boolean>;
  target: PlaybackTarget;
  // The server's own session, whichever target is showing.
  discord: GuildSnapshot['session'] | null;
  // Moves this device's session into the viewer's voice channel, or joins the one already playing there.
  moveToDiscord: () => Promise<boolean>;
  // Brings the Discord session here; `stop` ends it in Discord, otherwise it keeps playing there too.
  moveHere: (stop: boolean) => Promise<boolean>;
};

const DECK_KEY = 'vybertron.local';
const MAX_QUEUE = 500;
const MAX_HISTORY = 100;
// Early in a song Back goes to the previous one; later it restarts this one.
export const RESTART_AFTER_MS = 3000;
const empty: Deck = { current: null, queue: [], history: [], status: 'idle', positionMs: 0, at: 0, durationMs: 0, volume: 100, repeat: 'off', revision: 0 };
export const DISCORD_ONLY = 'That works in a Discord session. Choose Discord under Play on in the player menu to use it.';
// The bot resolves each song it receives; the rest of a long queue stays behind.
export const TRANSFER_TRACKS = 100;

const isTrack = (value: unknown): value is Track => typeof (value as Track)?.id === 'string' && typeof (value as Track).title === 'string';
const volumeOf = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value)))) || 0;
// Local songs are the listener's own: no requester, no autoplay provenance.
const own = ({ suggested: _suggested, ...track }: Track): Track => ({ ...track, requestedBy: null });
const position = (deck: Deck) => deck.status === 'playing' ? deck.positionMs + Math.max(0, Date.now() - deck.at) : deck.positionMs;
function milliseconds(value: unknown) {
  const parts = String(value ?? '').split(':').map(Number);
  return parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0) ? null : parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}
function shuffled<T>(items: T[]) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) { const swap = Math.floor(Math.random() * (index + 1)); [copy[index], copy[swap]] = [copy[swap], copy[index]]; }
  return copy;
}
function initialDeck(): Deck {
  try {
    const saved = JSON.parse(localStorage.getItem(DECK_KEY) || 'null');
    if (!saved || !Array.isArray(saved.queue)) return empty;
    const current = isTrack(saved.current) ? saved.current : null;
    const history = Array.isArray(saved.history) ? saved.history.filter(isTrack).slice(0, MAX_HISTORY) : [];
    return { ...empty, current, queue: saved.queue.filter(isTrack).slice(0, MAX_QUEUE), history, status: current ? 'paused' : 'idle',
      positionMs: current ? Math.max(0, Number(saved.positionMs) || 0) : 0, durationMs: current?.durationMs || 0,
      volume: saved.volume === undefined ? 100 : volumeOf(saved.volume), repeat: ['track', 'queue'].includes(saved.repeat) ? saved.repeat : 'off' };
  } catch { return empty; }
}

export function useListening(remote: RemotePortal): Portal {
  // An explicit move this page; otherwise the target follows voice presence.
  const [choice, setChoice] = useState<PlaybackTarget | null>(null);
  const [deck, setDeck] = useState(initialDeck);
  const [pending, setPending] = useState<string[]>([]);
  const deckRef = useRef(deck);
  const pendingRef = useRef(false);
  const media = useRef<HTMLAudioElement | null>(null);
  // The YouTube video whose audio the element holds, if any.
  const loaded = useRef<string | null>(null);
  // Each load supersedes the previous one, including its late lookup or media events.
  const loadToken = useRef(0);
  const latest = useRef(remote); latest.current = remote;

  const engine = useMemo(() => {
    const notify: RemotePortal['notify'] = (message, kind) => latest.current.notify(message, kind);
    const commit = (change: Partial<Deck>, structural = false) => {
      const next = { ...deckRef.current, ...change, revision: deckRef.current.revision + (structural ? 1 : 0) };
      deckRef.current = next; setDeck(next);
      if ('mediaSession' in navigator && next.current) navigator.mediaSession.playbackState = next.status === 'playing' ? 'playing' : 'paused';
    };
    const retried = new Set<string>(); const warmed = new Set<string>();
    // One audio element for the whole session: phones keep it playing in the
    // background and on the lock screen, and it plays audio only, never video.
    const audio = () => {
      if (media.current) return media.current;
      const element = new Audio(); element.preload = 'auto';
      const current = () => loaded.current !== null && element.dataset.video === loaded.current && !!deckRef.current.current;
      const anchor = () => ({ positionMs: element.currentTime * 1000, at: Date.now() });
      element.addEventListener('playing', () => {
        if (!current()) return;
        commit({ status: 'playing', ...anchor(), ...(Number.isFinite(element.duration) && { durationMs: element.duration * 1000 }) });
        warmNext();
      });
      element.addEventListener('pause', () => { if (current() && !element.ended) commit({ status: 'paused', ...anchor() }); });
      for (const event of ['seeked', 'waiting']) element.addEventListener(event, () => { if (current()) commit(anchor()); });
      element.addEventListener('ended', () => { if (current()) advance(false); });
      element.addEventListener('error', () => { if (current() && element.error) void failed(element.dataset.video!); });
      media.current = element;
      return element;
    };
    const source = (videoId: string) => `/api/guilds/${encodeURIComponent(latest.current.guildId)}/audio/${videoId}`;
    // The next song downloads into the bot's cache while this one plays, so
    // the change between songs is quick even with the screen off.
    const warmNext = () => {
      const videoId = youtubeId(deckRef.current.queue[0]?.uri);
      if (!videoId || warmed.has(videoId)) return;
      warmed.add(videoId);
      void fetch(source(videoId), { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' })
        .then(response => response.body?.cancel()).catch(() => warmed.delete(videoId));
    };
    const describe = (track: Track) => {
      if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
      const artwork = publicUrl(track.artworkUrl);
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.author, album: 'Vybatron', artwork: artwork ? [{ src: artwork }] : [] });
    };
    // Songs from other catalogs play through their closest YouTube match.
    const playable = async (track: Track): Promise<Track | null> => {
      const { tracks } = await api.search(latest.current.guildId, `${track.author} ${track.title}`);
      const match = tracks.find(candidate => youtubeId(candidate.uri));
      return match ? own(match) : null;
    };
    const load = (track: Track, startMs: number, autoplay: boolean) => {
      const videoId = youtubeId(track.uri)!; const element = audio();
      loaded.current = videoId; element.dataset.video = videoId;
      // A media fragment starts at the saved place; the bot serves byte ranges.
      element.src = `${source(videoId)}${startMs >= 1000 ? `#t=${Math.floor(startMs / 1000)}` : ''}`;
      element.volume = deckRef.current.volume / 100;
      describe(track);
      if (!autoplay) return;
      element.play().catch((error: unknown) => {
        // A newer song replaced this one (AbortError), or the browser wants a tap first.
        if (loaded.current !== videoId || (error as Error)?.name !== 'NotAllowedError') return;
        commit({ status: 'paused', positionMs: startMs, at: Date.now() });
        notify('Tap play to start listening on this device.', 'info');
      });
    };
    // A song with a YouTube link starts synchronously, inside the tap that asked
    // for it, which is the only way iOS lets audio begin.
    const start = (track: Track, startMs: number, autoplay: boolean) => {
      const token = ++loadToken.current;
      if (youtubeId(track.uri)) { load(track, startMs, autoplay); return; }
      loaded.current = null;
      void playable(track).then(resolved => {
        if (token !== loadToken.current) return;
        if (!resolved) { notify(`“${track.title}” has no version this device can play. Skipping it.`, 'error'); advance(true, true); return; }
        commit({ current: resolved, durationMs: resolved.durationMs }, true);
        load(resolved, startMs, autoplay);
      }).catch(error => {
        if (token !== loadToken.current) return;
        const deck = deckRef.current;
        commit({ status: deck.current ? 'paused' : 'idle', positionMs: position(deck), at: Date.now() });
        notify(errorMessage(error), 'error');
      });
    };
    // Media errors carry no reason; the portal's answer for the same song does.
    const failed = async (videoId: string) => {
      const token = loadToken.current; const deck = deckRef.current;
      let status = 0; let message = 'This song couldn’t load on this device.';
      try {
        const response = await fetch(source(videoId), { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin' });
        status = response.status;
        if (!response.ok) message = (await response.json().catch(() => null))?.error?.message || message;
        else await response.body?.cancel();
      } catch { status = 0; }
      if (token !== loadToken.current || !deck.current) return;
      // Busy, briefly unreachable, or a dropped connection: one quiet retry from the same place.
      if ([0, 206, 429, 503].includes(status) && !retried.has(videoId)) {
        retried.add(videoId);
        setTimeout(() => {
          const now = deckRef.current;
          if (token === loadToken.current && now.current) start(now.current, position(now), now.status === 'playing');
        }, 1500);
        return;
      }
      notify(`“${deck.current.title}”: ${message} Skipping it.`, 'error');
      advance(true, true);
    };
    // Moving on remembers the song that was playing, unless it couldn't play.
    const remember = (deck: Deck, drop = false) => deck.current && !drop ? [deck.current, ...deck.history].slice(0, MAX_HISTORY) : deck.history;
    const play = (track: Track, queue: Track[], history = remember(deckRef.current), startMs = 0) => {
      commit({ current: track, queue, history, status: 'playing', positionMs: startMs, at: Date.now(), durationMs: track.durationMs }, true);
      start(track, startMs, true);
    };
    const stop = () => {
      ++loadToken.current; loaded.current = null;
      commit({ current: null, queue: [], history: [], status: 'idle', positionMs: 0, at: Date.now(), durationMs: 0 }, true);
      const element = media.current;
      if (element) { element.pause(); element.removeAttribute('src'); element.load(); }
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    };
    // The element, when it already holds the current song.
    const ready = () => (loaded.current && media.current?.dataset.video === loaded.current ? media.current : null);
    // `drop` retires a song that cannot play, so repeat never retries it forever.
    const advance = (manual: boolean, drop = false) => {
      const deck = deckRef.current;
      if (!manual && deck.repeat === 'track' && deck.current) { const element = ready(); if (element) { element.currentTime = 0; void element.play().catch(() => {}); } return; }
      const queue = [...deck.queue];
      if (deck.repeat === 'queue' && deck.current && !drop) queue.push(deck.current);
      const next = queue.shift();
      if (!next) { stop(); return; }
      play(next, queue, remember(deck, drop));
    };
    const enqueue = (tracks: Track[], next: boolean) => {
      const songs = tracks.filter(track => track.uri).map(own);
      if (!songs.length) { notify('Nothing here has a public source this device can play.', 'error'); return false; }
      const deck = deckRef.current;
      const added = songs.slice(0, MAX_QUEUE - deck.queue.length + (deck.current ? 0 : 1));
      if (!added.length) { notify(`Your queue on this device is full at ${MAX_QUEUE} songs.`, 'error'); return false; }
      if (!deck.current) { const [first, ...rest] = added; play(first, next ? [...rest, ...deck.queue] : [...deck.queue, ...rest]); }
      else commit({ queue: next ? [...added, ...deck.queue] : [...deck.queue, ...added] }, true);
      notify(added.length === 1 ? `Added “${added[0].title}” on this device.` : `Added ${added.length} songs on this device.`, 'success');
      return true;
    };
    // Typed text plays its best match; a link adds everything it names.
    const lookUp = async (query: string) => {
      const { tracks } = await api.search(latest.current.guildId, query);
      if (!tracks.length) throw new Error(`No tracks found for “${query}”.`);
      return isLink(query) ? tracks : tracks.slice(0, 1);
    };
    const tracksFor = async (body: Command, hint?: Track[]): Promise<Track[] | null> => {
      const o = body.options || {}; const library = latest.current.library;
      if (hint) return o.shuffle === true ? shuffled(hint) : hint;
      switch (`${body.command}:${body.subcommand || ''}`) {
        case 'play:': case 'playnext:': return typeof o.query === 'string' ? lookUp(o.query) : null;
        case 'favorite:play': { const track = library?.favorites[Number(o.index) - 1]; return track && track.id === body.expectedTrackId ? [track] : null; }
        case 'replay:': { const entry = library?.history[Number(o.index) - 1]; return entry && entry.id === body.expectedHistoryId ? [entry.track] : null; }
        case 'mix:load': return library?.mixes.find(mix => mix.name === o.name)?.tracks ?? null;
        default: return null;
      }
    };

    // The local counterpart of the bot's command handling.
    const run = async (body: Command, capability: Capability, hint?: Track[]): Promise<boolean> => {
      const o = body.options || {}; const deck = deckRef.current; const now = Date.now();
      const key = `${body.command}:${body.subcommand || ''}`;
      switch (key) {
        case 'pause:':
          if (deck.status !== 'playing') return true;
          commit({ status: 'paused', positionMs: position(deck), at: now }); ready()?.pause(); return true;
        case 'resume:':
          if (!deck.current) return false;
          commit({ status: 'playing', at: now });
          { const element = ready(); if (element) void element.play().catch(() => commit({ status: 'paused', at: Date.now() })); else start(deck.current, deck.positionMs, true); }
          return true;
        case 'seek:': {
          const target = milliseconds(o.timestamp);
          if (target === null || !deck.current) return false;
          commit({ positionMs: target, at: now });
          { const element = ready(); if (element) element.currentTime = target / 1000; else start(deck.current, target, deck.status === 'playing'); }
          return true;
        }
        case 'back:': {
          const [previous, ...history] = deck.history;
          if (!previous || (deck.current && position(deck) > RESTART_AFTER_MS)) return deck.current ? run({ command: 'seek', options: { timestamp: '00:00' } }, capability) : false;
          // The current song waits at the front of the queue, so Skip returns to it.
          play(previous, deck.current ? [deck.current, ...deck.queue].slice(0, MAX_QUEUE) : deck.queue, history);
          return true;
        }
        case 'volume:': { const volume = volumeOf(o.level); commit({ volume }); if (media.current) media.current.volume = volume / 100; return true; }
        case 'loop:': commit({ repeat: (['off', 'track', 'queue'].includes(String(o.mode)) ? o.mode : 'off') as Repeat }); return true;
        case 'skip:': if (!deck.current) return false; advance(true); return true;
        case 'skipto:': {
          const index = Number(o.position) - 1;
          if (!Number.isInteger(index) || index < 0 || index >= deck.queue.length) return false;
          play(deck.queue[index], deck.queue.slice(index + 1)); return true;
        }
        case 'remove:': {
          const index = Number(o.position) - 1;
          if (!Number.isInteger(index) || index < 0 || index >= deck.queue.length) return false;
          commit({ queue: deck.queue.filter((_, at) => at !== index) }, true); return true;
        }
        case 'move:': {
          const from = Number(o.from) - 1; const to = Number(o.to) - 1; const queue = [...deck.queue];
          if (![from, to].every(index => Number.isInteger(index) && index >= 0 && index < queue.length) || from === to) return false;
          queue.splice(to, 0, queue.splice(from, 1)[0]); commit({ queue }, true); return true;
        }
        case 'clear:': commit({ queue: [] }, true); return true;
        case 'shuffle:': commit({ queue: shuffled(deck.queue) }, true); return true;
        case 'stop:': stop(); return true;
        // Library edits don't touch playback, so the bot still owns them.
        case 'favorite:remove': case 'favorite:clear': case 'mix:delete': return latest.current.run(body, capability);
        case 'play:': case 'playnext:': case 'replay:': case 'favorite:play': case 'mix:load': case 'top:play': case 'mymix:play': {
          if (pendingRef.current) return false;
          pendingRef.current = true; setPending([key]);
          try {
            const tracks = await tracksFor(body, hint);
            if (!tracks) { notify('That list changed. Refresh it and try again.', 'error'); return false; }
            return enqueue(tracks, key === 'playnext:' || key === 'replay:');
          } catch (error) { notify(errorMessage(error), 'error'); return false; }
          finally { pendingRef.current = false; setPending([]); }
        }
        default: notify(DISCORD_ONLY, 'info'); return false;
      }
    };
    // Takes over a session from Discord at its current place.
    const adopt = (session: GuildSnapshot['session'], positionMs: number) => {
      if (!session.current) return;
      commit({ volume: session.volume, repeat: session.repeat });
      const playing = session.status === 'playing';
      commit({ current: own(session.current), queue: session.queue.map(own).slice(0, MAX_QUEUE), history: [], status: playing ? 'playing' : 'paused',
        positionMs, at: Date.now(), durationMs: session.durationMs || session.current.durationMs }, true);
      start(deckRef.current.current!, positionMs, playing);
    };
    const hold = () => {
      const deck = deckRef.current; const wasPlaying = deck.status === 'playing';
      if (wasPlaying) { commit({ status: 'paused', positionMs: position(deck), at: Date.now() }); ready()?.pause(); }
      return wasPlaying;
    };
    const proceed = () => { if (deckRef.current.current) void run({ command: 'resume' }, 'control'); };
    // Lock-screen, headset and car controls act on this device's queue.
    if ('mediaSession' in navigator) {
      const actions: [MediaSessionAction, MediaSessionActionHandler][] = [
        ['play', () => void run({ command: 'resume' }, 'control')], ['pause', () => void run({ command: 'pause' }, 'control')],
        ['nexttrack', () => void run({ command: 'skip' }, 'control')], ['previoustrack', () => void run({ command: 'back' }, 'control')],
        ['seekto', details => { if (details.seekTime !== undefined) void run({ command: 'seek', options: { timestamp: timestamp(details.seekTime * 1000) } }, 'control'); }],
      ];
      for (const [action, handler] of actions) { try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ } }
    }
    return { run, stop, adopt, hold, proceed, snapshot: () => deckRef.current };
  }, []);

  useEffect(() => {
    const save = () => {
      const deck = deckRef.current;
      try { localStorage.setItem(DECK_KEY, JSON.stringify({ current: deck.current, queue: deck.queue, history: deck.history, positionMs: position(deck), volume: deck.volume, repeat: deck.repeat })); }
      catch { /* The queue still plays; it just won't survive a reload. */ }
    };
    save();
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [deck]);
  // A signed-out device keeps nobody's queue.
  useEffect(() => {
    if (remote.auth !== 'signed-out') return;
    engine.stop();
    try { localStorage.removeItem(DECK_KEY); } catch { /* Nothing stored. */ }
  }, [remote.auth, engine]);

  // Older bots don't report the viewer's voice (or accept a transfer): stay with Discord there.
  const viewerVoice = remote.snapshot?.session.viewerVoice;
  const inVoice = viewerVoice !== null;
  const [automatic, setAutomatic] = useState<PlaybackTarget>(inVoice ? 'discord' : 'local');
  useEffect(() => {
    // Joining voice never cuts off music already playing here.
    if (!(inVoice && deckRef.current.status === 'playing')) setAutomatic(inVoice ? 'discord' : 'local');
  }, [inVoice]);
  useEffect(() => setChoice(null), [remote.guildId]);
  const target = choice ?? automatic;
  const local = target === 'local';
  // Playing in Discord silences this device; its queue waits, paused.
  useEffect(() => { if (!local) engine.hold(); }, [local, engine]);
  const base = remote.snapshot;
  const discord = base?.session ?? null;
  const moveToDiscord = async () => {
    const deck = engine.snapshot(); const session = latest.current.snapshot?.session;
    // A session already playing there is joined, not replaced; songs here wait, paused.
    if (!deck.current || session?.current || session?.queue.length) { engine.hold(); setChoice('discord'); return true; }
    const tracks = [deck.current, ...deck.queue].flatMap(track => track.uri ? [track.uri] : []).slice(0, TRANSFER_TRACKS);
    const wasPlaying = engine.hold();
    setPending(['transfer:']);
    try {
      const ok = await latest.current.run({ command: 'transfer', options: { position: Math.min(Math.floor(position(deck)), 86_400_000), paused: !wasPlaying,
        volume: deck.volume, repeat: deck.repeat }, tracks }, 'add');
      if (!ok) { if (wasPlaying) engine.proceed(); return false; }
      engine.stop(); setChoice('discord');
      return true;
    } finally { setPending([]); }
  };
  const moveHere = async (stop: boolean) => {
    const live = latest.current; const session = live.snapshot?.session;
    if (!session?.current) { setChoice('local'); return true; }
    const elapsed = session.status === 'playing' ? Math.max(0, Date.now() - live.receivedAt) : 0;
    const at = Math.min(session.positionMs + elapsed, session.durationMs || Infinity);
    if (stop && !await live.run({ command: 'stop' }, 'control')) return false;
    setChoice('local');
    engine.adopt(session, at);
    return true;
  };
  const snapshot = useMemo((): GuildSnapshot | null => !local || !base ? base : {
    ...base, revision: `local:${deck.revision}`,
    session: { ...base.session, status: deck.status, voiceChannel: null, textChannel: null, current: deck.current, queue: deck.queue, hasPrevious: deck.history.length > 0,
      positionMs: deck.positionMs, durationMs: deck.durationMs, suggestions: [], volume: deck.volume, repeat: deck.repeat,
      radio: false, autoplay: 'off', fairQueue: false, listeners: [], canAdd: true, canControl: true, canVote: false, reason: null },
    savedSession: { ...base.savedSession, exists: false, canResume: false },
  }, [local, base, deck]);
  const can = useCallback((capability: Capability) => {
    if (!local) return remote.can(capability);
    if (capability === 'add' || capability === 'control') return !!remote.snapshot;
    return capability === 'vote' || capability === 'resume' ? false : remote.can(capability);
  }, [local, remote.can, remote.snapshot]);
  const moves = { target, discord, moveToDiscord, moveHere };
  if (!local) return { ...remote, ...moves };
  return { ...remote, snapshot, receivedAt: deck.at, can, pending, syncing: false, run: engine.run, ...moves,
    blockedReason: remote.snapshot ? remote.blockedReason : 'Connecting to your server. Search and your library load from Discord.' };
}
