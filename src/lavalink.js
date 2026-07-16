import { LavalinkManager } from 'lavalink-client';
import { config } from './config.js';
import {
  createOrUpdate,
  end,
  refresh,
  setNotice,
  showStatus,
} from './utils/player-controller.js';
import { plainText } from './utils/presentation.js';

export const IDLE_MS = 5 * 60 * 1000;

const idleTimers = new Map();

export function startIdleTimer(player, options = IDLE_MS) {
  const settings = typeof options === 'number' ? { ms: options } : options;
  const ms = settings.ms ?? IDLE_MS;
  const reason = settings.reason || 'queue-empty';
  const client = settings.client || null;
  clearIdleTimer(player.guildId);
  const timer = setTimeout(() => {
    idleTimers.delete(player.guildId);
    const message = reason === 'voice-empty'
      ? 'Disconnected after the voice channel stayed empty for five minutes.'
      : 'Disconnected after five minutes with an empty queue.';
    void (async () => {
      try {
        if (client) await end(client, player, message);
      } catch {
        // A controller edit must never prevent the idle disconnect.
      } finally {
        await Promise.resolve(player.destroy()).catch(() => {});
      }
    })();
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
  return createOrUpdate(client, player, { state: 'playing', track }).catch(() => null);
}

export function handleQueueEnd(clientOrPlayer, maybePlayer) {
  const client = maybePlayer ? clientOrPlayer : null;
  const player = maybePlayer || clientOrPlayer;
  if (client) {
    void showStatus(
      client,
      player,
      'queue-finished',
      'No tracks remain. Add something within five minutes to keep this session open.'
    ).catch(() => {});
  }
  startIdleTimer(player, { client, reason: 'queue-empty' });
}

export function handleVoiceStateUpdate(client, oldState) {
  const player = client.lavalink?.getPlayer(oldState.guild.id);
  if (!player || !player.voiceChannelId) return;
  const channel = oldState.guild.channels.cache.get(player.voiceChannelId);
  if (!channel) return;
  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) {
    void showStatus(
      client,
      player,
      player.paused ? 'paused' : 'playing',
      'The voice channel is empty. Disconnecting in five minutes unless someone returns.'
    ).catch(() => {});
    startIdleTimer(player, { client, reason: 'voice-empty' });
  } else {
    clearIdleTimer(player.guildId);
    void refresh(client, player).catch(() => {});
  }
}

export function handleTrackFailure(player, track) {
  const title = plainText(track?.info?.title, { fallback: 'A track', maxLength: 120 });
  setNotice(player.guildId, `Couldn’t play ${title}; skipped.`);
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

  lavalink.on('trackStart', (player, track) => void handleTrackStart(client, player, track));
  lavalink.on('trackError', (player, track) => handleTrackFailure(player, track));
  lavalink.on('trackStuck', (player, track) => handleTrackFailure(player, track));
  lavalink.on('queueEnd', (player) => handleQueueEnd(client, player));
  lavalink.on('playerDestroy', (player) => {
    clearIdleTimer(player.guildId);
    void end(client, player, 'Playback session ended.').catch(() => {});
  });

  lavalink.nodeManager.on('connect', (node) => console.log(`[Lavalink] node ${node.id} connected`));
  lavalink.nodeManager.on('error', (node, err) => console.error(`[Lavalink] node ${node.id} error:`, err?.message || err));
  lavalink.nodeManager.on('disconnect', (node) => {
    console.warn(`[Lavalink] node ${node.id} disconnected`);
    for (const player of lavalink.players.values()) {
      if (player.node?.id && player.node.id !== node.id) continue;
      void end(client, player, 'The playback service disconnected. Try /play again.', {
        state: 'unavailable',
      }).catch(() => {});
    }
  });

  return lavalink;
}
