import { PermissionFlagsBits, Routes } from 'discord.js';
import { plainText } from './presentation.js';

const warnedGuilds = new Set();

function warnOnce(guildId, message) {
  if (warnedGuilds.has(guildId)) return;
  warnedGuilds.add(guildId);
  console.warn(`[Voice status] ${message}`);
}

async function putStatus(client, player, status) {
  const channelId = player?.voiceChannelId;
  if (!channelId || !client?.rest?.put) return false;
  const channel = client.channels?.cache?.get(channelId);
  const permissions = channel?.permissionsFor?.(client.user);
  if (permissions && !permissions.has(PermissionFlagsBits.SetVoiceChannelStatus)) {
    warnOnce(player.guildId, `missing Set Voice Channel Status permission in guild ${player.guildId}`);
    return false;
  }
  try {
    await client.rest.put(Routes.channelVoiceStatus(channelId), { body: { status } });
    warnedGuilds.delete(player.guildId);
    return true;
  } catch (error) {
    warnOnce(player.guildId, `update failed in guild ${player.guildId}: ${error?.message || error}`);
    return false;
  }
}

export function updateVoiceStatus(client, player) {
  const track = player?.queue?.current;
  if (!track) return clearVoiceStatus(client, player);
  const prefix = player.paused ? '⏸' : '🎵';
  const title = track.info?.title || 'Unknown';
  const author = track.info?.author || 'Unknown';
  return putStatus(client, player, plainText(`${prefix} ${title} — ${author}`, { maxLength: 500 }));
}

export function clearVoiceStatus(client, player) {
  return putStatus(client, player, null);
}

export function resetVoiceStatusWarnings() {
  warnedGuilds.clear();
}
