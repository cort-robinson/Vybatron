import type { GuildSnapshot, Library, Track } from './types';

// Suggestions are ranked locally from state the portal already holds, so an
// empty search box costs no catalog requests and sends nothing new anywhere.
export interface Suggestion { track: Track; reason: string }

const HALF_LIFE_MS = 3 * 24 * 60 * 60_000;
export const trackKey = (track: Track) => track.uri || track.id;
export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const artistName = (track: Track) => track.author.replace(/\s*-\s*Topic$/i, '').trim();
export const isLink = (value: string) => /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim());

function queued(session: GuildSnapshot['session'] | undefined) {
  return new Set([session?.current, ...(session?.queue || [])].filter((track): track is Track => !!track).map(trackKey));
}

export function suggestTracks(library: Library | null, session: GuildSnapshot['session'] | undefined, limit = 6): Suggestion[] {
  if (!library) return [];
  const skip = queued(session);
  const newest = Math.max(0, ...library.history.map(entry => entry.playedAt));
  const ranked = new Map<string, { track: Track; score: number; plays: number; favorite: boolean }>();
  const entry = (track: Track) => {
    const key = trackKey(track);
    let item = ranked.get(key);
    if (!item) ranked.set(key, item = { track, score: 0, plays: 0, favorite: false });
    return item;
  };
  // Every play counts, and recent plays count more; a favorite is a standing vote.
  for (const { track, playedAt } of library.history) {
    const item = entry(track); item.plays++;
    item.score += 1 + 0.5 ** (Math.max(0, newest - playedAt) / HALF_LIFE_MS);
  }
  for (const track of library.favorites) { const item = entry(track); if (!item.favorite) { item.favorite = true; item.score += 2; } }
  return [...ranked.entries()]
    .filter(([key, item]) => !skip.has(key) && !!item.track.uri)
    .sort(([, a], [, b]) => b.score - a.score)
    .slice(0, limit)
    .map(([, { track, plays, favorite }]) => ({
      track, reason: favorite ? 'Favorite' : plays > 1 ? `Played ${plays} times` : 'In your history',
    }));
}

export function suggestArtists(library: Library | null, session: GuildSnapshot['session'] | undefined, limit = 5): string[] {
  const weights = new Map<string, { name: string; weight: number }>();
  const add = (track: Track | null | undefined, weight: number) => {
    const name = track && artistName(track);
    if (!name || /^unknown artist$/i.test(name)) return;
    const key = normalize(name);
    const item = weights.get(key) || { name, weight: 0 };
    item.weight += weight; weights.set(key, item);
  };
  // The artist playing now leads; listening history and favorites fill the rest.
  add(session?.current, 1000);
  for (const { track } of library?.history || []) add(track, 1);
  for (const track of library?.favorites || []) add(track, 1.5);
  return [...weights.values()].sort((a, b) => b.weight - a.weight).slice(0, limit).map(item => item.name);
}

// Instant matches from the listener's own library while the catalog search runs.
export function libraryMatches(library: Library | null, query: string, limit = 3): Track[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!library || !terms.length) return [];
  const seen = new Set<string>(); const found: Track[] = [];
  const candidates = [...library.favorites, ...library.history.map(entry => entry.track), ...library.mixes.flatMap(mix => mix.tracks)];
  for (const track of candidates) {
    const key = trackKey(track);
    if (seen.has(key) || !track.uri) continue;
    seen.add(key);
    const text = normalize(`${track.title} ${track.author}`);
    if (terms.every(term => text.includes(term))) found.push(track);
    if (found.length >= limit) break;
  }
  return found;
}
