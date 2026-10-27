import { plainText } from './presentation.js';
import { songKey } from './song-identity.js';
import { withTimeout, enqueueTracks } from './enqueue.js';
import { acquirePlaybackRequest } from './maintenance.js';
import { setNotice } from './player-controller.js';
import { AUTOPLAY_MODES } from './library.js';
import { nextListener, rankedSeeds, rankShared, readRoomTaste, recordTurn } from './room-taste.js';

export { AUTOPLAY_MODES };

// Smart autoplay (ADR-0008). Recommendations come from YouTube's related-track
// mix for a recently played seed. Picks wait in a small per-session suggestion
// buffer, never in player.queue, so anything a person queues always plays first.
// All state is in memory and ends with the player. Picks take turns between
// the listeners present, seeded from each one's own taste (ADR-0012).
export const AUTOPLAY_LIMITS = Object.freeze({
  suggestions: 3, seedPool: 4, minDurationMs: 30_000, maxDurationMs: 15 * 60_000,
  recentServerMs: 24 * 60 * 60_000, excluded: 300, failures: 3, mixCache: 8, mixCacheMs: 30 * 60_000,
  // Suggestions are prepared only once the human queue is nearly done, so the
  // seeds reflect what is actually playing when a pick is needed.
  refillBelow: 3, retiredSeedPenalty: 2,
});

const states = new WeakMap();

function stateFor(player) {
  let state = states.get(player);
  if (!state) {
    state = { override: null, generation: 0, pending: null, failures: 0, suspended: false, anchor: null, anchorUses: 0, cursor: 0,
      filling: false, suggestions: [], excluded: new Set(), penalties: new Map(), origins: new Map(), mixes: new Map(), resolved: new Map(), lastArtist: null,
      turns: new Map(), tasteCursor: new Map() };
    states.set(player, state);
  }
  return state;
}

function bounded(set, limit) { while (set.size > limit) set.delete(set.values().next().value); }
function info(track) { return track?.info || track || {}; }

export function autoplayMode(client, guildId) {
  const mode = client?.library?.settings?.(guildId)?.autoplay;
  return AUTOPLAY_MODES.includes(mode) ? mode : 'off';
}

// The /radio override wins for this session; otherwise the server setting applies.
export function autoplayActive(client, player) {
  if (!player) return false;
  const state = states.get(player);
  if (state?.suspended) return false;
  if (state?.override !== null && state?.override !== undefined) return state.override;
  return autoplayMode(client, player.guildId) !== 'off';
}

export function radioState(player) {
  const state = states.get(player);
  return { enabled: state?.override === true && !state.suspended, override: state?.override ?? null, failures: state?.failures || 0, suspended: Boolean(state?.suspended) };
}

export function suggestions(player) { return [...(states.get(player)?.suggestions || [])].map(entry => entry.track); }

// Stable public source key plus light near-duplicate keys. Official videos,
// Topic uploads, and lyric videos of one recording should collapse together.
export function sourceKey(track) {
  const value = info(track);
  return `${String(value.sourceName || '').toLowerCase()}:${String(value.identifier || value.uri || '')}`;
}
const NOISE = /[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|remaster(?:ed)?|hd|hq|4k|explicit|clean|m\/?v|color coded|full version)\b[^)\]]*)[)\]]/gi;
function compact(value) {
  return String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, 'and').replace(/\b(?:feat|ft|featuring)\b\.?.*$/, '').replace(/[^a-z0-9]+/g, '');
}
export function nearKeys(track) {
  const value = info(track);
  const title = String(value.title || '').replace(NOISE, ' ').replace(/\s[-–—|]\s*(?:official|lyrics?|audio|video|remaster(?:ed)?)\b.*$/i, '');
  const artist = String(value.author || '').replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, '');
  const keys = new Set([compact(artist) + compact(title)]);
  // "Artist - Title" uploads from channels whose name differs from the artist.
  if (/\s[-–—]\s/.test(title)) keys.add(compact(title));
  // The play-stats song identity (ADR-0006) also folds credit lists to the lead artist.
  keys.add(`song:${songKey(value)}`);
  return [...keys].filter(key => key.length > 2);
}

export function radioArtist(track) {
  return plainText(info(track).author, { fallback: '', maxLength: 100 }).replace(/\s*-\s*Topic$/i, '').trim();
}

