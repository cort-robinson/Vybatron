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

/** The artist key for a display name, matching the key songIdentity assigns that artist. */
export function artistKeyOf(name) { return songIdentity({ author: name }).artistKey; }

/**
 * Higher ranks are more reliably playable references for the same song: YouTube
 * Music topic uploads first, then official audio, then other uploads. Spotify
 * references must be mirrored at play time, so they rank lowest.
 */
// Lavalink gives YouTube Music song results their album art from Google's image hosts;
// videos loaded from YouTube get i.ytimg.com thumbnails.
export function isYouTubeMusicSong(track) {
  const info = track?.info || track || {};
  return info.sourceName === 'youtube' && /^https:\/\/(?:lh3|yt3)\.googleusercontent\.com\//.test(String(info.artworkUrl || ''));
}

export function referenceRank(reference = {}, { youtubeMusic = false } = {}) {
  if (reference.isStream) return 0;
  const title = fold(reference.title);
  let rank = { youtube: 30, soundcloud: 20, bandcamp: 20, spotify: 10 }[reference.sourceName] ?? 5;
  // A YouTube Music song result is a topic upload that names the artist, not the channel.
  if (youtubeMusic || TOPIC.test(String(reference.author || ''))) rank += 8;
  else if (/\baudio\b/.test(title)) rank += 4;
  if (/\b(?:video|lyrics?|visuali[sz]er)\b/.test(title)) rank -= 4;
  return rank;
}

// Recording identity (ADR-0017) is stricter than the song key: it removes only
// what says how a recording was uploaded. Remasters, edits, clean versions and
// mixes are other recordings, so their descriptors stay part of the title.
const UPLOAD_WORD = new RegExp(`^(?:${[
  'official', 'officiel', 'oficial', 'music', 'video', 'videoclip', 'clip', 'audio', 'lyrics?', 'letra', 'paroles',
  'visuali[sz]er', 'hd', 'hq', 'uhd', '4k', '1080p', '720p', 'mv', 'm/v', 'explicit', 'uncensored',
  'with', 'w/', 'on', 'screen', 'color', 'coded', 'full', 'premiere', 'new', 'and', '&', 'by', 'vevo', 'only', 'quality', 'high',
].join('|')})$`, 'i');
const UPLOAD_ANCHOR = /official|officiel|oficial|video|clip|audio|lyric|letra|paroles|visuali[sz]er|\bhd\b|\bhq\b|uhd|4k|1080p|720p|\bmv\b|m\/v|explicit|uncensored|premiere/i;
const UPLOAD_TRAILING_ANCHOR = /official|video|lyric|audio|visuali[sz]er/i;
// A dash part that is only a version ("Song - Remastered 2011", "Song - Live at X"),
// never a title that starts with a version word ("Artist - Live Forever").
// Matched against normalized text, so "Slowed + Reverb" reads "slowed reverb".
const VERSION_ONLY = /^(?:(?:\d{4} )?remaster(?:ed)?(?: \d{4})?(?: (?:version|edition))?|live(?: (?:at|from|in|on) .+| version| \d{4})?|(?:radio|single|album|extended|edit)(?: (?:edit|version|mix))?|acoustic(?: version)?|instrumental|clean|mono|stereo|demo|unplugged|sped up|slowed(?: (?:and )?reverb)?|re ?recorded|.+ (?:remix|mix|version|edit))$/;
// ADR-0017's normalization: NFKC, lower case, everything but letters and digits as spaces.
const recordingText = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const isUpload = (content, anchor = UPLOAD_ANCHOR) => {
  const text = fold(content).replace(/[|:,–—()[\]-]/g, ' ').replace(/\s+/g, ' ').trim();
  return Boolean(text) && anchor.test(text) && text.split(' ').every(word => UPLOAD_WORD.test(word.replace(/[.!]+$/, '')));
};

// Like fold(), but accents stay: "Café" and "Cafe" are different titles.
const lower = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US')
  .replace(/[’‘`´]/g, "'").replace(/[“”«»„]/g, '"').replace(/\s+/g, ' ').trim();

function recordingTitle(value) {
  let title = lower(value).split(/\s+\|\s+|\s+\/\/\s+/)[0];
  title = title.replace(BRACKETS, (whole, ...groups) => {
    const content = groups.slice(0, 4).find(group => group !== undefined) || '';
    return isUpload(content) || FEATURE.test(fold(content)) ? ' ' : whole;
  }).replace(TRAILING_FEATURE, '').replace(/\s+/g, ' ').trim();
  const words = title.split(' ');
  for (let start = 1; start < words.length; start++) {
    if (isUpload(words.slice(start).join(' '), UPLOAD_TRAILING_ANCHOR)) { title = words.slice(0, start).join(' '); break; }
  }
  return title.replace(/^["']+|["']+$/g, '').trim();
}

// The credited artist and the title without upload descriptors.
function recordingParts(reference = {}) {
  const rawTitle = String(reference.title || '');
  const rawAuthor = String(reference.author || '');
  let artist = creditedArtist(rawAuthor);
  let title = rawTitle;
  // Topic uploads and catalog entries are "Title" by "Artist"; in their titles a
  // dash part is a version. Other uploads are often "Artist - Title".
  if (!TOPIC.test(rawAuthor) && reference.sourceName !== 'spotify') {
    const [left, ...rest] = rawTitle.split(DASH);
    const right = rest.join(' - ');
    if (rest.length && compact(primaryArtist(left)) === compact(primaryArtist(artist))) title = right;
    else if (rest.length && isUpload(right)) title = left;
    else if (rest.length && compact(primaryArtist(right)) === compact(artist)) title = left;
    else if (rest.length && VERSION_ONLY.test(recordingText(recordingTitle(right)))) title = rawTitle;
    else if (rest.length) { artist = creditedArtist(left); title = right; }
  }
  return { artist, title: recordingTitle(title) };
}

/**
 * The recording a reference names, by artist and title only. Equal keys are a
 * candidate for the same recording, never proof: ADR-0017 also needs matching
 * lengths, and an audio match before two sources become one song.
 * @returns {string|null} null when the title has nothing left to compare
 */
export function recordingKey(reference) {
  const { artist, title } = recordingParts(reference);
  const artistKey = recordingText(primaryArtist(artist)).slice(0, 120);
  const titleKey = recordingText(title);
  return artistKey && titleKey ? `${artistKey}|${titleKey}`.slice(0, 200) : null;
}

/** A catalog search for the recording: "artist title", without upload descriptors. */
export function recordingQuery(reference) {
  const { artist, title } = recordingParts(reference);
  return `${primaryArtist(artist)} ${title}`.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** ADR-0017's length rule: within 3 seconds or 2% of the shorter, whichever is smaller. */
export function sameLength(a, b) {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) <= Math.min(3000, Math.min(a, b) * 0.02);
}
