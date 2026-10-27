// Room taste (ADR-0012). Autoplay takes turns between the listeners in the
// bot's voice channel, seeding each pick from one present listener's own
// requests and favorites. Everything is read when a pick is made and nothing
// about who was present is stored: leaving the channel, opting out or clearing
// request stats takes effect on the next pick.
import { PermissionFlagsBits } from 'discord.js';
import { songIdentity, songKey } from './song-identity.js';

const DAY = 24 * 60 * 60_000;
export const ROOM_TASTE_LIMITS = Object.freeze({
  listeners: 10, topTracks: 10, favorites: 10, artists: 10, skips: 50,
  windowMs: 90 * DAY, skipWindowMs: 30 * DAY,
});

const deafened = member => Boolean(member.voice?.selfDeaf || member.voice?.serverDeaf || member.voice?.deaf);

/**
 * Listeners whose taste shapes autoplay right now: people in the channel who
 * can hear it and have not opted out, in channel order.
 * @param {object} library MusicLibrary (or anything with tasteInAutoplay)
 * @param {object[]} members non-bot members in the bot's voice channel
 */
export function tasteListeners(library, members) {
  return members.filter(member => {
    const id = member.user?.id ?? member.id;
    if (!/^\d{1,22}$/.test(String(id || '')) || deafened(member)) return false;
    try { return library?.tasteInAutoplay?.(id) === true; } catch { return false; }
  }).slice(0, ROOM_TASTE_LIMITS.listeners);
}

/**
 * Voice channels whose plays may shape the room: ones every person present can
 * see, so a pick never draws on a channel hidden from someone hearing it.
 */
export function sharedChannelIds(stats, guild, members) {
  if (!members.length) return [];
  return (stats?.voiceChannelIds?.(guild?.id) || []).filter(id => {
    const channel = guild?.channels?.cache?.get(id);
    return Boolean(channel) && members.every(member => channel.permissionsFor?.(member)?.has(PermissionFlagsBits.ViewChannel));
  });
}

function profile(client, guildId, member, channelIds, now) {
  const id = member.user?.id ?? member.id;
  const scope = { since: now - ROOM_TASTE_LIMITS.windowMs, visibleChannelIds: channelIds };
  const top = channelIds.length ? client.stats.topTracks(guildId, id, { ...scope, limit: ROOM_TASTE_LIMITS.topTracks }).map(entry => entry.track) : [];
  const artists = channelIds.length ? client.stats.topArtists(guildId, id, { ...scope, limit: ROOM_TASTE_LIMITS.artists }).map(artist => artist.artistKey) : [];
  const skipped = channelIds.length ? client.stats.earlySkips(guildId, id, { since: now - ROOM_TASTE_LIMITS.skipWindowMs, visibleChannelIds: channelIds, limit: ROOM_TASTE_LIMITS.skips }) : [];
  // Newest favorites first: what someone saved lately says most about them now.
  const favorites = client.library.favorites(id).slice(-ROOM_TASTE_LIMITS.favorites).reverse();
  const seeds = []; const seen = new Set();
  for (let index = 0; index < Math.max(top.length, favorites.length); index++) {
    for (const reference of [top[index], favorites[index]]) {
      const key = reference && songKey(reference);
      if (!key || seen.has(key)) continue;
      seen.add(key); seeds.push(reference);
    }
  }
  const artistKeys = new Set(artists);
  for (const reference of favorites) artistKeys.add(songIdentity(reference).artistKey);
  return { id, seeds, artists: artistKeys, skipped: new Set(skipped) };
}

/**
 * The room's taste for one pick. Returns no listeners when stats are
 * unavailable; a listener whose reads fail is left out, never the whole room.
 * @returns {{ listeners: { id: string, seeds: object[], artists: Set<string>, skipped: Set<string> }[], songs: Map<string, number>, artists: Map<string, number> }}
 */
export function readRoomTaste(client, guild, members, now = Date.now()) {
  const room = { listeners: [], songs: new Map(), artists: new Map() };
  const listeners = tasteListeners(client?.library, members);
  if (!listeners.length || !client.stats?.available) return room;
  let channelIds;
  try { channelIds = sharedChannelIds(client.stats, guild, members); } catch { return room; }
  for (const member of listeners) {
    let taste;
    try { taste = profile(client, guild.id, member, channelIds, now); } catch { continue; }
    if (!taste.seeds.length) continue;
    room.listeners.push(taste);
    for (const reference of taste.seeds) { const key = songKey(reference); room.songs.set(key, (room.songs.get(key) || 0) + 1); }
    for (const key of taste.artists) room.artists.set(key, (room.artists.get(key) || 0) + 1);
  }
  return room;
}

/**
 * Whose turn it is: the fewest picks so far, then the longest wait. Someone new
 * to the session starts level with the least-served listener present and goes
 * next, so a late arrival is heard soon without taking every following pick.
 * @param {Map<string, { picks: number, at: number }>} turns per-session state
 */
export function nextListener(room, turns) {
  if (!room.listeners.length) return null;
  const known = room.listeners.filter(listener => turns.has(listener.id)).map(listener => turns.get(listener.id).picks);
  const floor = known.length ? Math.min(...known) : 0;
  for (const listener of room.listeners) if (!turns.has(listener.id)) turns.set(listener.id, { picks: floor, at: -Infinity });
  while (turns.size > 50) turns.delete(turns.keys().next().value);
  const entry = listener => turns.get(listener.id);
  return [...room.listeners].sort((a, b) => entry(a).picks - entry(b).picks || entry(a).at - entry(b).at)[0];
}

export function recordTurn(turns, listenerId, now) {
  if (!listenerId) return;
  const previous = turns.get(listenerId);
  turns.delete(listenerId);
  turns.set(listenerId, { picks: (previous?.picks || 0) + 1, at: now });
  while (turns.size > 50) turns.delete(turns.keys().next().value);
}

/** Songs more than one present listener plays or saved lead that listener's seeds. */
export function rankedSeeds(listener, room) {
  return listener.seeds.map((reference, index) => ({ reference, index, shared: room.songs.get(songKey(reference)) || 0 }))
    .sort((a, b) => b.shared - a.shared || a.index - b.index).map(item => item.reference);
}

/**
 * Candidates by an artist two or more present listeners like move up;
 * otherwise the related-track order (relevance) is kept.
 */
export function rankShared(candidates, room) {
  if (room.listeners.length < 2) return candidates;
  const shared = track => { const count = room.artists.get(songIdentity(track?.info || track).artistKey) || 0; return count >= 2 ? count : 0; };
  return candidates.map((track, index) => ({ track, index, shared: shared(track) }))
    .sort((a, b) => b.shared - a.shared || a.index - b.index).map(item => item.track);
}
