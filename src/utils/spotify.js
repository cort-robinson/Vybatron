// Spotify's public embed is used only for catalog identity. Playable tracks are
// fresh, conservatively matched YouTube results; no Spotify previews or tokens
// enter the queue, cache, or saved library.
const ID = /^[a-zA-Z0-9]{22}$/;
const TYPES = new Set(['track', 'album', 'playlist']);
const MAX_BYTES = 1024 * 1024;
const MAX_TRACKS = 100;
const CACHE_SIZE = 100;
const CACHE_TTL = 5 * 60_000;

export function parseSpotifyUrl(value) {
  if (typeof value !== 'string') return null;
  const uri = value.match(/^spotify:(track|album|playlist):([a-zA-Z0-9]{22})$/);
  let type; let id;
  if (uri) [, type, id] = uri;
  else {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com'
        || url.username || url.password || url.port) return null;
      const path = url.pathname.match(/^\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist)\/([a-zA-Z0-9]{22})\/?$/i);
      if (!path) return null;
      [, type, id] = path;
      type = type.toLowerCase();
    } catch { return null; }
  }
  return Object.freeze({ type, id, uri: `spotify:${type}:${id}`,
    url: `https://open.spotify.com/${type}/${id}`, embedUrl: `https://open.spotify.com/embed/${type}/${id}` });
}

function text(value, limit) {
  return typeof value === 'string' && value.trim() && value.length <= limit
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ? value.trim() : null;
}

function parseMember(row, { collection = false } = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.isPlayable === false) return null;
  if (collection && row.entityType !== 'track') return null;
  const ref = parseSpotifyUrl(row.uri);
  if (ref?.type !== 'track' || (row.id !== undefined && row.id !== ref.id)) return null;
  const title = text(row.title, 250);
  const duration = row.duration;
  const artists = collection
    ? (text(row.subtitle, 500)?.split(/,\s*/u).map(name => text(name, 128)) || [])
    : (Array.isArray(row.artists) ? row.artists.map(artist => text(artist?.name, 128)) : []);
  if (!title || !Number.isSafeInteger(duration) || duration < 1_000 || duration > 24 * 60 * 60_000
    || !artists.length || artists.length > 20 || artists.some(artist => !artist)) return null;
  return Object.freeze({ id: ref.id, uri: ref.uri, url: ref.url, title,
    artists: Object.freeze(artists), author: artists.join(', '), duration, isExplicit: row.isExplicit === true });
}

