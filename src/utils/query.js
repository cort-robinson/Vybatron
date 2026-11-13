import { ManagerUtils } from 'lavalink-client';

const queryUtils = new ManagerUtils();

// Lavalink's client accepts loader prefixes and removes them before validation.
// Slash input exposes catalog links or song searches; raw loaders stay internal.
export function validatePlaybackQuery(query) {
  const value = String(query || '').trim();
  if (!value || value.length > 200) return 'Enter a song title, artist or supported link (up to 200 characters).';
  if (/^autocomplete:[^:]+:[a-f0-9]{12}$/.test(value)) return null;
  if (queryUtils.findSourceOfQuery(value) || /^(?:file|local|http):/i.test(value)) return 'Use a song and artist name or a supported public HTTPS catalog link.';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      const supported = /^(?:(?:www|music|m)\.)?youtube\.com$|^youtu\.be$|^(?:(?:www|m|on)\.)?soundcloud\.com$|^(?:open\.)?spotify\.com$|^(?:[a-z0-9-]+\.)?bandcamp\.com$/i;
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !supported.test(url.hostname)) return 'Use a public HTTPS link from YouTube, YouTube Music, Spotify, SoundCloud or Bandcamp.';
    } catch { return 'That link could not be read. Paste a supported public track or playlist URL.'; }
  }
  return null;
}

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('The audio source took too long to respond. Try again in a moment.')), Math.max(1, ms));
  })]).finally(() => clearTimeout(timer));
}

// The same words are searched again within seconds: autocomplete and the portal's
// result list run a search, then a submit of the typed text runs it once more.
// A short memory answers the second one without another round trip.
const RESULT_TTL_MS = 60_000;
const RESULT_LIMIT = 100;
const results = new Map();

export function resetSearchCache() { results.clear(); }

// A fresh copy per caller: the queue tracks each added song by object identity,
// and each copy carries its own requester.
function copyResult(result, user) {
  return { ...result, tracks: result.tracks.map(track => ({ ...track, info: { ...track.info }, pluginInfo: { ...track.pluginInfo }, userData: { ...track.userData, requester: user }, requester: user })) };
}

function usable(result) { return result?.loadType !== 'error' && result?.tracks?.length > 0; }

// Song searches prefer YouTube Music: its results are official audio with the
// real artist and square album art. Regular YouTube covers what it can't find
// and keeps searches working when the music client is unavailable. When the
// music client is slow rather than failing, regular YouTube starts alongside it
// and answers as soon as the music client's share of the time runs out.
async function searchFresh(searcher, query, user, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let fallback = null;
  const startFallback = () => fallback ??= searcher.search({ query, source: 'ytsearch' }, user);
  const hedge = setTimeout(() => { startFallback().catch(() => {}); }, Math.min(1_500, timeoutMs * 0.3));
  try {
    const music = await within(searcher.search({ query, source: 'ytmsearch' }, user), timeoutMs * 0.6);
    if (usable(music)) return music;
  } catch {
    // Fall back to regular YouTube within the remaining time.
  } finally { clearTimeout(hedge); }
  return within(startFallback(), deadline - Date.now());
}

export async function searchSongs(searcher, query, user, { timeoutMs = 10_000 } = {}) {
  const key = String(query).trim().toLocaleLowerCase();
  const cached = results.get(key);
  if (cached && cached.expiresAt > Date.now()) return copyResult(cached.result, user);
  const result = await searchFresh(searcher, query, user, timeoutMs);
  if (usable(result)) {
    results.delete(key);
    while (results.size >= RESULT_LIMIT) results.delete(results.keys().next().value);
    // The caller keeps the loaded tracks; the memory keeps its own copy of them.
    results.set(key, { result: copyResult(result, user), expiresAt: Date.now() + RESULT_TTL_MS });
  }
  return result;
}
