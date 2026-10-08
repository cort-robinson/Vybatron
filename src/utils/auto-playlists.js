// Personal auto-playlists. Computed on read from a listener's request stats and
// favorites, never stored: clearing request stats or a favorite takes effect on
// the next read, and no second copy of anyone's listening needs retention rules.
// "Your mix" is lightly randomized with a seed that only changes weekly.
import { STATS_WINDOWS } from './play-stats.js';
import { artistKeyOf, songIdentity, songKey } from './song-identity.js';

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;
// 1970-01-05 was a Monday, so weeks turn over at Monday 00:00 UTC.
const FIRST_MONDAY = 4 * DAY;

export const AUTO_PLAYLIST_LIMIT = 25;
export const ARTIST_MIX_COUNT = 3;
// Mixes look back further than the default top-tracks window so they change
// gradually rather than with every evening's requests.
export const MIX_WINDOW_MS = STATS_WINDOWS['90d'];
export const MIX_SHARES = Object.freeze({ top: 0.6, recommendations: 0.2 });
export const PLAYLIST_KINDS = Object.freeze(['mix', 'top', 'rediscover', 'artist']);

/** The UTC week containing `now`: its index and Monday-to-Monday bounds. */
export function weekOf(now) {
  const index = Math.floor((now - FIRST_MONDAY) / WEEK);
  const startsAt = FIRST_MONDAY + index * WEEK;
  return { index, startsAt, endsAt: startsAt + WEEK };
}

/** Deterministic value in [0, 1) for a seed and key (FNV-1a with a final avalanche). */
export function seededUnit(seed, key) {
  let hash = 0x811c9dc5;
  for (const character of `${seed}\u0000${key}`) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16; hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13; hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 2 ** 32;
}

export function mixSeed(userId, guildId, now) { return `${userId}:${guildId}:${weekOf(now).index}`; }

const keyOf = reference => songKey(reference);
function uniqueSongs(references, taken = new Set()) {
  const result = [];
  for (const reference of references) {
    const key = keyOf(reference);
    if (taken.has(key)) continue;
    taken.add(key); result.push(reference);
  }
  return result;
}

/**
 * Blend top requests with favorites. Each song's jitter depends only on the
 * weekly seed and its own key, so the picks and their order hold all week even
 * as the input lists shift, and turn over on Monday.
 *
 * `recommendations` is the extension point for related-track discovery (the
 * smart autoplay engine): pass catalog references ranked by the engine and up to
 * MIX_SHARES.recommendations of the mix is reserved for them.
 * @param {{ topTracks: object[], favorites: object[], recommendations?: object[], seed: string, limit?: number }} input
 *   references, topTracks most-requested first
 * @returns {object[]} references
 */
export function buildYourMix({ topTracks = [], favorites = [], recommendations = [], seed, limit = AUTO_PLAYLIST_LIMIT }) {
  const taken = new Set();
  const top = uniqueSongs(topTracks, taken)
    .map((reference, rank) => ({ reference, score: (0.7 + 0.6 * seededUnit(seed, `top:${keyOf(reference)}`)) / (1 + rank * 0.15) }))
    .sort((a, b) => b.score - a.score).map(item => item.reference);
  const saved = uniqueSongs(favorites, new Set(taken))
    .map(reference => ({ reference, score: seededUnit(seed, `favorite:${keyOf(reference)}`) }))
    .sort((a, b) => a.score - b.score).map(item => item.reference);
  const discovered = uniqueSongs(recommendations, new Set([...taken, ...saved.map(keyOf)]));

  const wantedRecommendations = Math.min(discovered.length, Math.floor(limit * MIX_SHARES.recommendations));
  const wantedTop = Math.min(top.length, Math.ceil((limit - wantedRecommendations) * MIX_SHARES.top));
  const picks = [...discovered.slice(0, wantedRecommendations), ...top.slice(0, wantedTop)];
  // Whatever one source cannot supply, the others fill.
  for (const pool of [saved, top.slice(wantedTop), discovered.slice(wantedRecommendations)]) {
    for (const reference of pool) { if (picks.length >= limit) break; picks.push(reference); }
  }
  return picks.slice(0, limit)
    .map(reference => ({ reference, order: seededUnit(seed, `order:${keyOf(reference)}`) }))
    .sort((a, b) => a.order - b.order).map(item => item.reference);
}

