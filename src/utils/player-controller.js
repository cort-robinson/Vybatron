import { buildPlayerPayload } from './messages.js';
import { trackIdentity } from './presentation.js';
import {
  PRESENTATION_LIMITS, presentationPlayerActive, recordPresentationDrop,
  recordPresentationFailure, retirePresentationPlayer, submitPresentationWrite,
} from './presentation-updates.js';

const controllers = new Map();
let endedPlayers = new WeakSet();

function activePlayer(client, player) {
  if (endedPlayers.has(player) || player.getData?.('vybertron.stopping')
    || player.getData?.('internal_destroystatus')) return false;
  return presentationPlayerActive(client, player);
}

function ownsRecord(player, record) {
  return record?.player === player && controllers.get(player.guildId) === record;
}

function canRender(client, player, record, ending = false) {
  return ownsRecord(player, record) && (ending || activePlayer(client, player));
}

async function retirePreviousController(client, current) {
  const previous = current.previous;
  if (!previous || previous.channelId === current.channelId) return;
  // A replacement may leave an already submitted controller in another text
  // channel. Disable that one address without taking ownership from the new one.
  const ownsCleanup = () => controllers.get(current.guildId) === current && current.previous === previous;
  const channel = await resolveChannel(client, previous.channelId);
  if (!ownsCleanup()) return;
  const message = previous.messageId && channel?.messages?.fetch
    ? await channel.messages.fetch(previous.messageId).catch(() => null) : null;
  if (!ownsCleanup()) return;
  if (message?.edit) {
    try {
      await message.edit(buildPlayerPayload(previous.player, {
        state: 'ended', track: previous.lastTrack, startedAt: previous.startedAt,
        reason: 'Playback session ended.',
      }));
    } catch { recordPresentationFailure(); }
  }
  if (ownsCleanup()) current.previous = null;
}

function enqueueControllerOperation(guildId, operation, terminal = false, onRejected) {
  return submitPresentationWrite(`controller:${guildId}`, operation, { terminal, onRejected });
}

async function resolveChannel(client, channelId) {
  const cached = client.channels?.cache?.get(channelId);
  if (cached) return cached;
  if (typeof client.channels?.fetch !== 'function') return null;
  return client.channels.fetch(channelId).catch(() => null);
}

async function fetchControllerMessage(client, player, record, ending) {
  if (!record?.messageId) return null;
  const channel = await resolveChannel(client, record.channelId);
  if (!canRender(client, player, record, ending)) return null;
  if (!channel?.messages?.fetch) return null;
  return channel.messages.fetch(record.messageId).catch(() => null);
}

async function sendController(client, player, record, payload) {
  const channel = await resolveChannel(client, record.channelId);
  if (!channel?.send || !canRender(client, player, record)) return null;
  const message = await channel.send(payload());
  if (message?.id) {
    record.messageId = message.id;
    // A submitted send cannot be cancelled. Let a same-channel replacement
    // adopt its settled message before the latest render, instead of duplicating it.
    const latest = controllers.get(player.guildId);
    if (latest && latest !== record && latest.channelId === record.channelId && !latest.messageId) latest.messageId = message.id;
  }
  return message;
}

async function renderExisting(client, player, record, payload, { replaceMissing = true, ending = false } = {}) {
  const message = await fetchControllerMessage(client, player, record, ending);
  if (!canRender(client, player, record, ending)) return null;
  if (message?.edit) {
    try {
      await message.edit(payload());
      return message;
    } catch {
      recordPresentationFailure();
      if (!replaceMissing) return null;
    }
  }
  return replaceMissing ? sendController(client, player, record, payload) : null;
}

function prepareController(client, player, {
  state = 'playing',
  track = player?.queue?.current || null,
  notice = null,
  reason = null,
} = {}) {
  if (!activePlayer(client, player)) return null;
  const existing = controllers.get(player.guildId);
  if (!existing && controllers.size >= PRESENTATION_LIMITS.records) {
    recordPresentationDrop();
    return null;
  }
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
    previous: null,
  };
  if (existing && existing !== record) {
    // Carry at most one submitted previous address across a burst of replacements.
    const previous = existing.previous || existing;
    if (previous.channelId === record.channelId) {
      record.messageId ||= previous.messageId;
    } else record.previous = previous;
    existing.previous = null;
  }

  const key = track ? trackIdentity(track) : null;
  if (key && key !== record.lastTrackKey) record.startedAt = Date.now();
  if (track) {
    record.lastTrack = track;
    record.lastTrackKey = key;
  }
  record.state = state;
  record.reason = reason;
  record.notice = notice || record.notice;
  controllers.set(player.guildId, record);
  return record;
}

