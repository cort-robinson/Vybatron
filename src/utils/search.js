import { isUrl, safeText } from './presentation.js';
import { resolveAutocompleteTrack } from './autocomplete.js';
import { withTimeout } from './enqueue.js';
import { parseSpotifyUrl, searchSpotifyEmbed } from './spotify.js';
export { validatePlaybackQuery } from './query.js';

export async function searchMusic(player, query, user, {
  timeoutMs = 10_000, spotifyTimeoutMs = 68_000, nativeTimeoutMs = 8_000,
  embedSearch = searchSpotifyEmbed,
} = {}) {
  const spotify = parseSpotifyUrl(query);
  if (!spotify) return withTimeout(player.search({ query }, user), timeoutMs);
  const deadline = Date.now() + spotifyTimeoutMs;
  try {
    const native = await withTimeout(player.search({ query: spotify.url }, user), Math.max(1, Math.min(nativeTimeoutMs, spotifyTimeoutMs)));
    if (native?.tracks?.length) return native;
  } catch {
    // A source token outage must not disable supported public catalog imports.
  }
  return embedSearch(player, spotify.url, user, { timeoutMs: Math.max(1, Math.min(60_000, deadline - Date.now())) });
}

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
    result: await searchMusic(player, query, user),
  };
}

export function searchFailureMessage(result, query) {
  if (result?.spotifyImport?.notice) return result.spotifyImport.notice;
  const safeQuery = safeText(query, { maxLength: 120 });
  if (result?.loadType === 'error') {
    if (isUrl(query)) {
      return 'Couldn’t load that link. Try another result or paste a different YouTube, Spotify, or SoundCloud link.';
    }
    return `Couldn’t load “${safeQuery}”. Try another result or paste a direct YouTube, Spotify, or SoundCloud link.`;
  }
  return `No matches for “${safeQuery}”. Try a title and artist, or paste a supported link.`;
}