function eligible(track) {
  const value = info(track);
  return !value.isStream && Number.isFinite(value.duration) && value.duration >= AUTOPLAY_LIMITS.minDurationMs && value.duration <= AUTOPLAY_LIMITS.maxDurationMs;
}

// Recently played music in this server: library history plus this session.
function recentServerTracks(client, guildId, now) {
  try {
    return client.library?.readGuild?.(guildId)?.history?.filter(item => now - item.playedAt <= AUTOPLAY_LIMITS.recentServerMs).map(item => item.track) || [];
  } catch { return []; }
}

function avoidance(player, client, state, now = Date.now()) {
  const keys = new Set(state.excluded); const near = new Set();
  const tracks = [player.queue.current, ...(player.queue.tracks || []), ...(player.queue.previous || []), ...state.suggestions.map(entry => entry.track),
    ...recentServerTracks(client, player.guildId, now)].filter(Boolean);
  for (const track of tracks) { keys.add(sourceKey(track)); for (const key of nearKeys(track)) near.add(key); }
  for (const key of state.excluded) if (key.startsWith('near:')) near.add(key.slice(5));
  return { keys, near };
}

export function fresh(track, avoid) {
  return eligible(track) && !avoid.keys.has(sourceKey(track)) && !nearKeys(track).some(key => avoid.near.has(key));
}

// Seeds rotate across the last few played tracks so the station drifts with
// the room. A disliked seed sinks to the back and is retired after two strikes.
export function chooseSeeds(player, state) {
  const pool = []; const seen = new Set();
  const add = track => {
    const key = track && sourceKey(track);
    if (!key || seen.has(key) || state.excluded.has(key) || (state.penalties.get(key) || 0) >= AUTOPLAY_LIMITS.retiredSeedPenalty) return;
    seen.add(key); pool.push(track);
  };
  for (const track of [player.queue.current, ...(player.queue.previous || [])]) {
    if (pool.length >= AUTOPLAY_LIMITS.seedPool) break;
    add(track);
  }
  const rotated = pool.length ? [...pool.slice(state.cursor % pool.length), ...pool.slice(0, state.cursor % pool.length)] : [];
  rotated.sort((a, b) => (state.penalties.get(sourceKey(a)) || 0) - (state.penalties.get(sourceKey(b)) || 0));
  // A chosen "start radio" track leads the first few picks before rotation.
  if (state.anchor && state.anchorUses < 2 && !state.excluded.has(sourceKey(state.anchor))) return [state.anchor, ...rotated.filter(track => sourceKey(track) !== sourceKey(state.anchor))];
  return rotated;
}

export function mixUrl(videoId) { return `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`; }

async function youtubeId(player, client, seed, state, timeoutMs) {
  const value = info(seed);
  if (value.sourceName === 'youtube' && /^[\w-]{11}$/.test(value.identifier || '')) return value.identifier;
  const key = sourceKey(seed);
  if (state.resolved.has(key)) return state.resolved.get(key);
  const artist = radioArtist(seed); const title = plainText(value.title, { fallback: '', maxLength: 120 });
  if (!title) return null;
  const response = await withTimeout(player.search({ query: `${artist} ${title}`.trim(), source: 'ytmsearch' }, client.user), timeoutMs);
  const id = response?.tracks?.find(track => info(track).sourceName === 'youtube' && /^[\w-]{11}$/.test(info(track).identifier || ''))?.info.identifier || null;
  state.resolved.set(key, id); bounded(state.resolved, 50);
  return id;
}

async function mixTracks(player, client, seed, state, timeoutMs, now) {
  const key = sourceKey(seed);
  const cached = state.mixes.get(key);
  if (cached && now - cached.at < AUTOPLAY_LIMITS.mixCacheMs) return cached.tracks;
  const id = await youtubeId(player, client, seed, state, timeoutMs);
  if (!id) return [];
  const response = await withTimeout(player.search({ query: mixUrl(id) }, client.user), timeoutMs);
  // A mix opens with its own seed, which may be the YouTube copy of a non-YouTube seed.
  const tracks = response?.loadType === 'error' ? [] : (response?.tracks || []).filter(track => info(track).identifier !== id);
  state.mixes.delete(key); state.mixes.set(key, { at: now, tracks });
  while (state.mixes.size > AUTOPLAY_LIMITS.mixCache) state.mixes.delete(state.mixes.keys().next().value);
  return tracks;
}

