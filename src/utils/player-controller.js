import { buildPlayerPayload } from './messages.js';
import { trackIdentity } from './presentation.js';

const controllers = new Map();

async function resolveChannel(client, channelId) {
  const cached = client.channels?.cache?.get(channelId);
  if (cached) return cached;
  if (typeof client.channels?.fetch !== 'function') return null;
  return client.channels.fetch(channelId).catch(() => null);
}

async function fetchControllerMessage(client, record) {
  if (!record?.messageId) return null;
  const channel = await resolveChannel(client, record.channelId);
  if (!channel?.messages?.fetch) return null;
  return channel.messages.fetch(record.messageId).catch(() => null);
}

async function sendController(client, record, payload) {
  const channel = await resolveChannel(client, record.channelId);
  if (!channel?.send) return null;
  const message = await channel.send(payload);
  if (message?.id) record.messageId = message.id;
  return message;
}

async function renderExisting(client, player, record, payload, { replaceMissing = true } = {}) {
  const message = await fetchControllerMessage(client, record);
  if (message?.edit) {
    try {
      await message.edit(payload);
      return message;
    } catch {
      if (!replaceMissing) return null;
    }
  }
  return replaceMissing ? sendController(client, record, payload) : null;
}

export async function createOrUpdate(client, player, {
  state = 'playing',
  track = player?.queue?.current || null,
  notice = null,
} = {}) {
  if (!player?.guildId || !player?.textChannelId) return null;
  const existing = controllers.get(player.guildId);
  const record = existing || {
    guildId: player.guildId,
    channelId: player.textChannelId,
    messageId: null,
    startedAt: Date.now(),
    lastTrack: null,
    lastTrackKey: null,
    notice: null,
  };

  const key = track ? trackIdentity(track) : null;
  if (key && key !== record.lastTrackKey) record.startedAt = Date.now();
  if (track) {
    record.lastTrack = track;
    record.lastTrackKey = key;
  }
  const visibleNotice = notice || record.notice;
  const payload = buildPlayerPayload(player, {
    state,
    track,
    startedAt: record.startedAt,
    notice: visibleNotice,
  });

  controllers.set(player.guildId, record);
  const message = record.messageId
    ? await renderExisting(client, player, record, payload)
    : await sendController(client, record, payload);
  if (message) record.notice = null;
  return message;
}

export async function refresh(client, player) {
  const record = controllers.get(player?.guildId);
  if (!record) return null;
  const track = player?.queue?.current || record.lastTrack;
  const payload = buildPlayerPayload(player, {
    state: player?.paused ? 'paused' : 'playing',
    track,
    startedAt: record.startedAt,
    notice: record.notice,
  });
  const message = await renderExisting(client, player, record, payload);
  if (message) record.notice = null;
  return message;
}

export async function showStatus(client, player, state, reason) {
  const record = controllers.get(player?.guildId);
  if (!record) return null;
  const track = state === 'queue-finished' ? null : (player?.queue?.current || record.lastTrack);
  const payload = buildPlayerPayload(player, {
    state,
    track,
    startedAt: record.startedAt,
    notice: record.notice,
    reason,
  });
  return renderExisting(client, player, record, payload);
}

export async function end(
  client,
  player,
  reason = 'Playback stopped and the bot disconnected.',
  { state = 'ended' } = {}
) {
  const record = controllers.get(player?.guildId);
  if (!record) return null;
  const payload = buildPlayerPayload(player, {
    state,
    track: player?.queue?.current || record.lastTrack,
    startedAt: record.startedAt,
    reason,
  });
  try {
    return await renderExisting(client, player, record, payload, { replaceMissing: false });
  } finally {
    controllers.delete(player.guildId);
  }
}

export function setNotice(guildId, notice) {
  const record = controllers.get(guildId);
  if (record) record.notice = notice;
}

export function getMessageLink(guildId) {
  const record = controllers.get(guildId);
  if (!record?.messageId) return null;
  return `https://discord.com/channels/${record.guildId}/${record.channelId}/${record.messageId}`;
}

export function withControllerLink(content, interaction, player) {
  const link = getMessageLink(interaction?.guildId);
  if (!link || player?.textChannelId === interaction?.channelId) return content;
  return `${content} Open player: ${link}`;
}

export function getControllerRecord(guildId) {
  return controllers.get(guildId) || null;
}

export function clearController(guildId) {
  controllers.delete(guildId);
}

export function resetControllers() {
  controllers.clear();
}
