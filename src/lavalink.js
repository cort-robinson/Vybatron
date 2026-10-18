import { LavalinkManager } from 'lavalink-client';
import { config } from './config.js';
import {
  requestControllerUpdate,
  requestControllerEnd,
  requestControllerRefresh,
  setNotice,
  requestControllerStatus,
} from './utils/player-controller.js';
import { plainText } from './utils/presentation.js';
import { clearTrackPresence, updateTrackPresence } from './utils/presence.js';
import { clearVoiceStatus, clearVoiceStatusBeforeLeaving, updateVoiceStatus } from './utils/voice-status.js';
import { recordPlaybackFailure, recordPlaybackProgress } from './utils/playback-health.js';
import { fillRadioQueue, refreshSuggestions } from './utils/radio.js';
import {
  createPlaybackRecovery,
  HardenedPlayer,
  isPlaybackRecovering,
} from './playback-recovery.js';
import { createPlaybackWatchdog } from './playback-watchdog.js';
import { retirePresentationPlayer } from './utils/presentation-updates.js';
import { LIBRARY_LIMITS } from './utils/library.js';
import { cancelSleepTimer } from './utils/sleep-timer.js';

export const IDLE_MS = 5 * 60 * 1000;
// A short grace covers a listener's reconnect blip without holding an empty room open.
export const VOICE_EMPTY_MS = 60 * 1000;

const idleTimers = new Map();
const playbackFailures = new WeakMap();

