import { createHash } from 'node:crypto';
import { catalogUrl } from '../utils/library.js';
import { plainText } from '../utils/presentation.js';
import { fail } from './errors.js';

export function publicTrackId(track) {
  const info = track?.info || track || {};
  const source = plainText(info.sourceName, { fallback: 'unknown', maxLength: 40 });
  const identity = catalogUrl(info.uri) || `${source}:${plainText(info.identifier, { fallback: '', maxLength: 120 })}:${plainText(info.title)}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

// Fixed reference field order makes versions independent of object key order.
// Hash only existing persisted data: no library migration or version writes.
export function mixVersion(mix) {
  if (!mix) return null;
  const references = mix.tracks.map(track => [track.uri, track.sourceName, track.identifier, track.title, track.author, track.duration, track.isStream]);
  return createHash('sha256').update(JSON.stringify([mix.ownerId, references, mix.savedAt ?? null])).digest('hex').slice(0, 32);
}

export function assertFavoriteSelection(track, expectedId) {
  if (!track || publicTrackId(track) !== expectedId) fail(409, 'favorite_changed', 'Your favorites changed. Refresh your library before trying again.');
}

export function assertHistorySelection(item, expectedId) {
  if (!item || item.id !== expectedId) fail(409, 'history_changed', 'Your visible history changed. Refresh your library before replaying.');
}

export function assertMixSelection(mix, expectedVersion) {
  if (!mix || mixVersion(mix) !== expectedVersion) fail(409, 'mix_changed', 'That mix changed. Refresh your library before deleting it.');
}
