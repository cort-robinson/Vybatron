import { createHash } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';

export const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [] });

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  let shortened = '';
  for (const character of value) {
    if (shortened.length + character.length > Math.max(0, maxLength - 1)) break;
    shortened += character;
  }
  return maxLength > 0 ? `${shortened}…` : '';
}

export function plainText(value, { fallback = 'Unknown', maxLength = 200 } = {}) {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(normalized || fallback, maxLength);
}

export function safeText(value, options = {}) {
  const { maxLength = 200 } = options;
  const neutralized = plainText(value, { ...options, maxLength: maxLength * 2 })
    .replaceAll('@', '@\u200b');
  return truncate(escapeMarkdown(neutralized), maxLength);
}

export function safeUrl(value, { maxLength = 2048 } = {}) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const normalized = url.toString();
    return normalized.length <= maxLength ? normalized : null;
  } catch {
    return null;
  }
}

export function isUrl(value) {
  return safeUrl(value) !== null;
}

export function formatDuration(ms, isStream = false) {
  if (isStream) return 'Live';
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minuteText = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${minuteText}:${String(seconds).padStart(2, '0')}`;
}

export function playbackRate(player) {
  const timescale = player?.filterManager?.data?.timescale;
  const speed = timescale?.speed ?? 1;
  const rate = timescale?.rate ?? 1;
  const combined = speed * rate;
  return Number.isFinite(combined) && combined > 0 ? combined : null;
}

export function remainingTrackDuration(player, track = player?.queue?.current) {
  const info = track?.info;
  if (!info || info.isStream || !Number.isFinite(info.duration) || info.duration <= 0) return null;
  const rate = playbackRate(player);
  if (!rate) return null;
  const position = Number.isFinite(player?.position) ? Math.max(0, player.position) : 0;
  return Math.max(0, info.duration - position) / rate;
}

export function progressBar(position, duration, segments = 14) {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  const fraction = Math.min(1, Math.max(0, position / duration));
  const count = Math.min(24, Math.max(4, Math.round(segments) || 14));
  const filled = Math.round(fraction * count);
  return `${'▰'.repeat(filled)}${'▱'.repeat(count - filled)} ${Math.round(fraction * 100)}%`;
}

export function requesterName(track) {
  const requester = track?.requester;
  if (!requester) return null;
  return plainText(
    requester.globalName || requester.displayName || requester.username || requester.tag,
    { fallback: '', maxLength: 80 }
  ) || null;
}

export function trackIdentity(track) {
  const info = track?.info || {};
  const identity = [
    info.sourceName,
    info.identifier,
    info.uri,
    info.title,
    info.author,
    info.duration,
  ].map((value) => String(value ?? '')).join(':');
  return createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}
