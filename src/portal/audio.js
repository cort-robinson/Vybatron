import { fail } from './errors.js';

// Audio for portal listeners playing on their own device. Lavalink decodes the
// song through the same pipeline as Discord playback (our vybatron-audio plugin)
// and returns Ogg Opus. Browsers need a real length and byte ranges to seek,
// and iOS needs them to play at all, so each track is held briefly in a small
// in-memory LRU and served by range once complete. A request from the start
// streams while the song is still arriving, so playback begins in seconds.
// Nothing is written to disk.
export const AUDIO_LIMITS = Object.freeze({ trackBytes: 40 * 1024 * 1024, cacheBytes: 64 * 1024 * 1024, downloads: 2, timeoutMs: 120_000 });
// The plugin first; the YouTube plugin's own stream route only serves some videos.
const SOURCES = [['/vybatron/audio/', '', 'audio/ogg'], ['/youtube/stream/', '?itag=140', 'audio/mp4'], ['/youtube/stream/', '?itag=251', 'audio/webm']];
// The plugin ends a whole song with Ogg's end-of-stream page and a failed one
// without it, since an HTTP response can't be withdrawn once it has started.
export function wholeOgg(data) {
  let at = 0; let last = 0;
  while (at + 27 <= data.length && data.toString('latin1', at, at + 4) === 'OggS') {
    const segments = data[at + 26]; if (at + 27 + segments > data.length) return false;
    let size = 27 + segments; for (let i = 0; i < segments; i++) size += data[at + 27 + i];
    last = data[at + 5]; at += size;
  }
  return at === data.length && (last & 0x04) !== 0;
}
export const validVideoId = id => typeof id === 'string' && /^[\w-]{11}$/.test(id);

