import { fail } from './errors.js';

// Audio for portal listeners playing on their own device. Lavalink's YouTube
// plugin streams a video's audio but sends no real length and ignores Range,
// which browsers need to seek (and iOS needs to play at all). A whole track
// arrives in a couple of seconds, so it is held briefly in a small LRU and
// served by byte range from memory. Nothing is written to disk.
export const AUDIO_LIMITS = Object.freeze({ trackBytes: 40 * 1024 * 1024, cacheBytes: 64 * 1024 * 1024, downloads: 2, timeoutMs: 60_000 });
// AAC plays everywhere, including iOS; Opus/WebM is the fallback.
const FORMATS = [[140, 'audio/mp4'], [251, 'audio/webm']];
export const validVideoId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);

export function createAudioCache(client, { limits = AUDIO_LIMITS, fetchImpl = fetch } = {}) {
  const entries = new Map();
  let downloads = 0;
  // Recency order; a counter, since several lookups can share a millisecond.
  let tick = 0;
  const cached = () => [...entries.values()].reduce((sum, entry) => sum + (entry.audio?.data.length || 0), 0);
  const evict = bytes => {
    for (const [id, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (cached() + bytes <= limits.cacheBytes) return;
      if (entry.audio) entries.delete(id);
    }
  };
  const download = async id => {
    const node = client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
    if (!node?.connected || !node.options?.host) fail(503, 'audio_unavailable', 'Audio is temporarily unavailable. Try again shortly.');
    const { host, port, authorization, secure } = node.options;
    for (const [itag, type] of FORMATS) {
      const response = await fetchImpl(`${secure ? 'https' : 'http'}://${host}:${port}/youtube/stream/${id}?itag=${itag}`,
        { headers: { Authorization: authorization }, signal: AbortSignal.timeout(limits.timeoutMs) });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); continue; }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > limits.trackBytes) fail(413, 'audio_too_long', 'This song is too long to play on this device.');
        chunks.push(chunk);
      }
      if (bytes) return { data: Buffer.concat(chunks), type };
    }
    fail(404, 'audio_unavailable', 'This song can’t be streamed right now. Try another version.');
  };
  const get = id => {
    if (!validVideoId(id)) fail(400, 'invalid_audio', 'Choose a supported song.');
    const existing = entries.get(id);
    if (existing) { existing.used = ++tick; return existing.promise; }
    if (downloads >= limits.downloads) fail(429, 'busy', 'Songs are still loading. Try again in a moment.');
    downloads++;
    const entry = { used: ++tick, audio: null };
    entry.promise = download(id).then(audio => { evict(audio.data.length); entry.audio = audio; return audio; })
      .catch(error => { if (entries.get(id) === entry) entries.delete(id); throw error; })
      .finally(() => { downloads--; });
    entries.set(id, entry);
    return entry.promise;
  };
  return { get, clear: () => entries.clear(), get size() { return cached(); } };
}

// One byte range of a cached track, as browsers' media elements request it.
export function sendAudio(request, response, { data, type }) {
  const size = data.length; const range = request.headers.range;
  let start = 0; let end = size - 1;
  if (range !== undefined) {
    const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range);
    if (match && match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
    else if (match && match[2]) start = Math.max(0, size - Number(match[2]));
    if (!match || (!match[1] && !match[2]) || start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' }); response.end(); return;
    }
  }
  response.writeHead(range === undefined ? 200 : 206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
    ...(range !== undefined && { 'Content-Range': `bytes ${start}-${end}/${size}` }), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(data.subarray(start, end + 1));
}
