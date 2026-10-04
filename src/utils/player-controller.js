import { buildPlayerPayload } from './messages.js';
import { trackIdentity } from './presentation.js';

const controllers = new Map();
const controllerOperations = new Map();
let endedPlayers = new WeakSet();

function activePlayer(client, player) {
  if (endedPlayers.has(player) || player.getData?.('vybertron.stopping')
    || player.getData?.('internal_destroystatus')) return false;
  const manager = client.lavalink || player.LavalinkManager;
  return typeof manager?.getPlayer !== 'function' || manager.getPlayer(player.guildId) === player;
}

function ownsRecord(player, record) {
  return record?.player === player && controllers.get(player.guildId) === record;
}

function canRender(client, player, record, ending = false) {
  return ownsRecord(player, record) && (ending || activePlayer(client, player));
}

function enqueueControllerOperation(guildId, operation) {
  const previous = controllerOperations.get(guildId) || Promise.resolve();
  const current = previous.catch(() => null).then(operation);
  controllerOperations.set(guildId, current);
  return current.finally(() => {
    if (controllerOperations.get(guildId) === current) {
      controllerOperations.delete(guildId);
    }
  });
}

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

async function sendController(client, player, record, payload) {
  const channel = await resolveChannel(client, record.channelId);
  if (!channel?.send || !canRender(client, player, record)) return null;
  const message = await channel.send(payload);
  if (message?.id) record.messageId = message.id;
  return message;
}

async function renderExisting(client, player, record, payload, { replaceMissing = true, ending = false } = {}) {
  const message = await fetchControllerMessage(client, record);
  if (!canRender(client, player, record, ending)) return null;
  if (message?.edit) {
    try {
      await message.edit(payload);
      return message;
    } catch {
      if (!replaceMissing) return null;
    }
  }
  return replaceMissing ? sendController(client, player, record, payload) : null;
}

async function upsertController(client, player, {
  state = 'playing',
  track = player?.queue?.current || null,
  notice = null,
  reason = null,
} = {}) {
  if (!activePlayer(client, player)) return null;
  const existing = controllers.get(player.guildId);
  const record = existing?.player === player ? existing : {
    player,
    guildId: player.guildId,
    channelId: player.textChannelId,
    messageId: existing?.channelId === player.textChannelId ? existing.messageId : null,
    startedAt: Date.now(),
    lastTrack: null,
    lastTrackKey: null,
    notice: null,
    state,
    reason: null,
  };

  const key = track ? trackIdentity(track) : null;
  if (key && key !== record.lastTrackKey) record.startedAt = Date.now();
  if (track) {
    record.lastTrack = track;
    record.lastTrackKey = key;
  }
  record.state = state;
  record.reason = reason;
  const visibleNotice = notice || record.notice;
  const payload = buildPlayerPayload(player, {
    state,
    track,
    startedAt: record.startedAt,
    notice: visibleNotice,
    reason,
  });

  controllers.set(player.guildId, record);
  const message = record.messageId
    ? await renderExisting(client, player, record, payload)
    : await sendController(client, player, record, payload);
  if (message) record.notice = null;
  return message;
}

export async function createOrUpdate(client, player, options = {}) {
  if (!player?.guildId || !player?.textChannelId) return null;
  return enqueueControllerOperation(player.guildId, () => upsertController(client, player, options));
}

export async function refresh(client, player) {
  if (!player?.guildId) return null;
  return enqueueControllerOperation(player.guildId, async () => {
    const record = controllers.get(player.guildId);
    if (!ownsRecord(player, record) || !activePlayer(client, player)) return null;
    const state = ['recovering', 'unavailable', 'queue-finished'].includes(record.state)
      ? record.state
      : !player?.queue?.current ? 'queue-finished' : player?.paused ? 'paused' : 'playing';
    const track = state === 'queue-finished'
      ? null
      : player?.queue?.current || (['recovering', 'unavailable'].includes(state) ? record.lastTrack : null);
    const payload = buildPlayerPayload(player, {
      state,
      track,
      startedAt: record.startedAt,
      notice: record.notice,
      reason: record.reason,
    });
    const message = await renderExisting(client, player, record, payload);
    if (message) record.notice = null;
    return message;
  });
}

export async function showStatus(client, player, state, reason) {
  if (!player?.guildId || !player?.textChannelId) return null;
  return enqueueControllerOperation(player.guildId, async () => {
    if (!activePlayer(client, player)) return null;
    const record = controllers.get(player.guildId);
    if (record?.player !== player) return upsertController(client, player, { state, reason });
    record.state = state;
    record.reason = reason;
    const track = state === 'queue-finished' ? null : (player?.queue?.current || record.lastTrack);
    const payload = buildPlayerPayload(player, {
      state,
      track,
      startedAt: record.startedAt,
      notice: record.notice,
      reason,
    });
    return renderExisting(client, player, record, payload);
  });
}

export async function end(
  client,
  player,
  reason = 'Playback stopped and the bot disconnected.',
  { state = 'ended' } = {}
) {
  if (!player?.guildId) return null;
  // Fence late starts immediately, including ones waiting behind a Discord edit.
  endedPlayers.add(player);
  return enqueueControllerOperation(player.guildId, async () => {
    const record = controllers.get(player.guildId);
    if (!ownsRecord(player, record)) return null;
    const payload = buildPlayerPayload(player, {
      state,
      track: player?.queue?.current || record.lastTrack,
      startedAt: record.startedAt,
      reason,
    });
    try {
      return await renderExisting(client, player, record, payload, { replaceMissing: false, ending: true });
    } finally {
      if (ownsRecord(player, record)) controllers.delete(player.guildId);
    }
  });
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
  endedPlayers = new WeakSet();
}
