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