// Mix order is relevance. Choose among the leading fresh results, preferring a
// different artist from the previous pick so the station does not stall.
function pick(candidates, state, random) {
  const top = candidates.slice(0, 4);
  const varied = top.filter(track => compact(radioArtist(track)) !== state.lastArtist);
  const choices = varied.length ? varied : top;
  return choices[Math.min(choices.length - 1, Math.max(0, Math.floor(random() * choices.length)))];
}

const EMPTY_ROOM = Object.freeze({ listeners: [], songs: new Map(), artists: new Map() });
function roomTaste(client, player, now) {
  try { return readRoomTaste(client, client.guilds?.cache?.get(player.guildId), presentMembers(client, player), now); } catch { return EMPTY_ROOM; }
}

// One present listener's next seed: songs others in the room share come
// first, and each listener's seeds rotate so their picks do not repeat.
function tasteSeed(listener, room, state) {
  const usable = rankedSeeds(listener, room).filter(seed => !state.excluded.has(sourceKey(seed))
    && (state.penalties.get(sourceKey(seed)) || 0) < AUTOPLAY_LIMITS.retiredSeedPenalty);
  if (!usable.length) return null;
  usable.sort((a, b) => (state.penalties.get(sourceKey(a)) || 0) - (state.penalties.get(sourceKey(b)) || 0));
  const cursor = state.tasteCursor.get(listener.id) || 0;
  state.tasteCursor.delete(listener.id); state.tasteCursor.set(listener.id, cursor + 1);
  while (state.tasteCursor.size > 50) state.tasteCursor.delete(state.tasteCursor.keys().next().value);
  return usable[cursor % usable.length];
}

// Picks prepared for someone who left, deafened or opted out are dropped. Someone
// new to the session takes the next pick instead of waiting behind the buffer.
function pruneForRoom(state, room) {
  const present = new Set(room.listeners.map(listener => listener.id));
  state.suggestions = state.suggestions.filter(entry => !entry.for || present.has(entry.for));
  if (room.listeners.some(listener => !state.turns.has(listener.id))) state.suggestions = [];
}

async function discover(player, client, state, { timeoutMs, random, now }) {
  const avoid = avoidance(player, client, state, now);
  const room = roomTaste(client, player, now);
  // A present listener's early skips stay out while they are in the room.
  for (const listener of room.listeners) for (const key of listener.skipped) avoid.near.add(`song:${key}`);
  const listener = nextListener(room, state.turns);
  const personal = listener && tasteSeed(listener, room, state);
  const recent = chooseSeeds(player, state);
  // A chosen "start radio" song still leads; the listener whose turn it is comes next.
  const leading = state.anchor && state.anchorUses < 2 && recent[0] && sourceKey(recent[0]) === sourceKey(state.anchor) ? 1 : 0;
  const seeds = (personal ? [...recent.slice(0, leading), personal, ...recent.slice(leading).filter(track => sourceKey(track) !== sourceKey(personal))] : recent).slice(0, 2);
  state.cursor++;
  const forListener = seed => personal && sourceKey(seed) === sourceKey(personal) ? listener.id : null;
  for (const seed of seeds) {
    let candidates = [];
    try { candidates = rankShared((await mixTracks(player, client, seed, state, timeoutMs, now)).filter(track => fresh(track, avoid)), room); } catch {}
    if (candidates.length) return { track: pick(candidates, state, random), origin: sourceKey(seed), seed, from: 'mix', listenerId: forListener(seed) };
  }
  // Mix loading unavailable: the original same-artist search keeps the room going.
  const seed = seeds[0];
  const artist = radioArtist(seed);
  if (!artist) throw new Error('No autoplay seed.');
  const response = await withTimeout(player.search({ query: `${artist} music`, source: 'ytmsearch' }, client.user), timeoutMs);
  const candidates = (response?.tracks || []).filter(track => fresh(track, avoid));
  if (!candidates.length) throw new Error('No fresh autoplay results.');
  return { track: candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))], origin: sourceKey(seed), seed, from: 'artist', listenerId: forListener(seed) };
}

