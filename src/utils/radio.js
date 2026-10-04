import { trackIdentity, plainText } from './presentation.js';
import { withTimeout, enqueueTracks } from './enqueue.js';
import { acquirePlaybackRequest } from './maintenance.js';
import { setNotice } from './player-controller.js';

const states = new WeakMap();
export function radioState(player) { return states.get(player) || { enabled: false, failures: 0 }; }

export function setRadio(player, enabled, seed = player.queue.current || player.queue.previous?.[0]) {
  const state = states.get(player) || { seen: new Set(), failures: 0, pending: false, generation: 0 };
  state.generation++;
  state.enabled = Boolean(enabled); state.seed = seed;
  player.setData?.('vybertron.radioArtist', state.enabled ? radioArtist(seed) : null);
  state.failures = 0; states.set(player, state);
  return state;
}

export function radioArtist(track) {
  return plainText(track?.info?.author, { fallback: '', maxLength: 100 }).replace(/\s*-\s*Topic$/i, '').trim();
}

export async function fillRadioQueue(player, lastTrack, client, { timeoutMs = 8000, random = Math.random } = {}) {
  const state = states.get(player);
  if (!state?.enabled || state.pending || player.queue.current || player.queue.tracks.length) return false;
  const channel = client.guilds?.cache?.get(player.guildId)?.channels?.cache?.get(player.voiceChannelId);
  if (!channel?.members || ![...channel.members.values()].some(member => !member.user.bot)) return false;
  const release = acquirePlaybackRequest(client);
  if (!release) return false;
  const generation = state.generation;
  const seed = state.seed || lastTrack;
  const artist = radioArtist(seed);
  if (!artist) { release(); return false; }
  state.pending = true;
  try {
    const recent = [lastTrack, seed, ...(player.queue.previous || [])].filter(Boolean).map(trackIdentity);
    const avoid = new Set([...state.seen, ...recent]);
    const response = await withTimeout(player.search({ query: `${artist} music`, source: 'ytmsearch' }, client.user), timeoutMs);
    if (!state.enabled || state.generation !== generation || client.lavalink.getPlayer(player.guildId) !== player || player.queue.current || player.queue.tracks.length) return false;
    const candidates = (response?.tracks || []).filter(track => {
      const info = track.info || {};
      return !avoid.has(trackIdentity(track)) && !info.isStream && info.duration >= 30_000 && info.duration <= 15 * 60_000;
    });
    if (!candidates.length) throw new Error('No fresh artist radio results.');
    const choice = candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(random() * candidates.length)))];
    const currentChannel = client.guilds?.cache?.get(player.guildId)?.channels?.cache?.get(player.voiceChannelId);
    if (!currentChannel?.members || ![...currentChannel.members.values()].some(member => !member.user.bot)) return false;
    await enqueueTracks(client, player, [{ ...choice, requester: client.user }], { fair: false });
    state.seen.add(trackIdentity(choice));
    while (state.seen.size > 100) state.seen.delete(state.seen.values().next().value);
    state.failures = 0;
    setNotice(player.guildId, `Artist radio · ${artist}. Your queued songs always take priority.`);
    return true;
  } catch {
    state.failures++;
    // A single exhausted discovery request ends the queue normally. No timer
    // keeps hammering a failed source, and user-added music can retry later.
    if (state.failures >= 3) state.enabled = false;
    setNotice(player.guildId, 'Artist radio could not find a fresh playable result. Add music with /play.');
    return false;
  } finally { state.pending = false; release(); }
}