function currentPayload(player, record) {
  const state = ['recovering', 'unavailable', 'queue-finished'].includes(record.state)
    ? record.state
    : !player?.queue?.current ? 'queue-finished' : player.paused ? 'paused' : 'playing';
  const track = state === 'queue-finished' ? null
    : player?.queue?.current || (['recovering', 'unavailable'].includes(state) ? record.lastTrack : null);
  if (track) {
    const key = trackIdentity(track);
    if (key !== record.lastTrackKey) record.startedAt = Date.now();
    record.lastTrack = track;
    record.lastTrackKey = key;
  }
  return buildPlayerPayload(player, {
    state, track, startedAt: record.startedAt, notice: record.notice, reason: record.reason,
  });
}

async function renderCurrent(client, player, record) {
  if (!canRender(client, player, record)) return null;
  await retirePreviousController(client, record);
  if (!canRender(client, player, record)) return null;
  let renderedNotice;
  const payload = () => { renderedNotice = record.notice; return currentPayload(player, record); };
  const message = record.messageId
    ? await renderExisting(client, player, record, payload)
    : await sendController(client, player, record, payload);
  if (message && record.notice === renderedNotice) record.notice = null;
  return message;
}

// Lifecycle producers discard these synchronous submissions. All operation
// failures are observed by the scheduler; no per-event completion waiter exists.
export function requestControllerUpdate(client, player, options = {}) {
  if (!player?.guildId || !player?.textChannelId) return null;
  const record = prepareController(client, player, options);
  if (!record) return null;
  return enqueueControllerOperation(player.guildId, async () => {
    try { return await renderCurrent(client, player, record); }
    finally {
      if (!activePlayer(client, player) && !record.messageId && ownsRecord(player, record)) controllers.delete(player.guildId);
    }
  });
}

export async function createOrUpdate(client, player, options = {}) {
  const completion = requestControllerUpdate(client, player, options);
  if (!completion) return null;
  const record = controllers.get(player.guildId);
  const message = await completion;
  return canRender(client, player, record) ? message : null;
}

export async function refresh(client, player) {
  if (!player?.guildId) return null;
  const record = controllers.get(player.guildId);
  if (!canRender(client, player, record)) return null;
  const message = await enqueueControllerOperation(player.guildId, () => renderCurrent(client, player, record));
  return canRender(client, player, record) ? message : null;
}

// Web and Gateway refreshes submit without retaining an async native waiter.
export function requestControllerRefresh(client, player) {
  if (!player?.guildId) return false;
  const record = controllers.get(player.guildId);
  if (!canRender(client, player, record)) return false;
  enqueueControllerOperation(player.guildId, () => renderCurrent(client, player, record));
  return true;
}

export function requestControllerStatus(client, player, state, reason) {
  if (!player?.guildId || !player?.textChannelId) return null;
  if (!activePlayer(client, player)) return null;
  const existing = controllers.get(player.guildId);
  const record = existing?.player === player ? existing : prepareController(client, player, { state, reason });
  if (!record) return null;
  record.state = state;
  record.reason = reason;
  return enqueueControllerOperation(player.guildId, () => renderCurrent(client, player, record));
}

export async function showStatus(client, player, state, reason) {
  const completion = requestControllerStatus(client, player, state, reason);
  if (!completion) return null;
  const record = controllers.get(player.guildId);
  const message = await completion;
  return canRender(client, player, record) ? message : null;
}

export function requestControllerEnd(
  client,
  player,
  reason = 'Playback stopped and the bot disconnected.',
  { state = 'ended' } = {}
) {
  if (!player?.guildId) return null;
  // Fence late starts immediately, including ones waiting behind a Discord edit.
  endedPlayers.add(player);
  retirePresentationPlayer(player);
  const record = controllers.get(player.guildId);
  if (!ownsRecord(player, record)) return null;
  return enqueueControllerOperation(player.guildId, async () => {
    if (!ownsRecord(player, record)) return null;
    const payload = () => buildPlayerPayload(player, {
      state,
      track: player?.queue?.current || record.lastTrack,
      startedAt: record.startedAt,
      reason,
    });
    try {
      await retirePreviousController(client, record);
      return await renderExisting(client, player, record, payload, { replaceMissing: false, ending: true });
    } finally {
      if (ownsRecord(player, record)) controllers.delete(player.guildId);
    }
  }, true, () => {
    // A rejected new-key cosmetic write has no live controller writer to
    // release. Retire owned metadata now rather than inside a dropped operation.
    if (ownsRecord(player, record)) controllers.delete(player.guildId);
  });
}

// Awaiting this shared completion preserves native terminal drain semantics.
export async function end(client, player, reason, options) {
  return requestControllerEnd(client, player, reason, options);
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
