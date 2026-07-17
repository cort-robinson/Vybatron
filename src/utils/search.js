import { safeText } from './presentation.js';

export function searchFailureMessage(result, query) {
  const safeQuery = safeText(query, { maxLength: 120 });
  if (result?.loadType === 'error') {
    return `Couldn’t load “${safeQuery}”. Try another result or paste a direct YouTube, Spotify, or SoundCloud link.`;
  }
  return `No matches for “${safeQuery}”. Try a title and artist, or paste a supported link.`;
}
