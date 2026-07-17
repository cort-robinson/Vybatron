import { ActivityType } from 'discord.js';
import { plainText } from './presentation.js';

export const PRESENCE_NAME_MAX_LENGTH = 128;

export const IDLE_PRESENCE_ACTIVITY = Object.freeze({
  name: 'Vybertron',
  state: 'Use /play to start',
  type: ActivityType.Custom,
});

const presenceControllers = new WeakMap();

function setPresence(client, activity) {
  if (typeof client?.user?.setPresence !== 'function') return false;
  client.user.setPresence({ activities: [activity], status: 'online' });
  return true;
}

function getCurrentEntry(controller) {
  const current = controller.tracks.get(controller.activeGuildId);
  if (current) return current;

  let latest = null;
  for (const entry of controller.tracks.values()) {
    if (!latest || entry.order > latest.order) latest = entry;
  }
  controller.activeGuildId = latest?.player?.guildId || null;
  return latest;
}

function buildTrackActivity(player, fallbackTrack) {
  const track = player?.queue?.current || fallbackTrack;
  if (!track) return null;

  const info = track.info || {};
  const title = plainText(info.title, {
    fallback: 'Unknown track',
    maxLength: PRESENCE_NAME_MAX_LENGTH,
  });

  return {
    name: title,
    state: plainText(info.author, { fallback: 'Unknown artist', maxLength: 128 }),
    type: ActivityType.Listening,
  };
}

function renderTrack(client, controller) {
  const entry = getCurrentEntry(controller);
  if (!entry) return false;
  const activity = buildTrackActivity(entry.player, entry.track);
  return activity ? setPresence(client, activity) : false;
}

function renderIdle(client, controller) {
  if (controller.tracks.size > 0) return false;
  return setPresence(client, IDLE_PRESENCE_ACTIVITY);
}

export function startPresence(client) {
  presenceControllers.get(client)?.stop();

  const controller = {
    activeGuildId: null,
    nextOrder: 0,
    tracks: new Map(),
    stop: () => {},
  };
  presenceControllers.set(client, controller);

  renderIdle(client, controller);

  controller.stop = () => {
    if (presenceControllers.get(client) === controller) presenceControllers.delete(client);
  };
  return controller.stop;
}

export function updateTrackPresence(client, player, track = player?.queue?.current) {
  const controller = presenceControllers.get(client);
  if (!controller || !player?.guildId || !track) return false;

  controller.nextOrder += 1;
  controller.activeGuildId = player.guildId;
  controller.tracks.set(player.guildId, {
    order: controller.nextOrder,
    player,
    track,
  });
  return renderTrack(client, controller);
}

export function clearTrackPresence(client, playerOrGuildId) {
  const controller = presenceControllers.get(client);
  const guildId = typeof playerOrGuildId === 'string'
    ? playerOrGuildId
    : playerOrGuildId?.guildId;
  if (!controller || !guildId) return false;

  const removed = controller.tracks.delete(guildId);
  if (!removed) return false;
  if (controller.activeGuildId === guildId) controller.activeGuildId = null;
  return controller.tracks.size > 0
    ? renderTrack(client, controller)
    : renderIdle(client, controller);
}