export function parseSpotifyEmbed(html, requested, { limit = MAX_TRACKS } = {}) {
  const ref = typeof requested === 'string' ? parseSpotifyUrl(requested) : parseSpotifyUrl(requested?.url);
  if (!ref || !TYPES.has(ref.type) || !ID.test(ref.id) || typeof html !== 'string'
    || Buffer.byteLength(html) > MAX_BYTES) throw new Error('Unsupported Spotify catalog response.');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => /(?:^|\s)id\s*=\s*(["'])__NEXT_DATA__\1/i.test(match[1]));
  if (scripts.length !== 1 || !/(?:^|\s)type\s*=\s*(["'])application\/json\1/i.test(scripts[0][1])) {
    throw new Error('Spotify public catalog metadata is unavailable.');
  }
  let data;
  try { data = JSON.parse(scripts[0][2])?.props?.pageProps?.state?.data; }
  catch { throw new Error('Unsupported Spotify catalog response.'); }
  const entity = data?.entity;
  if (!entity || entity.type !== ref.type || entity.id !== ref.id || entity.uri !== ref.uri
    || (data.embeded_entity_uri !== undefined && data.embeded_entity_uri !== ref.uri)) {
    throw new Error('Spotify returned a different catalog item.');
  }
  const title = text(entity.title, 250);
  if (!title) throw new Error('Spotify public catalog metadata is incomplete.');
  if (ref.type === 'track') {
    const track = parseMember(entity);
    if (!track) throw new Error('Spotify track metadata is unavailable.');
    return Object.freeze({ ...ref, title, tracks: Object.freeze([track]), listedCount: 1,
      skippedMetadataCount: 0, capped: false, partial: false });
  }
  if (!Array.isArray(entity.trackList)) throw new Error('Spotify public track list is unavailable.');
  const cap = Math.max(1, Math.min(MAX_TRACKS, Math.floor(limit) || MAX_TRACKS));
  const listed = entity.trackList.slice(0, cap);
  const tracks = listed.map(row => parseMember(row, { collection: true })).filter(Boolean);
  // Public embeds have no authoritative total or pagination. Never claim that
  // a playlist or album import contains the complete collection.
  return Object.freeze({ ...ref, title, tracks: Object.freeze(tracks), listedCount: entity.trackList.length,
    skippedMetadataCount: listed.length - tracks.length, capped: entity.trackList.length > cap, partial: true });
}

function normal(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function compact(value) { return normal(value).replace(/ /g, ''); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function recordingTitle(value, artists) {
  let title = String(value || '').trim();
  for (const artist of [...artists].sort((a, b) => b.length - a.length)) {
    title = title.replace(new RegExp(`^${escapeRegex(artist)}\\s*[-:|–—]\\s*`, 'iu'), '');
  }
  // Keep live, remixed, acoustic, clean, sped/slowed, and every other recording
  // qualifier. Only presentation labels attached to the same recording go.
  const label = '(?:official\\s+)?(?:music\\s+video|lyric(?:s|\\s+video)?|audio|video)|(?:HD|HQ|4K)';
  let previous;
  do {
    previous = title;
    title = title.replace(new RegExp(`\\s*[([]\\s*(?:${label})\\s*[)\\]]\\s*$`, 'iu'), '').trim();
  } while (previous !== title);
  return normal(title);
}

function artistMatches(author, artists) {
  const actual = compact(author);
  const primary = compact(artists[0]);
  if (!actual || !primary) return false;
  return actual === primary || actual === compact(artists.join(' '))
    || ['topic', 'vevo', 'music', 'official', 'officialmusic', 'officialchannel', 'officialmusicchannel']
      .some(suffix => actual === primary + suffix);
}

function youtubeIdentity(info) {
  if (info?.sourceName !== 'youtube' || !/^[\w-]{11}$/.test(info.identifier || '')) return false;
  try {
    const url = new URL(info.uri);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && /^(?:www\.|music\.|m\.)?youtube\.com$/.test(url.hostname)
      && url.pathname === '/watch' && url.searchParams.get('v') === info.identifier;
  } catch { return false; }
}

export function matchSpotifyRecording(metadata, candidates) {
  if (!text(metadata?.title, 250) || !Array.isArray(metadata?.artists) || !metadata.artists.length
    || metadata.artists.some(artist => !text(artist, 128)) || !Number.isFinite(metadata.duration)) return null;
  const title = recordingTitle(metadata.title, metadata.artists);
  const tolerance = Math.max(1_500, Math.min(6_000, metadata.duration * 0.025));
  const matches = (Array.isArray(candidates) ? candidates : []).filter(track => {
    const info = track?.info;
    const duration = info?.duration ?? info?.length;
    return typeof track?.encoded === 'string' && track.encoded.length > 0 && youtubeIdentity(info)
      && info.isStream !== true && track.pluginInfo?.isPreview !== true
      && Number.isFinite(duration) && duration > 0 && Math.abs(duration - metadata.duration) <= tolerance
      && artistMatches(info.author, metadata.artists) && recordingTitle(info.title, metadata.artists) === title;
  });
  matches.sort((a, b) => Math.abs((a.info.duration ?? a.info.length) - metadata.duration)
    - Math.abs((b.info.duration ?? b.info.length) - metadata.duration));
  return matches[0] || null;
}

function timeoutError() { return Object.assign(new Error('Spotify catalog import took too long.'), { code: 'SPOTIFY_TIMEOUT' }); }
function abortError() { return Object.assign(new Error('Spotify catalog import was cancelled.'), { code: 'SPOTIFY_ABORTED' }); }

function catalogSearchQuery(item) {
  const query = `${item.artists.join(' ')} ${item.title}`;
  // Catalog display names are untrusted text too. lavalink-client extracts
  // leading source prefixes and treats leading HTTP schemes as direct links,
  // even when a search source is explicitly supplied.
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(query) ? `"${query.replace(/"/g, ' ')}"` : query;
}

async function bounded(operation, ms, signal, setTimer, clearTimer) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
  const controller = new AbortController();
  let timer; let listener;
  const cancelled = new Promise((_, reject) => {
    listener = () => { const error = signal?.reason instanceof Error ? signal.reason : abortError(); controller.abort(error); reject(error); };
    if (signal?.aborted) listener();
    else signal?.addEventListener('abort', listener, { once: true });
    timer = setTimer(() => { const error = timeoutError(); controller.abort(error); reject(error); }, Math.max(1, ms));
  });
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), cancelled]);
  } finally {
    clearTimer(timer);
    signal?.removeEventListener('abort', listener);
  }
}

async function boundedHtml(response) {
  if (!response?.ok || response.status !== 200
    || !/^text\/html(?:;|$)/i.test(response.headers?.get('content-type') || '')
    || Number(response.headers?.get('content-length')) > MAX_BYTES) throw new Error('Spotify public catalog is unavailable.');
  if (!response.body?.getReader) throw new Error('Unsupported Spotify catalog response.');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Spotify catalog response is too large.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function importNotice(metadata, matched, unavailable, remaining) {
  const collection = metadata.type !== 'track';
  let notice = collection ? `Matched ${matched} of ${Math.min(MAX_TRACKS, metadata.listedCount)} public listed tracks.` : 'Matched Spotify catalog metadata to a full recording on YouTube.';
  if (unavailable) notice += ` ${unavailable} ${unavailable === 1 ? 'track was' : 'tracks were'} unavailable or had no confident recording match.`;
  if (remaining) notice += ` ${remaining} ${remaining === 1 ? 'track was' : 'tracks were'} left out when the import time limit was reached.`;
  if (metadata.capped) notice += ' Imports are limited to 100 listed tracks.';
  if (collection) notice += metadata.type === 'playlist' ? ' The playlist may contain more tracks.' : ' The public album listing may omit tracks.';
  return notice;
}

export function createSpotifyResolver({ fetchImpl = globalThis.fetch, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, metadataTimeoutMs = 8_000,
  importTimeoutMs = 60_000, lookupTimeoutMs = 10_000 } = {}) {
  const cache = new Map();

  async function metadata(query, { signal } = {}) {
    const ref = typeof query === 'string' ? parseSpotifyUrl(query) : parseSpotifyUrl(query?.url);
    if (!ref) throw new Error('Unsupported Spotify link.');
    for (const [key, item] of cache) if (item.expires <= now()) cache.delete(key);
    const saved = cache.get(ref.uri);
    if (saved) { cache.delete(ref.uri); cache.set(ref.uri, saved); return saved.value; }
    const value = await bounded(async requestSignal => {
      const response = await fetchImpl(ref.embedUrl, { signal: requestSignal, redirect: 'error',
        headers: { Accept: 'text/html' } });
      if (response.url && response.url !== ref.embedUrl) throw new Error('Unexpected Spotify catalog destination.');
      return parseSpotifyEmbed(await boundedHtml(response), ref);
    }, Math.min(8_000, metadataTimeoutMs), signal, setTimer, clearTimer);
    if (signal?.aborted) throw signal.reason || abortError();
    cache.set(ref.uri, { value, expires: now() + CACHE_TTL });
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return value;
  }

  async function search(player, query, requester, { signal, timeoutMs = importTimeoutMs } = {}) {
    const ref = parseSpotifyUrl(query);
    if (!ref) return null;
    const controller = new AbortController();
    const cancel = () => controller.abort(signal?.reason instanceof Error ? signal.reason : abortError());
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    const budget = Math.max(1, Math.min(60_000, timeoutMs));
    const timer = setTimer(() => controller.abort(timeoutError()), budget);
    const deadline = now() + budget;
    try {
      const catalog = await metadata(ref, { signal: controller.signal });
      const outcomes = new Array(catalog.tracks.length); let next = 0;
      async function worker() {
        while (next < catalog.tracks.length && !controller.signal.aborted && now() < deadline) {
          const index = next++; const item = catalog.tracks[index];
          let matched = null;
          for (const source of ['ytmsearch', 'ytsearch']) {
            if (controller.signal.aborted || now() >= deadline) break;
            try {
              const result = await bounded(() => player.search({ query: catalogSearchQuery(item), source }, requester),
                Math.min(10_000, lookupTimeoutMs, deadline - now()), controller.signal, setTimer, clearTimer);
              if (!controller.signal.aborted) matched = matchSpotifyRecording(item, result?.tracks);
              if (matched) break;
            } catch (error) {
              // Stop dispatch after a hung request. A client that ignores abort
              // must not accumulate more than the four outstanding lookups.
              if (error?.code === 'SPOTIFY_TIMEOUT') controller.abort(error);
              if (controller.signal.aborted) break;
            }
          }
          if (!controller.signal.aborted) outcomes[index] = matched;
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, catalog.tracks.length) }, worker));
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
      const tracks = outcomes.filter(Boolean);
      const remainingCount = outcomes.length - outcomes.filter(value => value !== undefined).length;
      const unavailableCount = catalog.skippedMetadataCount + outcomes.filter(value => value === null).length;
      const notice = tracks.length || ref.type !== 'track'
        ? importNotice(catalog, tracks.length, unavailableCount, remainingCount)
        : 'No confident full recording match was found for this Spotify track. Try the title and artist or a direct YouTube link.';
      return { loadType: tracks.length ? (ref.type === 'track' ? 'track' : 'playlist') : 'empty', tracks,
        exception: null, pluginInfo: {}, playlist: ref.type === 'track' ? null : {
          name: catalog.title, title: catalog.title, uri: catalog.url,
          duration: tracks.reduce((sum, track) => sum + (track.info.duration ?? track.info.length ?? 0), 0) },
        spotifyImport: { mode: 'public-embed', type: ref.type, listedCount: catalog.listedCount,
          selectedCount: catalog.tracks.length, matchedCount: tracks.length, unavailableCount,
          remainingCount, capped: catalog.capped, partial: catalog.partial, notice } };
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
      return { loadType: 'error', tracks: [], exception: { message: 'Spotify public catalog is unavailable.' },
        spotifyImport: { mode: 'public-embed', type: ref.type, notice: error?.code === 'SPOTIFY_TIMEOUT'
          ? 'Spotify catalog lookup took too long. Try again or paste a direct YouTube link.'
          : 'Could not read this public Spotify catalog item. Try a public link, or search its title and artist.' } };
    } finally { clearTimer(timer); signal?.removeEventListener('abort', cancel); }
  }

  return { metadata, search, clearCache: () => cache.clear(), cacheSize: () => cache.size };
}

const resolver = createSpotifyResolver();
export const searchSpotifyEmbed = (...args) => resolver.search(...args);