/**
 * One artist: the listener's own favorites by them, alternated with what the
 * server plays most by them, one entry per song.
 * @param {{ artistKey: string, favorites: object[], serverSongs: object[], limit?: number }} input references
 */
export function buildArtistMix({ artistKey, favorites = [], serverSongs = [], limit = AUTO_PLAYLIST_LIMIT }) {
  const mine = favorites.filter(reference => songIdentity(reference).artistKey === artistKey);
  const result = []; const taken = new Set();
  for (let index = 0; result.length < limit && (index < mine.length || index < serverSongs.length); index++) {
    for (const reference of [mine[index], serverSongs[index]]) {
      if (!reference || result.length >= limit) continue;
      const key = keyOf(reference);
      if (!taken.has(key)) { taken.add(key); result.push(reference); }
    }
  }
  return result;
}

/**
 * Every personal playlist for one listener in one server. Uses only their own
 * requests (plus anonymous server plays for artist mixes) in channels they can
 * currently see. Throws StatsUnavailableError when the store is unavailable.
 * @returns {{ id: string, kind: string, title: string, artist: string|null, tracks: object[], refreshesAt: number|null }[]}
 */
export function personalPlaylists(stats, { guildId, userId, favorites = [], visibleChannelIds = [], since = 0, now = Date.now(), recommendations = [] }) {
  const mixScope = { since: now - MIX_WINDOW_MS, visibleChannelIds };
  const topTracks = stats.topTracks(guildId, userId, { since, visibleChannelIds, limit: AUTO_PLAYLIST_LIMIT }).map(entry => entry.track);
  const mixTop = stats.topTracks(guildId, userId, { ...mixScope, limit: AUTO_PLAYLIST_LIMIT }).map(entry => entry.track);
  const artists = stats.topArtists(guildId, userId, { ...mixScope, limit: ARTIST_MIX_COUNT });
  const playlists = [
    { id: 'your-mix', kind: 'mix', title: 'Your mix', artist: null, refreshesAt: weekOf(now).endsAt,
      tracks: buildYourMix({ topTracks: mixTop, favorites, recommendations, seed: mixSeed(userId, guildId, now) }) },
    { id: 'top-tracks', kind: 'top', title: 'Your top tracks', artist: null, refreshesAt: null, tracks: topTracks },
    { id: 'rediscover', kind: 'rediscover', title: 'Rediscover', artist: null, refreshesAt: null,
      tracks: stats.rediscover(userId, favorites, { now, limit: AUTO_PLAYLIST_LIMIT }).map(item => item.track) },
  ];
  artists.forEach((artist, index) => {
    const tracks = buildArtistMix({ artistKey: artist.artistKey, favorites,
      serverSongs: stats.artistSongs(guildId, artist.artistKey, { ...mixScope, limit: AUTO_PLAYLIST_LIMIT }).map(entry => entry.track) });
    if (tracks.length) playlists.push({ id: `artist-${index + 1}`, kind: 'artist', title: `${artist.artist} mix`, artist: artist.artist, refreshesAt: null, tracks });
  });
  return playlists;
}

/**
 * One playlist by kind, for /mymix and the portal's Play/Shuffle. An artist
 * mix may name any artist; without a name it uses the listener's top artist.
 * @returns {{ title: string, tracks: object[] }|null} null when no artist matches
 */
export function personalPlaylist(stats, kind, { artist = null, ...scope }) {
  if (kind !== 'artist' || !artist) {
    const lists = personalPlaylists(stats, scope);
    if (kind === 'artist') return lists.find(list => list.id === 'artist-1') || null;
    return lists.find(list => list.kind === kind) || null;
  }
  const artistKey = artistKeyOf(artist);
  const tracks = buildArtistMix({ artistKey, favorites: scope.favorites || [],
    serverSongs: stats.artistSongs(scope.guildId, artistKey, { since: (scope.now ?? Date.now()) - MIX_WINDOW_MS, visibleChannelIds: scope.visibleChannelIds || [], limit: AUTO_PLAYLIST_LIMIT }).map(entry => entry.track) });
  if (!tracks.length) return null;
  return { title: `${String(artist).trim().slice(0, 100)} mix`, tracks };
}