function presentMembers(client, player) {
  const channel = client.guilds?.cache?.get(player.guildId)?.channels?.cache?.get(player.voiceChannelId);
  return channel?.members ? [...channel.members.values()].filter(member => !member.user?.bot) : [];
}
// "listening" mode keeps going only while someone in voice can hear it.
function audiencePresent(client, player, state) {
  const people = presentMembers(client, player);
  if (state.override !== true && autoplayMode(client, player.guildId) === 'listening') {
    return people.some(member => !(member.voice?.selfDeaf || member.voice?.serverDeaf || member.voice?.deaf));
  }
  return people.length > 0;
}

function current(player, client) { return client.lavalink?.getPlayer?.(player.guildId) === player; }

function recordFailure(player, state) {
  state.failures++;
  // Bounded: no timer retries a failed source. Three consecutive misses pause
  // autoplay for this session; /radio on or a new setting starts it again.
  if (state.failures >= AUTOPLAY_LIMITS.failures) { state.suspended = true; state.suggestions = []; }
}

// Prepare suggestions while the human queue is nearly done. Single flight per
// session, one maintenance lease, and every await rechecks session identity.
export async function refreshSuggestions(player, client, { timeoutMs = 8000, random = Math.random, now = Date.now } = {}) {
  if (!autoplayActive(client, player)) return false;
  const state = stateFor(player);
  if (state.pending) return state.pending;
  if (state.filling) return false;
  if ((player.queue.tracks?.length || 0) >= AUTOPLAY_LIMITS.refillBelow
    || player.getData?.('vybertron.stopping') === true || !audiencePresent(client, player, state)) return false;
  pruneForRoom(state, roomTaste(client, player, now()));
  if (state.suggestions.length >= AUTOPLAY_LIMITS.suggestions) return false;
  const release = acquirePlaybackRequest(client);
  if (!release) return false;
  const generation = state.generation;
  state.pending = (async () => {
    let added = false;
    try {
      for (let attempt = 0; attempt < AUTOPLAY_LIMITS.suggestions + 2 && state.suggestions.length < AUTOPLAY_LIMITS.suggestions; attempt++) {
        const choice = await discover(player, client, state, { timeoutMs, random, now: now() });
        if (state.generation !== generation || !current(player, client) || !autoplayActive(client, player)) return added;
        if (!fresh(choice.track, avoidance(player, client, state, now()))) continue;
        state.suggestions.push({ track: { ...choice.track, requester: client.user }, origin: choice.origin, for: choice.listenerId });
        recordTurn(state.turns, choice.listenerId, now());
        state.lastArtist = compact(radioArtist(choice.track)); state.failures = 0; added = true;
        if (state.anchor && sourceKey(choice.seed) === sourceKey(state.anchor)) state.anchorUses++;
      }
      return added;
    } catch {
      if (state.generation === generation && !added) recordFailure(player, state);
      return added;
    } finally { state.pending = null; release(); }
  })();
  return state.pending;
}

// Every autoplay pick is requested by the bot user. Play statistics rely on that
// to tell autoplay plays from songs people chose, so a promoted pick keeps it too.
async function queuePick(player, client, entry, state, options) {
  await enqueueTracks(client, player, [{ ...entry.track, requester: client.user }], options);
  state.origins.set(sourceKey(entry.track), entry.origin); bounded(state.origins, 100);
}

async function insert(player, client, entry, state) {
  await queuePick(player, client, entry, state, { fair: false });
  setNotice(player.guildId, 'Autoplay is keeping the music going. Songs people queue always play first.');
}

// Called by the SDK only after the human queue has run out.
export async function fillRadioQueue(player, lastTrack, client, { timeoutMs = 8000, random = Math.random, now = Date.now } = {}) {
  if (!autoplayActive(client, player) || player.queue.current || player.queue.tracks.length) return false;
  const state = stateFor(player);
  if (state.filling || !audiencePresent(client, player, state)) return false;
  state.filling = true;
  try { return await fill(player, client, state, { timeoutMs, random, now }); } finally { state.filling = false; }
}

