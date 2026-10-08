// Same-song identity. Pure and deterministic: no I/O, clock or catalog lookup.
// "Artist - Topic" uploads, official/lyric/audio videos, remasters and feat.
// credits of one recording share a song key. Live, remix, acoustic, cover and
// similar versions stay distinct. Play statistics and autoplay dedupe use it.

const DASH = /\s+[-–—~]\s+/;
const BRACKETS = /\(([^()]*)\)|\[([^[\]]*)\]|\{([^{}]*)\}|【([^【】]*)】/g;
// Words allowed in a descriptor that only says how a recording was uploaded.
const NOISE_WORD = new RegExp(`^(?:${[
  'official', 'officiel', 'oficial', 'music', 'video', 'videoclip', 'clip', 'audio', 'lyrics?', 'letra', 'paroles',
  'visuali[sz]er', 'hd', 'hq', 'uhd', '4k', '1080p', '720p', 'mv', 'm/v', 'explicit', 'clean', 'uncensored',
  'with', 'w/', 'on', 'screen', 'color', 'coded', 'full', 'version', 'remaster(?:ed)?', '\\d{4}', 'radio', 'edit',
  'single', 'album', 'original', 'mix', 'stereo', 'mono', 'premiere', 'new', 'and', '&', 'by', 'vevo', 'only', 'quality', 'high',
].join('|')})$`, 'i');
// A descriptor must actually describe the upload, not only say "version".
const NOISE_ANCHOR = /official|officiel|oficial|video|clip|audio|lyric|letra|paroles|visuali[sz]er|\bhd\b|\bhq\b|uhd|4k|1080p|720p|\bmv\b|m\/v|explicit|clean|uncensored|remaster|radio edit|single version|album version|original mix|stereo|mono|premiere/i;
// Unbracketed trailing descriptors need a stronger signal ("Mr. Clean" stays).
const TRAILING_ANCHOR = /official|video|lyric|audio|visuali[sz]er|remaster/i;
const FEATURE = /^(?:feat\.?|ft\.?|featuring|with|w\/)\s/i;
const TRAILING_FEATURE = /\s+(?:feat\.?|ft\.?|featuring)\s.*$/i;
const ARTIST_SPLIT = /\s*(?:,|;|\/|&|\+|\s(?:x|×|and|feat\.?|ft\.?|featuring|with|vs\.?)\s)\s*/i;
const FEATURED_SPLIT = /\s+(?:feat\.?|ft\.?|featuring|with)\s/i;
const TOPIC = /\s*-\s*topic\s*$/i;
const CHANNEL_SUFFIX = /(?<=\S)\s*(?:vevo|official(?:\s+(?:channel|artist))?)\s*$/i;

function fold(value) {
  return String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[’‘`´]/g, "'").replace(/[“”«»„]/g, '"').replace(/\s+/g, ' ').trim();
}

const compact = value => fold(value).replace(/&/g, 'and').replace(/'/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

function isNoise(content, anchor = NOISE_ANCHOR) {
  const text = fold(content).replace(/[|:,–—()[\]-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || !anchor.test(text)) return false;
  return text.split(' ').every(word => NOISE_WORD.test(word.replace(/[.!]+$/, '')));
}

function cleanTitle(value) {
  // "Song | Artist | Official Video" keeps its first segment.
  let title = fold(value).split(/\s+\|\s+|\s+\/\/\s+/)[0];
  title = title.replace(BRACKETS, (whole, ...groups) => {
    const content = groups.slice(0, 4).find(group => group !== undefined) || '';
    return isNoise(content) || FEATURE.test(fold(content)) ? ' ' : whole;
  }).replace(TRAILING_FEATURE, '').replace(/\s+/g, ' ').trim();
  const words = title.split(' ');
  for (let start = 1; start < words.length; start++) {
    if (isNoise(words.slice(start).join(' '), TRAILING_ANCHOR)) { title = words.slice(0, start).join(' '); break; }
  }
  return title.replace(/^["']+|["']+$/g, '').trim();
}

// Credited artists without featured guests, in their original spelling.
function creditedArtist(value) {
  const artist = String(value || '').replace(TOPIC, '').replace(CHANNEL_SUFFIX, '').replace(/\s+/g, ' ').trim();
  return artist.split(FEATURED_SPLIT)[0].trim() || artist;
}
// Keys use the first credited artist so "A & B" and "A, B" agree.
const primaryArtist = value => { const artist = creditedArtist(value); return artist.split(ARTIST_SPLIT)[0].trim() || artist; };

/**
 * Parse one catalog reference into a stable song identity.
 * @param {{ title?: string, author?: string, sourceName?: string, identifier?: string, uri?: string }} reference
 * @returns {{ key: string, artistKey: string, artist: string }} artist is display text
 */
export function songIdentity(reference = {}) {
  const rawTitle = String(reference.title || '');
  const rawAuthor = String(reference.author || '');
  let artist = creditedArtist(rawAuthor);
  let title = rawTitle;
  // Topic uploads are already "Title" by "Artist"; others are often "Artist - Title".
  if (!TOPIC.test(rawAuthor)) {
    const [left, ...rest] = rawTitle.split(DASH);
    const right = rest.join(' - ');
    if (rest.length && isNoise(right)) title = left; // "Song - Remastered 2011"
    else if (rest.length && compact(primaryArtist(right)) === compact(artist)) title = left; // "Song - Artist"
    else if (rest.length) { artist = creditedArtist(left); title = right; }
  }
  const artistKey = compact(primaryArtist(artist)).slice(0, 120) || 'unknown';
  const titleKey = compact(cleanTitle(title));
  const fallback = `id:${fold(reference.sourceName) || 'unknown'}:${String(reference.identifier || reference.uri || '').slice(0, 120)}`;
  return {
    key: (titleKey ? `${artistKey}|${titleKey}` : fallback).slice(0, 200),
    artistKey,
    artist: artist.slice(0, 120) || 'Unknown artist',
  };
}

export function songKey(reference) { return songIdentity(reference).key; }

/**
 * Higher ranks are more reliably playable references for the same song: YouTube
 * Music topic uploads first, then official audio, then other uploads. Spotify
 * references must be mirrored at play time, so they rank lowest.
 */
export function referenceRank(reference = {}) {
  if (reference.isStream) return 0;
  const title = fold(reference.title);
  let rank = { youtube: 30, soundcloud: 20, bandcamp: 20, spotify: 10 }[reference.sourceName] ?? 5;
  if (TOPIC.test(String(reference.author || ''))) rank += 8;
  else if (/\baudio\b/.test(title)) rank += 4;
  if (/\b(?:video|lyrics?|visuali[sz]er)\b/.test(title)) rank -= 4;
  return rank;
}
