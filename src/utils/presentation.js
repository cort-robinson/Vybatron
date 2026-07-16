import { createHash } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';

export const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [] });

function truncate(value, maxLength) {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
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

export function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
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