export function startIdleTimer(player, options = IDLE_MS) {
  const settings = typeof options === 'number' ? { ms: options } : options;
  const reason = settings.reason || 'queue-empty';
  const ms = settings.ms ?? (reason === 'voice-empty' ? VOICE_EMPTY_MS : IDLE_MS);
  const client = settings.client || null;
  clearIdleTimer(player.guildId);
  const timer = setTimeout(() => {
    idleTimers.delete(player.guildId);
    // This disconnect keeps the checkpoint. A sleep timer firing while the
    // voice status clears would stop the session and discard it instead.
    cancelSleepTimer(player);
    retirePresentationPlayer(player);
    const message = reason === 'voice-empty'
      ? 'Left the voice channel because everyone else left.'
      : reason === 'audio-unavailable'
        ? 'Disconnected after five minutes without playable audio. Use /session resume to recover your saved queue.'
        : 'Disconnected after five minutes with an empty queue.';
    void (async () => {
      try {
        if (client) requestControllerEnd(client, player, message);
        // Discord rejects a status clear once the bot has left the channel.
        if (client) await clearVoiceStatusBeforeLeaving(client, player);
      } catch {
        // A controller edit must never prevent the idle disconnect.
      } finally {
        await Promise.resolve(player.destroy(`${reason}-disconnect`)).catch(() => {});
      }
    })();
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  idleTimers.set(player.guildId, { timer, reason, player });
}

export function clearIdleTimer(guildId) {
  const entry = idleTimers.get(guildId);
  if (entry) {
    clearTimeout(entry.timer);
    idleTimers.delete(guildId);
  }
}

function clearQueueIdleTimer(player) {
  if (idleTimers.get(player.guildId)?.reason !== 'voice-empty') clearIdleTimer(player.guildId);
}

export async function handleTrackStart(client, player, track) {
  // Public references only. A history disk failure must never interrupt audio.
  void client.library?.recordHistory?.(player, track || player.queue?.current)?.catch(() => console.error('[Library] Could not save playback history.'));
  // Play statistics are batched and self-contained; they cannot throw here.
  client.playTracker?.started(player, track || player.queue?.current, { recovering: isPlaybackRecovering(player) });
  client.lavalink?.playbackRecovery?.started(player);
  client.lavalink?.playbackWatchdog?.trackStarted(player);
  playbackFailures.delete(player);
  clearQueueIdleTimer(player);
  updateTrackPresence(client, player, track);
  requestControllerUpdate(client, player, { state: player.paused ? 'paused' : 'playing', track });
  updateVoiceStatus(client, player);
}

// Lavalink end reasons mapped to play-statistics outcomes. A skip arrives as
// stopped (next track queued) or replaced; neither counts while recovering.
export function endReason(payload, otherwise = 'moved-on') {
  if (payload?.reason === 'finished') return 'finished';
  if (payload?.reason === 'loadFailed') return 'failed';
  if (payload?.reason === 'cleanup') return 'ended';
  return otherwise;
}

export function handleTrackEnd(client, player, payload) {
  if (payload?.reason === 'replaced' && isPlaybackRecovering(player)) return;
  client.playTracker?.ended(player, endReason(payload));
}

export function handleQueueEnd(clientOrPlayer, maybePlayer) {
  const client = maybePlayer ? clientOrPlayer : null;
  const player = maybePlayer || clientOrPlayer;
  if (isPlaybackRecovering(player) || player.queue?.current) return;
  if (client) {
    clearTrackPresence(client, player);
    clearVoiceStatus(client, player);
    requestControllerStatus(
      client,
      player,
      playbackFailures.has(player) ? 'unavailable' : 'queue-finished',
      playbackFailures.has(player)
        ? player.queue?.tracks?.length
          ? 'The audio source is temporarily unavailable. Your remaining queue is safe; use /play to retry when it recovers.'
          : 'The audio source rejected playback after recovery. Try /play again, or choose another result.'
        : 'No tracks remain. Add something within five minutes to keep this session open.'
    );
  }
  if (!idleTimers.has(player.guildId)) {
    startIdleTimer(player, { client, reason: player.queue?.tracks?.length ? 'audio-unavailable' : 'queue-empty' });
  }
}

export function handleVoiceStateUpdate(client, oldState, channelId) {
  const player = client.lavalink?.getPlayer(oldState.guild.id);
  const voiceChannelId = channelId || player?.voiceChannelId;
  if (!player || !voiceChannelId) return;
  const channel = oldState.guild.channels.cache.get(voiceChannelId);
  if (!channel) return;
  const humans = channel.members.filter((m) => !m.user.bot);
  if (humans.size === 0) {
    requestControllerStatus(
      client,
      player,
      isPlaybackRecovering(player) ? 'recovering'
        : player.queue?.current ? player.paused ? 'paused' : 'playing'
          : playbackFailures.has(player) ? 'unavailable' : 'queue-finished',
      'Everyone left the voice channel. Leaving in one minute unless someone returns.'
    );
    if (idleTimers.get(player.guildId)?.reason !== 'voice-empty') {
      startIdleTimer(player, { client, reason: 'voice-empty' });
    }
  } else {
    if (idleTimers.get(player.guildId)?.reason === 'voice-empty') clearIdleTimer(player.guildId);
    if (!player.queue?.current && !isPlaybackRecovering(player) && !idleTimers.has(player.guildId)) {
      handleQueueEnd(client, player);
    }
    requestControllerRefresh(client, player);
  }
}

export function handleTrackFailure(player, track, { skipped = true } = {}) {
  playbackFailures.set(player, true);
  const title = plainText(track?.info?.title, { fallback: 'A track', maxLength: 120 });
  setNotice(player.guildId, skipped
    ? `Couldn’t play ${title}; skipped.`
    : `Audio unavailable for ${title}. Your queue is preserved.`);
}

export async function handleTrackError(player, track, payload, logger = console) {
  if (player.LavalinkManager?.playbackRecovery
    && (['TrackExceptionEvent', 'TrackStuckEvent'].includes(payload?.type)
      || payload?.reason === 'loadFailed')) {
    await player.LavalinkManager.playbackRecovery.handleFailure(player, track, payload);
    return;
  }
  handleTrackFailure(player, track);
  if (payload?.type !== 'TrackExceptionEvent') return;
  try {
    await player.skip(0, false);
  } catch (error) {
    logger.error('[Lavalink] failed to advance after a track error.');
  }
}

export function handlePlayerDestroy(client, player) {
  // A sleep timer belongs to its player and ends with it.
  cancelSleepTimer(player);
  client.playTracker?.ended(player, 'ended');
  const lavalink = client.lavalink;
  lavalink.playbackRecovery?.invalidate(player);
  lavalink.playbackWatchdog?.remove(player);
  // Remote teardown can finish after a new listening session takes ownership.
  // Its lifecycle event still cleans up the old watcher, but keeps new controls.
  const current = lavalink.getPlayer(player.guildId);
  if (current && current !== player) return;
  clearIdleTimer(player.guildId);
  clearTrackPresence(client, player);
  clearVoiceStatus(client, player);
  requestControllerEnd(client, player, 'Playback session ended.');
}

export function initLavalink(client) {
  const lavalink = new LavalinkManager({
    nodes: [
      {
        id: 'main',
        host: config.lavalink.host,
        port: config.lavalink.port,
        authorization: config.lavalink.password,
        // The audio service may take longer than five attempts to recover.
        retryAmount: Infinity,
        retryDelay: 10_000,
      },
    ],
    sendToShard: (guildId, payload) => client.guilds.cache.get(guildId)?.shard?.send(payload),
    autoSkip: true,
    autoSkipOnResolveError: true,
    client: { id: config.clientId, username: 'Vybatron' },
    playerClass: HardenedPlayer,
    // Session history backs /history, /replay, and Back; it ends with the player.
    queueOptions: { maxPreviousTracks: LIBRARY_LIMITS.history },
    playerOptions: {
      defaultSearchPlatform: 'ytsearch',
      maxErrorsPerTime: { threshold: 30_000, maxAmount: 3 },
      onDisconnect: { autoReconnect: false, destroyPlayer: true },
      onEmptyQueue: {
        autoPlayFunction: async (player, lastTrack) => {
          try { await fillRadioQueue(player, lastTrack, client); } catch (error) {
            console.error('[Lavalink] autoplay lookup failed.');
          }
        },
      },
    },
  });

  client.lavalink = lavalink;

  const recovery = createPlaybackRecovery({
    manager: lavalink,
    onRecovering: (player, _track, details) => {
      clearQueueIdleTimer(player);
      clearTrackPresence(client, player);
      requestControllerStatus(client, player, 'recovering', details.type === 'node'
        ? 'Reconnecting to the audio service. Your queue and playback position are safe.'
        : details.type === 'voice'
          ? 'Reconnecting to Discord voice. Keeping your queue and track position.'
        : 'Reconnecting the audio stream. Keeping your queue and track position.');
    },
    onFailed: (player, track, details) => {
      handleTrackFailure(player, track, { skipped: !details.transport });
      if (details.transport) {
        clearTrackPresence(client, player);
        requestControllerStatus(client, player, 'unavailable',
          details.voice
            ? 'Discord voice could not reconnect. Your queue is preserved; try /play again or restore it with /session.'
            : 'The audio service could not recover. Your queue is safe; try /play again.');
      }
    },
    onResumed: (player) => {
      lavalink.playbackWatchdog.touch(player);
      updateTrackPresence(client, player);
      requestControllerUpdate(client, player, { state: player.paused ? 'paused' : 'playing' });
      updateVoiceStatus(client, player);
    },
  });
  lavalink.playbackRecovery = recovery;
  lavalink.playbackWatchdog = createPlaybackWatchdog({
    isRecovering: recovery.isRecovering,
    onStall: (player, track) => {
      recordPlaybackFailure(client, track);
      return recovery.handleFailure(player, track, { type: 'WatchdogStall' });
    },
  });
  lavalink.playbackWatchdog.start();
  for (const node of lavalink.nodeManager.nodes.values()) recovery.attachNode(node);
  lavalink.nodeManager.on('create', (node) => recovery.attachNode(node));
  lavalink.nodeManager.on('raw', (node, payload) => {
    if (payload.op === 'ready') {
      void recovery.nodeReady(node, payload).catch(() => {
        console.error(`[Lavalink] node ${node.id} session recovery failed.`);
      });
    }
  });

  client.on('raw', (d) => {
    if (recovery.consumeVoiceUpdate(d)) return;
    void lavalink.sendRawData(d).catch(() => {
      console.error('[Lavalink] Discord voice update failed.');
    });
  });
  client.on('voiceStateUpdate', (oldState) => handleVoiceStateUpdate(client, oldState));

  lavalink.on('trackStart', (player, track) => {
    void handleTrackStart(client, player, track);
    // Prepare autoplay picks near the end of the human queue. Bounded, and a
    // failed lookup can never affect the track that just started.
    void refreshSuggestions(player, client).catch(() => console.error('[Lavalink] autoplay lookup failed.'));
  });
  lavalink.on('playerUpdate', (_previous, player) => {
    if (lavalink.playbackWatchdog.observe(player)) recordPlaybackProgress(client, player);
    client.playTracker?.progress(player);
  });
  lavalink.on('playerClientUpdate', (previous, player) => {
    if (previous?.paused !== player.paused || previous?.lastPosition !== player.lastPosition) {
      lavalink.playbackWatchdog.touch(player);
      client.playTracker?.progress(player);
    }
  });
  lavalink.on('playerSocketClosed', (player, payload) => { void recovery.handleVoiceClosed(player, payload); });
  lavalink.on('trackError', (player, track, payload) => {
    recordPlaybackFailure(client, track);
    client.playTracker?.failed(player);
    void handleTrackError(player, track, payload);
  });
  lavalink.on('trackStuck', (player, track, payload) => {
    recordPlaybackFailure(client, track);
    client.playTracker?.failed(player);
    void handleTrackError(player, track, payload);
  });
  // Being moved into an empty channel has no listener event of its own.
  lavalink.on('playerMove', (player, _from, to) => {
    const guild = client.guilds.cache.get(player.guildId);
    if (guild) handleVoiceStateUpdate(client, { guild }, to);
  });
  lavalink.on('trackEnd', (player, _track, payload) => handleTrackEnd(client, player, payload));
  lavalink.on('queueEnd', (player, _track, payload) => {
    client.playTracker?.ended(player, endReason(payload, 'ended'));
    handleQueueEnd(client, player);
  });
  lavalink.on('playerDestroy', (player) => handlePlayerDestroy(client, player));

  lavalink.nodeManager.on('connect', (node) => console.log(`[Lavalink] node ${node.id} connected`));
  lavalink.nodeManager.on('error', (node) => console.error(`[Lavalink] node ${node.id} connection error.`));
  lavalink.nodeManager.on('disconnect', (node) => {
    console.warn(`[Lavalink] node ${node.id} disconnected`);
    recovery.nodeDisconnected(node);
  });

  return lavalink;
}
