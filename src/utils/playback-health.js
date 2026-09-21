import { randomUUID } from 'node:crypto';

const failures = new WeakMap();
const MAX_AGE_MS = 15 * 60_000;

export function playbackHealth(client) {
  const recent = (failures.get(client) || []).filter((item) => Date.now() - item.at < MAX_AGE_MS);
  failures.set(client, recent);
  return { failures: recent.map((item) => ({ ...item })) };
}

export function recordPlaybackFailure(client, track) {
  const identifier = track?.info?.identifier;
  if (track?.info?.sourceName !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/.test(identifier || '')) return;
  const recent = playbackHealth(client).failures;
  // Only a public video ID is retained: no guild/user IDs, titles, or provider errors.
  failures.set(client, [...recent, { id: randomUUID(), at: Date.now(), identifier }].slice(-10));
}

export function recordPlaybackProgress(client, player) {
  if (!player.connected || !player.playing || player.paused || !(player.lastPosition >= 5000)) return;
  const identifier = player.queue?.current?.info?.identifier;
  if (player.queue?.current?.info?.sourceName !== 'youtube') return;
  failures.set(client, playbackHealth(client).failures.filter((item) => item.identifier !== identifier));
}
