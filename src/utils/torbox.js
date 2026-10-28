// TorBox plays another copy of a song YouTube refused: an indexer (Torznab)
// finds torrents, TorBox says which it has cached, and a cached file matching
// the title becomes a direct HTTPS link that Lavalink's HTTP source streams.
// Nothing waits on a download. Keys and links are never logged.
const API = 'https://api.torbox.app/v1/api';
const AUDIO = /\.(?:flac|mp3|m4a|aac|ogg|oga|opus|wav)$/i;
// Video titles decorate the song with release labels a file name lacks.
const DECORATION = /\s*[([][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|mv|clip)\b[^)\]]*[)\]]/giu;

// Songs mostly sit in album and discography torrents, so the artist search
// finds what a title search misses. Up to 100 hashes go in one cache check.
export const TORBOX_LIMITS = Object.freeze({ hashes: 100, torrents: 3, requestMs: 8000 });

function words(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// The search query and the bare song title a matching file must contain.
// YouTube titles are often "Artist - Song"; a "- Topic" channel is the artist.
export function songTerms(track) {
  const info = track?.info || {};
  const title = String(info.title || '').replace(DECORATION, '').trim();
  const author = String(info.author || '').replace(/\s*-\s*topic$/iu, '').trim();
  const split = title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
  const artist = split ? split[1] : author;
  const song = split ? split[2] : title;
  if (!words(song)) return null;
  return { query: `${artist} ${song}`.trim(), song: words(song), artist: words(artist) };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The best audio file for the song in a torrent: its name holds the whole
// title, and the artist appears somewhere in the torrent or file path. A name
// that is only the title (after track number and artist) beats one with more
// in it, like "(Live)" or "Sweet Dreams" for "Dreams"; then the shorter wins.
export function matchingFile(files, terms, torrentName = '') {
  const song = new RegExp(`(?:^| )${escapeRegExp(terms.song)}(?: |$)`, 'u');
  const artist = terms.artist ? new RegExp(`(?:^| )${escapeRegExp(terms.artist)}(?: |$)`, 'u') : null;
  const scored = [];
  for (const file of files || []) {
    const path = String(file?.name || '');
    const base = words(path.split('/').pop());
    if (!AUDIO.test(path) || !song.test(base)) continue;
    if (artist && !artist.test(`${words(torrentName)} ${words(path)}`)) continue;
    const rest = base.replace(/^\d+ /, '').replace(terms.artist, '').replace(terms.song, '').trim();
    scored.push({ file, exact: rest === '', length: base.length });
  }
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || a.length - b.length);
  return scored[0]?.file || null;
}

export function createTorbox({ apiKey, search, fetch = globalThis.fetch, requestMs = TORBOX_LIMITS.requestMs } = {}) {
  async function call(url, { signal, method = 'GET', body } = {}) {
    const response = await fetch(url, { method, body,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(requestMs), ...(signal ? [signal] : [])]) });
    const payload = await response.json().catch(() => null);
    // A refusal names only the endpoint's error code, never the request.
    if (!response.ok || payload?.success === false) {
      const error = new Error(`TorBox request failed: ${String(payload?.error || response.status).slice(0, 60)}`);
      error.code = payload?.error;
      throw error;
    }
    return payload?.data;
  }

  async function cached(hashes, signal) {
    if (!hashes.length) return [];
    const data = await call(`${API}/torrents/checkcached?hash=${hashes.join(',')}&format=list&list_files=true`, { signal });
    return Array.isArray(data) ? data : [];
  }

  async function ownedTorrent(hash, signal) {
    const list = await call(`${API}/torrents/mylist?bypass_cache=true`, { signal });
    return (Array.isArray(list) ? list : []).find(item => String(item?.hash).toLowerCase() === hash) || null;
  }

  // Adding a cached torrent is instant, and TorBox refuses one whose cache
  // entry went away since the check, so nothing ever downloads. The magnet is
  // built from the checked hash, never taken from the indexer. A torrent
  // already in the account is reused.
  async function addTorrent(hash, signal) {
    try {
      const body = new FormData();
      body.append('magnet', `magnet:?xt=urn:btih:${hash}`);
      body.append('add_only_if_cached', 'true');
      const created = await call(`${API}/torrents/createtorrent`, { method: 'POST', body, signal });
      if (Number.isSafeInteger(created?.torrent_id)) {
        return call(`${API}/torrents/mylist?bypass_cache=true&id=${created.torrent_id}`, { signal });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return ownedTorrent(hash, signal);
  }

  // A cached file for each query in turn, in the indexer's order.
  async function* candidates(terms, signal) {
    const seen = new Set();
    for (const query of [terms.query, terms.artist && terms.artist !== terms.song ? terms.artist : null]) {
      if (!query) continue;
      const results = (await search(query, signal)).filter(result => !seen.has(result.hash)).slice(0, TORBOX_LIMITS.hashes);
      for (const result of results) seen.add(result.hash);
      const hits = new Map((await cached(results.map(result => result.hash), signal))
        .map(item => [String(item?.hash).toLowerCase(), item]));
      for (const result of results) {
        const item = hits.get(result.hash);
        const file = item && matchingFile(item.files, terms, item.name);
        if (file) yield { ...result, file };
      }
    }
  }

  // A direct link to a cached copy of the track, or null when none matches.
  async function findStream(track, signal) {
    const terms = songTerms(track);
    if (!terms || track.info?.isStream) return null;
    let tried = 0;
    for await (const { hash, file } of candidates(terms, signal)) {
      if (++tried > TORBOX_LIMITS.torrents) break;
      const torrent = await addTorrent(hash, signal);
      // The full path: a compilation can hold the same file name per artist.
      const owned = (torrent?.files || []).find(candidate => candidate?.name === file.name);
      if (!Number.isSafeInteger(torrent?.id) || !Number.isSafeInteger(owned?.id)) continue;
      const params = new URLSearchParams({ token: apiKey, torrent_id: String(torrent.id), file_id: String(owned.id), redirect: 'false' });
      const link = await call(`${API}/torrents/requestdl?${params}`, { signal });
      if (typeof link === 'string' && link.startsWith('https://')) return { url: link, name: String(owned.name).split('/').pop() };
    }
    return null;
  }

  return { findStream };
}
