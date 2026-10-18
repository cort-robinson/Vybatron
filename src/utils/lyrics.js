import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown } from 'discord.js';
import { withTimeout } from './enqueue.js';
import { NO_MENTIONS, plainText, safeText, trackIdentity } from './presentation.js';

// Lyrics come from Lavalink's LavaLyrics plugin, with sources configured in
// lavalink/application.yml. One shape serves /lyrics and the portal.
export const LYRICS_LIMITS = Object.freeze({ lines: 1000, lineLength: 300, pageCharacters: 3500, pageLines: 60 });
const CACHE_SIZE = 64;
const CACHE_MS = 30 * 60_000;
const cache = new Map();
const pending = new Map();

function lineText(value) {
  // Blank lines separate verses; keep them as breaks instead of a fallback word.
  const text = plainText(value, { fallback: '', maxLength: LYRICS_LIMITS.lineLength });
  return text === '♪' ? '' : text;
}

// LavaLyrics: {sourceName, provider, text, lines:[{timestamp, duration, line}]}.
// Timed lines make the lyrics synced; otherwise the text is split into lines.
export function normalizeLyrics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const timed = Array.isArray(raw.lines)
    ? raw.lines.filter(line => line && Number.isSafeInteger(line.timestamp) && line.timestamp >= 0 && typeof line.line === 'string')
    : [];
  const synced = timed.length > 0;
  const lines = synced
    ? timed.sort((a, b) => a.timestamp - b.timestamp).map(line => ({ startMs: line.timestamp, text: lineText(line.line) }))
    : String(typeof raw.text === 'string' ? raw.text : '').split(/\r?\n/).map(text => ({ startMs: null, text: lineText(text) }));
  // Trim leading and trailing breaks, and collapse runs of them.
  const compact = lines.filter((line, index) => line.text || (index > 0 && lines[index - 1].text));
  while (compact.length && !compact.at(-1).text) compact.pop();
  if (!compact.some(line => line.text)) return null;
  return {
    source: plainText(raw.sourceName, { fallback: 'unknown', maxLength: 40 }),
    provider: plainText(raw.provider, { fallback: '', maxLength: 80 }) || null,
    synced,
    lines: compact.slice(0, LYRICS_LIMITS.lines),
  };
}

function remember(key, result) {
  cache.delete(key);
  cache.set(key, { result, at: Date.now() });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
}

export function cachedLyrics(identity) {
  const entry = cache.get(identity);
  if (!entry || Date.now() - entry.at > CACHE_MS) { cache.delete(identity); return null; }
  return entry.result;
}

export function clearLyricsCache() { cache.clear(); pending.clear(); }

// -> {status:'found', lyrics} | {status:'not_found'} | {status:'unavailable'}.
// Found and not-found answers are cached per track; failures are not.
export async function trackLyrics(node, track, { timeoutMs = 8000 } = {}) {
  if (!track?.encoded) return { status: 'not_found' };
  const key = trackIdentity(track);
  const known = cachedLyrics(key);
  if (known) return known;
  if (pending.has(key)) return pending.get(key);
  if (!node?.connected || typeof node.request !== 'function') return { status: 'unavailable' };
  const task = (async () => {
    try {
      // The client's own lyrics.get leaves the base64 track unescaped in the query.
      const raw = await withTimeout(node.request(`/lyrics?track=${encodeURIComponent(track.encoded)}&skipTrackSource=false`), timeoutMs);
      const lyrics = normalizeLyrics(raw);
      // A 204 (nothing found) resolves undefined; an error body has no lines or text.
      if (raw !== undefined && raw !== null && !lyrics && (raw.status || raw.error)) return { status: 'unavailable' };
      const result = lyrics ? { status: 'found', lyrics } : { status: 'not_found' };
      remember(key, result);
      return result;
    } catch {
      // Missing plugin (404), timeouts and node errors.
      return { status: 'unavailable' };
    } finally { pending.delete(key); }
  })();
  pending.set(key, task);
  return task;
}

export function lyricsPages(lyrics) {
  const pages = [];
  let page = [];
  let size = 0;
  for (const line of lyrics?.lines || []) {
    const text = line.text ? escapeMarkdown(line.text.replaceAll('@', '@​')) : '';
    if (page.length && (size + text.length + 1 > LYRICS_LIMITS.pageCharacters || page.length >= LYRICS_LIMITS.pageLines)) {
      pages.push(page); page = []; size = 0;
    }
    // A page never starts on a verse break.
    if (!page.length && !text) continue;
    page.push(text); size += text.length + 1;
  }
  if (page.length) pages.push(page);
  return pages.map(lines => lines.join('\n').trim());
}

export function lyricsAttribution(lyrics) {
  return lyrics?.provider ? `Lyrics from ${lyrics.provider}` : 'Lyrics';
}

export function buildLyricsPayload(track, result, requestedPage = 0, ownerId = 'any') {
  if (result?.status !== 'found') {
    const description = result?.status === 'unavailable'
      ? 'Lyrics are unavailable right now. Try again in a moment.'
      : `No lyrics found for ${safeText(track?.info?.title, { fallback: 'Unknown track', maxLength: 180 })} — ${safeText(track?.info?.author, { fallback: 'Unknown artist', maxLength: 60 })}.`;
    return { embeds: [new EmbedBuilder().setColor(0x6d6f78).setTitle('Lyrics').setDescription(description)], components: [], allowedMentions: NO_MENTIONS };
  }
  const pages = lyricsPages(result.lyrics);
  const maxPage = Math.max(0, pages.length - 1);
  const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 0, 0), maxPage);
  const embed = new EmbedBuilder()
    .setColor(0xf20aa7)
    .setTitle(`${plainText(track?.info?.title, { fallback: 'Unknown track', maxLength: 180 })} — ${plainText(track?.info?.author, { fallback: 'Unknown artist', maxLength: 60 })}`)
    .setDescription(pages[page] || '…')
    .setFooter({ text: `${pages.length > 1 ? `Page ${page + 1} of ${pages.length} • ` : ''}${plainText(lyricsAttribution(result.lyrics), { maxLength: 100 })} • Only you can see this` });
  const components = [];
  if (pages.length > 1) {
    const identity = trackIdentity(track);
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`lyrics:v1:page:${ownerId}:${identity}:${Math.max(0, page - 1)}:previous`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`lyrics:v1:page:${ownerId}:${identity}:${Math.min(maxPage, page + 1)}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPage),
    ));
  }
  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

// The current song, or a loaded upcoming song by one-based queue position.
export function sessionTrack(player, position = null) {
  if (!position) return player?.queue?.current || null;
  return player?.queue?.tracks?.[position - 1] || null;
}

export function findSessionTrack(player, identity) {
  return [player?.queue?.current, ...(player?.queue?.tracks || [])].find(track => track && trackIdentity(track) === identity) || null;
}