export function createAudioCache(client, { limits = AUDIO_LIMITS, fetchImpl = fetch } = {}) {
  const entries = new Map();
  let downloads = 0;
  // Recency order; a counter, since several lookups can share a millisecond.
  let tick = 0;
  const cached = () => [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  const evict = () => {
    for (const [id, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
      if (cached() <= limits.cacheBytes) return;
      if (entry.complete) entries.delete(id);
    }
  };
  // Resolves with the content type once a source answers; chunks follow.
  const download = async (id, entry) => {
    const node = client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
    if (!node?.connected || !node.options?.host) fail(503, 'audio_unavailable', 'Audio is temporarily unavailable. Try again shortly.');
    const { host, port, authorization, secure } = node.options;
    const signal = AbortSignal.timeout(limits.timeoutMs);
    for (const [path, query, type] of SOURCES) {
      const response = await fetchImpl(`${secure ? 'https' : 'http'}://${host}:${port}${path}${id}${query}`, { headers: { Authorization: authorization }, signal });
      if (response.ok) { entry.type = type; void receive(response, entry); return type; }
      await response.body?.cancel().catch(() => {});
      if (response.status === 429) fail(429, 'busy', 'Songs are still loading. Try again in a moment.');
      if (response.status === 413) fail(413, 'audio_too_long', 'This song is too long to play on this device.');
    }
    fail(404, 'audio_unavailable', 'This song can’t be streamed right now. Try another version.');
  };
  const receive = async (response, entry) => {
    try {
      for await (const chunk of response.body) {
        entry.bytes += chunk.length;
        if (entry.bytes > limits.trackBytes) fail(413, 'audio_too_long', 'This song is too long to play on this device.');
        entry.chunks.push(chunk);
        for (const listener of entry.listeners) listener(chunk);
      }
      if (!entry.bytes) fail(404, 'audio_unavailable', 'This song can’t be streamed right now. Try another version.');
      entry.data = Buffer.concat(entry.chunks);
      if (entry.type === 'audio/ogg' && !wholeOgg(entry.data)) fail(502, 'audio_unavailable', 'This song can’t be streamed right now. Try another version.');
      entry.chunks = [entry.data]; entry.complete = true;
      entry.settle();
      evict();
    } catch (error) {
      response.body?.cancel?.().catch(() => {});
      entry.fail(error);
    } finally { downloads--; for (const listener of entry.listeners) listener(null); }
  };
  // A background fetch (a visualizer's analysis) shares a cached song but starts a download only
  // while none is running, so it never takes a slot a listener's playback is about to need.
  const get = (id, { background = false } = {}) => {
    if (!validVideoId(id)) fail(400, 'invalid_audio', 'Choose a supported song.');
    const existing = entries.get(id);
    if (existing) { existing.used = ++tick; return existing.started.then(() => existing); }
    if (downloads >= (background ? 1 : limits.downloads)) fail(429, 'busy', 'Songs are still loading. Try again in a moment.');
    downloads++;
    const entry = { used: ++tick, type: null, bytes: 0, chunks: [], data: null, complete: false, error: null, listeners: new Set() };
    entry.done = new Promise((resolve, reject) => { entry.settle = resolve; entry.fail = error => { entry.error = error; if (entries.get(id) === entry) entries.delete(id); reject(error); }; });
    void entry.done.catch(() => {});
    entry.started = download(id, entry).catch(error => { downloads--; entry.fail(error); throw error; });
    entries.set(id, entry);
    return entry.started.then(() => entry);
  };
  return { get, clear: () => entries.clear(), get size() { return cached(); } };
}

const headers = type => ({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

// A song still arriving, from its first byte: sent as it comes, without a length.
function stream(response, entry) {
  return new Promise(resolve => {
    response.writeHead(200, headers(entry.type));
    for (const chunk of entry.chunks) response.write(chunk);
    if (entry.complete || entry.error) { if (entry.error) response.destroy(); else response.end(); resolve(); return; }
    const listener = chunk => {
      if (chunk) { response.write(chunk); return; }
      entry.listeners.delete(listener);
      if (entry.error) response.destroy(); else response.end();
      resolve();
    };
    entry.listeners.add(listener);
    response.once('close', () => { entry.listeners.delete(listener); resolve(); });
  });
}

// One byte range of a track, as browsers' media elements request it.
export async function sendAudio(request, response, entry) {
  const range = request.headers.range;
  if (!entry.complete && (range === undefined || range === 'bytes=0-')) return stream(response, entry);
  await entry.done;
  const { data } = entry; const size = data.length;
  let start = 0; let end = size - 1;
  if (range !== undefined) {
    const match = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(range);
    if (match && match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), size - 1); }
    else if (match && match[2]) start = Math.max(0, size - Number(match[2]));
    if (!match || (!match[1] && !match[2]) || start > end) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' }); response.end(); return;
    }
  }
  response.writeHead(range === undefined ? 200 : 206, { ...headers(entry.type), 'Content-Length': end - start + 1,
    ...(range !== undefined && { 'Content-Range': `bytes ${start}-${end}/${size}` }) });
  response.end(data.subarray(start, end + 1));
}

const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

/**
 * A device asks for one upload's audio. When the song store knows its song,
 * the song's verified sources are tried best first, and a source that can't
 * stream moves on to the next (ADR-0017). Unknown songs play as asked.
 */
export function playableAudio(audio, songs, { pinMs = 30 * 60_000, now = Date.now } = {}) {
  const reported = new WeakSet();
  // The source chosen for an upload stays its source across range requests, so
  // one URL never serves bytes from two different uploads.
  const pinned = new Map();
  return {
    async get(id, options) {
      if (!validVideoId(id)) return audio.get(id, options);
      const pin = pinned.get(id);
      if (pin && pin.until <= now()) pinned.delete(id);
      const known = Boolean(songs?.songOf?.(watchUrl(id)));
      let order = (songs?.playbackSources?.(watchUrl(id)) || [])
        .filter(source => source.sourceName === 'youtube' && validVideoId(source.identifier)).map(source => source.identifier);
      if (pinned.has(id)) order = [pinned.get(id).source, ...order.filter(source => source !== pinned.get(id).source)];
      // A known song whose every source failed recently waits out the cooldown; an unknown one plays as asked.
      if (!order.length && known) fail(404, 'audio_unavailable', 'This song can’t be streamed right now. Try another version.');
      if (!order.length) order.push(id);
      let failure;
      for (const source of order) {
        let entry;
        try { entry = await audio.get(source, options); }
        catch (error) {
          if (error?.status !== 404) throw error;
          if (pinned.get(id)?.source === source) pinned.delete(id);
          songs?.sourceResult?.(watchUrl(source), false); failure = error; continue;
        }
        pinned.delete(id); pinned.set(id, { source, until: now() + pinMs });
        while (pinned.size > 500) pinned.delete(pinned.keys().next().value);
        if (!reported.has(entry)) {
          reported.add(entry);
          entry.done.then(() => songs?.sourceResult?.(watchUrl(source), true), () => {
            // A stream that fails partway gives up its pin, so the next request chooses again.
            if (pinned.get(id)?.source === source) pinned.delete(id);
            songs?.sourceResult?.(watchUrl(source), false);
          });
        }
        return entry;
      }
      throw failure;
    },
  };
}
