import type { Command, GuildSnapshot, Track } from './types';

// Playback controls that apply to the screen immediately. The bot remains the
// authority: each intent is sent in order, checked against the latest verified
// state before it leaves the browser, and rolled back if it is rejected.
export const OPTIMISTIC = new Set(['pause', 'resume', 'seek', 'volume', 'filter', 'loop', 'radio', 'skip', 'skipto', 'remove', 'move', 'clear', 'shuffle']);
// Set-state controls are idempotent: they carry no revision, coalesce by slot
// and keep applying until settled, whatever else changes meanwhile.
const SLOTS: Record<string, string> = { pause: 'playback', resume: 'playback', volume: 'volume', filter: 'filter', loop: 'loop', radio: 'radio' };
// Queue/position edits are only meaningful against the tracks the user saw.
const STRUCTURAL = new Set(['seek', 'skip', 'skipto', 'remove', 'move', 'clear', 'shuffle', 'playnext']);

export interface Intent {
  id: number;
  command: Command;
  slot: string | null;
  // Track identities the user acted on, compared with verified state before send.
  expects: { current: string | null; queue: string[] } | null;
  // Verified revision the prediction was built on; structural predictions stop
  // applying as soon as newer verified state arrives.
  baseRevision: string;
  // Position anchor for pause/resume/seek/skip predictions.
  anchor: { positionMs: number; at: number; trackId: string | null } | null;
  sent: boolean;
  createdAt: number;
  // A song added from a result the user chose, shown in the queue until the bot confirms it.
  track?: Track;
}

// Suggestion edits name their pick by id (the bot checks it), so they apply at
// once whatever else changes and need no queue revision.
const SUGGESTION_EDITS = new Set(['promote', 'remove', 'less']);
const suggestionEdit = (command: Command) => command.command === 'radio' && SUGGESTION_EDITS.has(command.subcommand || '')
  && !!command.expectedTrackId && command.options?.position !== undefined;

// Only the plain autoplay toggle is a set-state control. Seeding from a chosen
// song and editing suggestions are ordinary requests that wait for the bot.
const radioToggle = (command: Command) => command.subcommand === 'off' || (command.subcommand === 'on' && !command.options?.track);
export const isOptimistic = (command: Command) => OPTIMISTIC.has(command.command) && (command.command !== 'radio' || radioToggle(command) || suggestionEdit(command));
export const slotOf = (command: Command) => isOptimistic(command) && !suggestionEdit(command) ? SLOTS[command.command] || null : null;
export const needsRevision = (command: Command) => STRUCTURAL.has(command.command);
// Adding one chosen song doesn't depend on what the queue shows, so it doesn't
// wait for earlier changes or lock the next addition. Play next with a chosen
// song is shown at the front at once, but still binds to the queue the user saw.
export const isAddition = (command: Command, tracks?: Track[]) => ['play', 'playnext'].includes(command.command) && !command.subcommand
  && tracks?.length === 1 && !!tracks[0].uri && command.options?.query === tracks[0].uri;
const identities = (snapshot: GuildSnapshot) => ({ current: snapshot.session.current?.id || null, queue: snapshot.session.queue.map(track => track.id) });
const sameTracks = (a: { current: string | null; queue: string[] }, b: { current: string | null; queue: string[] }) =>
  a.current === b.current && a.queue.length === b.queue.length && a.queue.every((id, index) => id === b.queue[index]);

export function displayedPosition(snapshot: GuildSnapshot, receivedAt: number, now: number) {
  const session = snapshot.session; const duration = session.durationMs || session.current?.durationMs || 0;
  const elapsed = session.status === 'playing' && !session.starting ? Math.max(0, now - receivedAt) : 0;
  return Math.max(0, Math.min(duration || Infinity, session.positionMs + elapsed));
}

function seconds(timestamp: unknown) {
  const parts = String(timestamp ?? '').split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !Number.isInteger(part) || part < 0)) return null;
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000;
}

// Build an intent from the state the user is looking at (including earlier
// predictions). Returns null when the action is a no-op on that state.
export function createIntent(id: number, body: Command, view: GuildSnapshot, verified: GuildSnapshot, receivedAt: number, now: number, track?: Track): Intent | null {
  const { expectedRevision: _ignored, ...command } = body;
  const session = view.session; const options = command.options || {};
  const slot = slotOf(command);
  if (command.command === 'pause' && session.status !== 'playing') return null;
  if (command.command === 'resume' && session.status !== 'paused') return null;
  if (command.command === 'volume' && session.volume === options.level) return null;
  if (command.command === 'filter' && session.filter === options.preset) return null;
  if (command.command === 'loop' && session.repeat === options.mode) return null;
  if (command.command === 'radio' && !suggestionEdit(command) && session.radio === (command.subcommand === 'on')) return null;
  const position = displayedPosition(view, receivedAt, now);
  const target = command.command === 'seek' ? seconds(options.timestamp) : null;
  const anchor = command.command === 'pause' || command.command === 'resume' ? { positionMs: position, at: now, trackId: session.current?.id || null }
    : command.command === 'seek' && target !== null ? { positionMs: target, at: now, trackId: session.current?.id || null }
    : command.command === 'skip' || command.command === 'skipto' ? { positionMs: 0, at: now, trackId: null } : null;
  return { id, command, slot, expects: STRUCTURAL.has(command.command) ? identities(view) : null,
    baseRevision: verified.revision, anchor, sent: false, createdAt: now, ...(track && { track }) };
}

