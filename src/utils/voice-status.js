import { PermissionFlagsBits, Routes } from 'discord.js';
import { plainText } from './presentation.js';
import {
  PRESENTATION_LIMITS, presentationPlayerActive, presentationWritePending,
  recordPresentationDrop, recordPresentationFailure, retirePresentationPlayer,
  submitPresentationWrite,
} from './presentation-updates.js';

const writers = new Map();
function key(guildId) { return `voice:${guildId}`; }
function currentPlayer(client, player) {
  const manager = client.lavalink || player.LavalinkManager;
  return typeof manager?.getPlayer === 'function' ? manager.getPlayer(player.guildId) : player;
}

function writer(client, player) {
  let record = writers.get(player.guildId);
  if (record) return record.client === client ? record : null;
  if (writers.size >= PRESENTATION_LIMITS.records) {
    // Completed ownership records can be forgotten; live writers cannot.
    let disposable;
    for (const guildId of writers.keys()) {
      if (!presentationWritePending(key(guildId))) { disposable = guildId; break; }
    }
    if (disposable === undefined) { recordPresentationDrop(); return null; }
    writers.delete(disposable);
  }
  record = { client, player, channelId: null, lastOwner: null, currentChannelId: player.voiceChannelId };
  writers.set(player.guildId, record);
  return record;
}

async function putStatus(client, channelId, status) {
  if (!channelId || !client?.rest?.put) return false;
  const channel = client.channels?.cache?.get(channelId);
  const permissions = channel?.permissionsFor?.(client.user);
  if (permissions && !permissions.has(PermissionFlagsBits.SetVoiceChannelStatus)) {
    recordPresentationFailure();
    return false;
  }
  try {
    await client.rest.put(Routes.channelVoiceStatus(channelId), { body: { status } });
    return true;
  } catch {
    recordPresentationFailure();
    return false;
  }
}

function liveReplacementOwns(record, player, channelId) {
  const current = currentPlayer(record.client, player);
  return current && current !== player && presentationPlayerActive(record.client, current)
    && current.voiceChannelId === channelId;
}

async function clearAddress(record, player, channelId) {
  // Check immediately before EACH submitted clear, including after an earlier
  // cleanup PUT settles. A submitted PUT itself cannot be cancelled.
  if (!channelId || liveReplacementOwns(record, player, channelId)) return false;
  const result = await putStatus(record.client, channelId, null);
  if (result && record.channelId === channelId) {
    record.channelId = null;
    record.lastOwner = null;
  }
  return result;
}

async function renderCurrent(record, player) {
  const client = record.client;
  if (record.player !== player || !presentationPlayerActive(client, player) || !player.voiceChannelId) return false;
  // Keep only the last actually submitted address and the latest current intent.
  // Repeated channel moves during a held PUT never create a cleanup backlog.
  if (record.channelId && record.channelId !== player.voiceChannelId) {
    const previous = record.channelId;
    await clearAddress(record, player, previous);
  }
  // A clear/player/channel change may have arrived while cleanup was awaiting.
  if (record.player !== player || !presentationPlayerActive(client, player) || !player.voiceChannelId) return false;
  const track = player.queue?.current;
  const status = track ? plainText(
    `${player.paused ? '⏸' : '🎵'} ${track.info?.title || 'Unknown'} — ${track.info?.author || 'Unknown'}`,
    { maxLength: 500 }
  ) : null;
  record.channelId = player.voiceChannelId;
  record.lastOwner = player;
  return putStatus(client, record.channelId, status);
}

export function updateVoiceStatus(client, player) {
  if (!presentationPlayerActive(client, player) || !player.voiceChannelId) return Promise.resolve(false);
  const record = writer(client, player);
  if (!record) return Promise.resolve(false);
  record.player = player;
  record.currentChannelId = player.voiceChannelId;
  return submitPresentationWrite(key(player.guildId), () => renderCurrent(record, player));
}

export function clearVoiceStatus(client, player) {
  if (!player?.guildId) return Promise.resolve(false);
  const current = currentPlayer(client, player);
  // Stop and destroy fence synchronously, before entering the REST writer.
  if (player.getData?.('vybertron.stopping') || player.getData?.('internal_destroystatus') || !current) {
    retirePresentationPlayer(player);
  }
  let record = writers.get(player.guildId);
  if (!record && current === player) record = writer(client, player);
  if (!record || record.client !== client || record.player !== player) return Promise.resolve(false);
  // Keep the owned current address even if destruction nulls it before drain.
  // The last ACTUALLY submitted address stays in the record, not a move backlog.
  // A later destroy callback may submit the same terminal intent after the
  // player loses its channel. Keep that one owned address through coalescing.
  const channelId = player.voiceChannelId || record.currentChannelId;
  record.currentChannelId = channelId;
  if (!record.channelId && !channelId) return Promise.resolve(false);
  if (liveReplacementOwns(record, player, record.channelId)
    && (!channelId || liveReplacementOwns(record, player, channelId))) return Promise.resolve(false);
  return submitPresentationWrite(key(player.guildId), async () => {
    const submitted = record.channelId;
    let result = await clearAddress(record, player, submitted);
    if (channelId && channelId !== submitted) {
      result = await clearAddress(record, player, channelId) || result;
    }
    if (result && record.player === player && record.currentChannelId === channelId) record.currentChannelId = null;
    return result;
  }, { terminal: true });
}

// Discord only lets a connected member clear a channel status, so a session
// that ends must clear it before leaving voice. Bounded well under a second:
// one status PUT normally settles in a few hundred milliseconds, and a held
// write never delays the disconnect, it only loses the race to it.
export const CLEAR_BEFORE_LEAVE_MS = 600;
export async function clearVoiceStatusBeforeLeaving(client, player, ms = CLEAR_BEFORE_LEAVE_MS) {
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, ms, false); });
  try {
    return await Promise.race([clearVoiceStatus(client, player), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function resetVoiceStatusWarnings() {
  // Kept for existing callers/tests. Never discard an unsettled writer fence.
  for (const guildId of writers.keys()) {
    if (!presentationWritePending(key(guildId))) writers.delete(guildId);
  }
}
