// Direct LRCLIB (https://lrclib.net) lookups, used when Lavalink's LavaLyrics finds
// nothing or fails. LavaSrc 4.8.3 stops on synced lines with no space after the
// timestamp ("[00:57.86]Words"), and matches the first search result whatever its
// length. Only a song's title and artist leave the bot, as they already do via Lavalink.
const API = 'https://lrclib.net/api/search';
const USER_AGENT = 'Vybatron (https://github.com/cort-robinson/Vybatron)';
const MAX_BYTES = 1024 * 1024;
// A recording more than this far from the song's length is another version.
const DURATION_TOLERANCE_S = 3;

export class LrclibUnavailable extends Error {}

// "[mm:ss.xx]words", with any number of leading timestamps and an optional space.
export function parseSynced(text) {
  const lines = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const stamps = [];
    let rest = raw;
    for (let match; (match = /^\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/.exec(rest));) {
      stamps.push(Math.round((Number(match[1]) * 60 + Number(match[2])) * 1000));
      rest = rest.slice(match[0].length);
    }
    for (const timestamp of stamps) lines.push({ timestamp, line: rest.trim() });
  }
  return lines.sort((a, b) => a.timestamp - b.timestamp);
}

// Reads at most MAX_BYTES, cancelling the download as soon as it grows past them.
async function boundedText(response) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new LrclibUnavailable(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function search(params, { fetchImpl, deadline }) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw new LrclibUnavailable();
  let body;
  try {
    const response = await fetchImpl(`${API}?${new URLSearchParams(params)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new LrclibUnavailable();
    body = await boundedText(response);
  } catch { throw new LrclibUnavailable(); }
  try {
    const value = JSON.parse(body);
    return Array.isArray(value) ? value : [];
  } catch { throw new LrclibUnavailable(); }
}

// candidates: [{artist, song}] in order of preference; durationMs: the song's length.
// -> LavaLyrics-shaped lyrics {sourceName, provider, text, lines}, or null when none match.
// Throws LrclibUnavailable when LRCLIB can't be reached before the deadline (epoch ms).
export async function lrclibLyrics(candidates, durationMs, { fetchImpl = (...args) => fetch(...args), deadline = Date.now() + 6000 } = {}) {
  const seconds = Number(durationMs) / 1000;
  for (const { artist, song } of candidates) {
    if (!artist || !song) continue;
    const results = await search({ track_name: song.slice(0, 200), artist_name: artist.slice(0, 120) }, { fetchImpl, deadline });
    const fits = results.filter(result => result && !result.instrumental
      && (!seconds || (Number.isFinite(result.duration) && Math.abs(result.duration - seconds) <= DURATION_TOLERANCE_S))
      && (typeof result.syncedLyrics === 'string' || typeof result.plainLyrics === 'string'));
    const chosen = fits.find(result => result.syncedLyrics) || fits[0];
    if (!chosen) continue;
    const lines = chosen.syncedLyrics ? parseSynced(chosen.syncedLyrics) : [];
    return { sourceName: 'lrclib', provider: 'LRCLIB', text: chosen.plainLyrics ?? null, lines };
  }
  return null;
}
