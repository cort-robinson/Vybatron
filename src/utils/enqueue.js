import { LIBRARY_LIMITS } from './library.js';
import { trackIdentity } from './presentation.js';
import { searchMusic } from './search.js';
import { parseSpotifyUrl } from './spotify.js';

export async function withTimeout(promise, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The audio source took too long to respond. Try again in a moment.')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function fairOrder(tracks, currentRequesterId = null) {
  const buckets = new Map();
  for (const track of tracks) {
    const key = String(track.requester?.id || 'radio');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(track);
  }
  const keys = [...buckets.keys()];
  const currentIndex = keys.indexOf(String(currentRequesterId));
  if (currentIndex >= 0) keys.push(...keys.splice(currentIndex, 1));
  const result = [];
  while (result.length < tracks.length) {
    for (const key of keys) { const next = buckets.get(key).shift(); if (next) result.push(next); }
  }
  return result;
}

export async function enqueueTracks(client, player, tracks, { next = false, fair = true } = {}) {
  const incoming = Array.isArray(tracks) ? tracks : [tracks];
  if (!incoming.length) return 0;
  if (player.queue.tracks.length + incoming.length > LIBRARY_LIMITS.queue) throw new Error(`The queue holds at most ${LIBRARY_LIMITS.queue} upcoming tracks. Remove some tracks or add a smaller playlist.`);
  if (next) await player.queue.splice(0, 0, incoming);
  else await player.queue.add(incoming);
  if (!next && fair && client.library?.settings(player.guildId).fairQueue) {
    const ordered = fairOrder(player.queue.tracks, player.queue.current?.requester?.id);
    player.queue.tracks.splice(0, player.queue.tracks.length, ...ordered);
    await player.queue.utils?.save?.();
  }
  return incoming.length;
}

export function getOrCreatePlayer(interaction, channel) {
  const lavalink = interaction.client.lavalink;
  const existing = lavalink.getPlayer(interaction.guildId);
  if (existing?.getData?.('vybertron.stopping') === true) throw new Error('The listening session is stopping. Try /play again in a moment.');
  if (existing?.node?.connected === false || (lavalink.nodeManager?.nodes
    && ![...lavalink.nodeManager.nodes.values()].some(node => node.connected))) {
    throw new Error('No available Lavalink nodes. The audio service is reconnecting.');
  }
  if (existing) return { player: existing, created: false };
  const volume = interaction.client.library?.settings(interaction.guildId).volume ?? 100;
  return { created: true, player: lavalink.createPlayer({
    guildId: interaction.guildId, voiceChannelId: channel.id, textChannelId: interaction.channelId,
    selfDeaf: true, volume,
  }) };
}

export async function resolveReferences(player, references, requester, { limit = LIBRARY_LIMITS.mixTracks, timeoutMs = 10_000, totalTimeoutMs = 60_000 } = {}) {
  const tracks = []; const missing = [];
  // Resolve in bounded batches. A saved library never restores expired encoded
  // tracks, and an unavailable item cannot abort the entire mix.
  const selection = references.slice(0, limit);
  const deadline = Date.now() + totalTimeoutMs;
  for (let start = 0; start < selection.length; start += 4) {
    if (Date.now() >= deadline) { missing.push(...selection.slice(start)); break; }
    const results = await Promise.allSettled(selection.slice(start, start + 4).map(async ref => {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await searchMusic(player, ref.uri, requester, { timeoutMs: Math.min(timeoutMs, remaining), spotifyTimeoutMs: Math.min(timeoutMs, remaining), nativeTimeoutMs: Math.min(1500, remaining) });
      const spotify = ref.sourceName === 'spotify' ? parseSpotifyUrl(ref.uri) : null;
      const track = spotify?.type === 'track' && spotify.id === ref.identifier && result?.spotifyImport?.matchedCount === 1
        ? result.tracks[0]
        : result?.tracks?.find(t => t.info?.sourceName === ref.sourceName && (!ref.identifier || t.info?.identifier === ref.identifier));
      if (!track) throw new Error('Saved track is unavailable.');
      return track;
    }));
    results.forEach((result, offset) => {
      if (result.status === 'fulfilled') tracks.push(result.value);
      else missing.push(selection[start + offset]);
    });
  }
  return { tracks, missing };
}

export function sameCurrent(player, expected) { return Boolean(player.queue?.current && trackIdentity(player.queue.current) === expected); }
