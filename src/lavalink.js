import { LavalinkManager } from 'lavalink-client';
import { config } from './config.js';
import { successEmbed } from './utils/embeds.js';

export const IDLE_MS = 5 * 60 * 1000;

const idleTimers = new Map();

export function startIdleTimer(player, ms = IDLE_MS) {
  clearIdleTimer(player.guildId);
  const timer = setTimeout(() => {
    idleTimers.delete(player.guildId);
    Promise.resolve(player.destroy()).catch(() => {});
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  idleTimers.set(player.guildId, timer);
}

export function clearIdleTimer(guildId) {
  const timer = idleTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(guildId);
  }
}

export function handleTrackStart(client, player, track) {
  clearIdleTimer(player.guildId);
  const channel = client.channels.cache.get(player.textChannelId);
  if (!channel) return;
  const embed = successEmbed('Now Playing', `**${track.info.title}**`);
  if (track.info.uri) embed.setURL(track.info.uri);
  if (track.info.artworkUrl) embed.setThumbnail(track.info.artworkUrl);
  channel.send({ embeds: [embed] }).catch(() => {});
}

export function handleQueueEnd(player) {
  startIdleTimer(player);
}

export function handleVoiceStateUpdate(client, oldState) {
  const player = client.lavalink?.getPlayer(oldState.guild.id);
  if (!player || !player.voiceChannelId) return;
  const channel = oldState.guild.channels.cache.get(player.voiceChannelId);
  if (!channel) return;
  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) {
    startIdleTimer(player);
  } else {
    clearIdleTimer(player.guildId);
  }
}

export function initLavalink(client) {
  const lavalink = new LavalinkManager({
    nodes: [
      {
        id: 'main',
        host: config.lavalink.host,
        port: config.lavalink.port,
        authorization: config.lavalink.password,
      },
    ],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true,
    client: { id: config.clientId, username: 'Vybertron' },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      onDisconnect: { autoReconnect: false, destroyPlayer: true },
    },
  });

  client.lavalink = lavalink;

  client.on('raw', (d) => lavalink.sendRawData(d));
  client.on('voiceStateUpdate', (oldState) => handleVoiceStateUpdate(client, oldState));

  lavalink.on('trackStart', (player, track) => handleTrackStart(client, player, track));
  lavalink.on('queueEnd', (player) => handleQueueEnd(player));
  lavalink.on('playerDestroy', (player) => clearIdleTimer(player.guildId));

  lavalink.nodeManager.on('connect', (node) => console.log(`[Lavalink] node ${node.id} connected`));
  lavalink.nodeManager.on('error', (node, err) => console.error(`[Lavalink] node ${node.id} error:`, err?.message || err));
  lavalink.nodeManager.on('disconnect', (node) => console.warn(`[Lavalink] node ${node.id} disconnected`));

  return lavalink;
}
