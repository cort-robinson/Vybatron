import { autoplayActive, noteSkip, queueNextSuggestion } from './radio.js';

export async function togglePlayback(player) {
  const wasPaused = player.paused;
  if (wasPaused) await player.resume();
  else await player.pause();
  return wasPaused ? 'resumed' : 'paused';
}

// Skipping an autoplay pick counts as "less like this". With no human queue,
// the next prepared suggestion plays; otherwise autoplay may look one up.
export async function skipCurrent(player, client = null) {
  const track = player.queue.current;
  if (!track) return null;
  noteSkip(player, track);
  if (!player.queue.tracks.length && client) await queueNextSuggestion(player, client);
  if (player.queue.tracks.length > 0) await player.skip();
  else await player.stopPlaying(true, Boolean(client && autoplayActive(client, player)));
  return track;
}

export async function shuffleQueue(player) {
  if (player.queue.tracks.length < 2) return 0;
  await player.queue.shuffle();
  return player.queue.tracks.length;
}

export async function setLoopMode(player, mode) {
  if (!['off', 'track', 'queue'].includes(mode)) return null;
  await player.setRepeatMode(mode);
  return mode;
}

export function nextLoopMode(current) {
  const modes = ['off', 'track', 'queue'];
  const index = modes.indexOf(current);
  return modes[(index + 1) % modes.length];
}

export function parseSeekTimestamp(value) {
  const parts = String(value ?? '').trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  const minutes = numbers.at(-2);
  const hours = numbers.length === 3 ? numbers[0] : 0;
  if (seconds > 59 || (numbers.length === 3 && minutes > 59)) return null;

  const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
  return Number.isSafeInteger(totalSeconds) ? totalSeconds * 1000 : null;
}

const seekVersions = new WeakMap();
export function seekRevision(player) { return seekVersions.get(player) || 0; }

export async function seekToTimestamp(player, timestamp) {
  const track = player?.queue?.current;
  if (!track) return { error: 'Nothing is playing.' };
  if (track.info?.isStream || track.info?.isSeekable === false) {
    return { error: 'This track does not support seeking.' };
  }

  const position = parseSeekTimestamp(timestamp);
  if (position === null) {
    return { error: 'Enter a timestamp as mm:ss or hh:mm:ss.' };
  }

  const duration = track.info?.duration;
  if (!Number.isFinite(duration) || duration <= 0 || position >= duration) {
    return { error: 'Choose a timestamp before the track ends.' };
  }

  await player.seek(position);
  seekVersions.set(player, seekRevision(player) + 1);
  return { position, track };
}

export async function removeQueuedTrack(player, position) {
  if (!Number.isInteger(position) || position < 1 || position > player.queue.tracks.length) return null;
  return player.queue.splice(position - 1, 1);
}

export async function moveQueuedTrack(player, from, to) {
  const length = player.queue.tracks.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 1 || from > length || to < 1 || to > length || from === to) return null;
  const track = await player.queue.splice(from - 1, 1);
  await player.queue.splice(to - 1, 0, track);
  return track;
}
