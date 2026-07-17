import { isUrl, safeText } from './presentation.js';
import { resolveAutocompleteTrack } from './autocomplete.js';

export async function resolveTrackQuery(player, query, user) {
  const selection = resolveAutocompleteTrack(query, String(user?.id || 'unknown'));
  if (selection.isAutocomplete) {
    if (!selection.track) return { expired: true, result: null };
    return {
      expired: false,
      result: { loadType: 'track', tracks: [selection.track] },
    };
  }
  return {
    expired: false,
    result: await player.search({ query }, user),
  };
}

export function searchFailureMessage(result, query) {
  const safeQuery = safeText(query, { maxLength: 120 });
  if (result?.loadType === 'error') {
    if (isUrl(query)) {
      return 'Couldn’t load that link. Try another result or paste a different YouTube, Spotify, or SoundCloud link.';
    }
    return `Couldn’t load “${safeQuery}”. Try another result or paste a direct YouTube, Spotify, or SoundCloud link.`;
  }
  return `No matches for “${safeQuery}”. Try a title and artist, or paste a supported link.`;
}