function predict(intent: Intent, snapshot: GuildSnapshot): GuildSnapshot | null {
  const { command } = intent; const o = command.options || {};
  const next: GuildSnapshot = { ...snapshot, session: { ...snapshot.session, queue: [...snapshot.session.queue] } };
  const s = next.session;
  switch (command.command) {
    case 'pause': case 'resume':
      if (!s.current || !['playing', 'paused'].includes(s.status)) return null;
      s.status = command.command === 'pause' ? 'paused' : 'playing';
      break;
    case 'volume': s.volume = Number(o.level); break;
    case 'filter': s.filter = String(o.preset); break;
    case 'loop': s.repeat = o.mode as typeof s.repeat; break;
    case 'seek': if (!s.current || !intent.anchor) return null; break;
    case 'skip': case 'skipto': {
      // Repeating one song and an empty queue depend on server-side policy.
      const index = command.command === 'skip' ? 1 : Number(o.position);
      if (s.repeat === 'track' || !s.current || index < 1 || index > s.queue.length) return null;
      const skipped = s.current;
      s.current = s.queue[index - 1]; s.queue = s.queue.slice(index);
      // Repeating the queue sends the song that was playing to its end; skipped-over songs leave.
      if (s.repeat === 'queue') s.queue.push(skipped);
      // The next song holds at its start until the bot says its audio is moving.
      s.durationMs = s.current.durationMs; s.starting = true;
      break;
    }
    case 'remove': {
      const index = Number(o.position) - 1;
      if (index < 0 || index >= s.queue.length) return null;
      s.queue.splice(index, 1); break;
    }
    case 'move': {
      const from = Number(o.from) - 1; const to = Number(o.to) - 1;
      if (from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length || from === to) return null;
      s.queue.splice(to, 0, s.queue.splice(from, 1)[0]); break;
    }
    case 'clear': s.queue = []; break;
    // An addition joins the end of the queue. A fair queue or an idle player
    // places it by server-side rules, so those wait for the bot.
    case 'play': if (!intent.track || !s.current || s.fairQueue) return null; s.queue.push(intent.track); break;
    case 'playnext': if (!intent.track || !s.current || s.fairQueue) return null; s.queue.unshift(intent.track); break;
    case 'radio': {
      if (!suggestionEdit(command)) { s.radio = command.subcommand === 'on'; break; }
      const suggestions = s.suggestions || [];
      const index = suggestions.findIndex(track => track.id === command.expectedTrackId);
      if (index < 0) return null;
      if (command.subcommand === 'promote') {
        // A promoted pick joins the end of the queue; a fair queue or an idle player places it by bot rules.
        if (!s.current || s.fairQueue) return null;
        s.queue.push(suggestions[index]);
      }
      s.suggestions = suggestions.filter((_, at) => at !== index);
      break;
    }
    default: return null; // Shuffle order is chosen by the bot.
  }
  return next;
}

// Layer outstanding intents over verified state. Revision and permissions
// always come from the verified snapshot; only playback fields are predicted.
export function applyIntents(verified: GuildSnapshot, receivedAt: number, intents: Intent[]) {
  let snapshot = verified; let anchor = receivedAt;
  for (const intent of intents) {
    // An unsent addition or suggestion edit can't be in newer verified state yet,
    // so it still applies. Once sent, a newer snapshot may already hold it.
    const unsent = (!!intent.track || suggestionEdit(intent.command)) && !intent.sent;
    if (!intent.slot && !unsent && intent.baseRevision !== verified.revision) continue;
    const next = predict(intent, snapshot);
    if (!next) continue;
    snapshot = next;
    // A position prediction only holds for the track it was made on.
    if (intent.anchor && (intent.anchor.trackId === null || intent.anchor.trackId === snapshot.session.current?.id)) {
      snapshot.session.positionMs = intent.anchor.positionMs; anchor = intent.anchor.at;
    }
  }
  return { snapshot, receivedAt: anchor };
}

// A structural intent may only be sent if verified state still shows the tracks
// the user acted on. Earlier intents from this device are settled by then.
export function stillTargets(intent: Intent, verified: GuildSnapshot) {
  return !intent.expects || sameTracks(intent.expects, identities(verified));
}
export { identities as trackIdentities, sameTracks };