async function fill(player, client, state, { timeoutMs, random, now }) {
  if (state.pending) await state.pending.catch(() => {});
  const generation = state.generation;
  pruneForRoom(state, roomTaste(client, player, now()));
  let entry = null;
  while (state.suggestions.length && !entry) {
    const next = state.suggestions.shift();
    if (fresh(next.track, avoidance(player, client, state, now()))) entry = next;
  }
  if (!entry) {
    const release = acquirePlaybackRequest(client);
    if (!release) return false;
    try {
      const choice = await discover(player, client, state, { timeoutMs, random, now: now() });
      entry = { track: choice.track, origin: choice.origin, for: choice.listenerId };
      recordTurn(state.turns, choice.listenerId, now());
      state.lastArtist = compact(radioArtist(choice.track));
      if (state.anchor && sourceKey(choice.seed) === sourceKey(state.anchor)) state.anchorUses++;
    } catch {
      if (state.generation === generation) recordFailure(player, state);
      setNotice(player.guildId, state.suspended ? 'Autoplay paused after several empty lookups. Add music with /play, or use /radio on to try again.'
        : 'Autoplay could not find a fresh playable song. Add music with /play.');
      return false;
    } finally { release(); }
  }
  if (state.generation !== generation || !current(player, client) || !autoplayActive(client, player) || player.queue.current || player.queue.tracks.length
    || !audiencePresent(client, player, state)) return false;
  await insert(player, client, entry, state);
  state.failures = 0;
  void refreshSuggestions(player, client, { timeoutMs, random, now }).catch(() => {});
  return true;
}

// Skip with an empty human queue: move the next prepared pick in without a lookup.
export async function queueNextSuggestion(player, client) {
  const state = states.get(player);
  if (!client || !state || !autoplayActive(client, player) || player.queue.tracks.length) return false;
  pruneForRoom(state, roomTaste(client, player, Date.now()));
  const entry = state.suggestions.shift();
  if (!entry) return false;
  await insert(player, client, entry, state);
  return true;
}

export function setRadio(player, enabled, seed = null) {
  const state = stateFor(player);
  state.generation++;
  state.override = enabled === null ? null : Boolean(enabled);
  state.failures = 0; state.suspended = false; state.suggestions = [];
  if (enabled && seed) { state.anchor = seed; state.anchorUses = 0; state.excluded.delete(sourceKey(seed)); state.penalties.delete(sourceKey(seed)); }
  if (!enabled) { state.anchor = null; state.anchorUses = 0; }
  return state;
}

// A changed server setting re-arms a suspended session and drops stale picks.
export function resetAutoplay(player) {
  const state = states.get(player);
  if (!state) return;
  state.generation++; state.failures = 0; state.suspended = false; state.suggestions = [];
}

function exclude(state, track) {
  state.excluded.add(sourceKey(track));
  for (const key of nearKeys(track)) state.excluded.add(`near:${key}`);
  bounded(state.excluded, AUTOPLAY_LIMITS.excluded);
}

// "Less like this": exclude the song for the session and push its seed down.
export function lessLikeThis(player, track, origin = null) {
  const state = stateFor(player);
  const key = sourceKey(track);
  const seed = origin || state.origins.get(key);
  exclude(state, track);
  state.penalties.set(key, AUTOPLAY_LIMITS.retiredSeedPenalty);
  if (seed) state.penalties.set(seed, (state.penalties.get(seed) || 0) + 1);
  if (state.anchor && seed === sourceKey(state.anchor)) state.anchorUses = 2;
  // Drop prepared picks from the same seed; they would repeat the miss.
  if (seed) state.suggestions = state.suggestions.filter(entry => entry.origin !== seed);
  bounded(state.penalties, 100);
}

export function isAutoplayTrack(player, track) { return Boolean(track && states.get(player)?.origins.has(sourceKey(track))); }

// A listener skipping an autoplay pick is the same signal as a thumbs-down.
export function noteSkip(player, track) { if (isAutoplayTrack(player, track)) lessLikeThis(player, track); }

// "Add to queue" on a suggestion: it joins the real queue (and plays before any
// later autoplay pick) but stays an autoplay pick, still eligible for "less like this".
export async function promoteSuggestion(player, client, entry) {
  await queuePick(player, client, entry, stateFor(player), {});
}

export function takeSuggestion(player, index, expected = () => true) {
  const state = states.get(player);
  const entry = state?.suggestions[index];
  if (!entry || !expected(entry.track)) return null;
  state.suggestions.splice(index, 1);
  return entry;
}

export function dismissSuggestion(player, index, { dislike = false, expected } = {}) {
  const entry = takeSuggestion(player, index, expected);
  if (!entry) return null;
  if (dislike) lessLikeThis(player, entry.track, entry.origin);
  else exclude(states.get(player), entry.track);
  return entry.track;
}
