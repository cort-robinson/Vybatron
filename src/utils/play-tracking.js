import { validId } from './library.js';
import { trackIdentity } from './presentation.js';
import { isComplete, isEarlySkip } from './stats-scoring.js';

// The human who queued a track, or an unattended pick. Radio and autoplay
// queue their picks as the bot user; who was merely listening is never read.
export function requesterOf(track, botUserId) {
  const requester = track?.requester;
  if (requester?.bot === true || (botUserId && requester?.id === botUserId)) return { requesterKind: 'autoplay', requesterId: null };
  if (validId(requester?.id)) return { requesterKind: 'user', requesterId: requester.id };
  return { requesterKind: 'unknown', requesterId: null };
}

/**
 * Follows one open play per guild from track start to its end. Every entry
 * point swallows its own failures: statistics must never interrupt playback.
 *
 * End reasons: 'finished' (natural end), 'moved-on' (skip or replaced by the
 * next track), 'ended' (stop, disconnect or shutdown) and 'failed' (the source
 * could not play). Only 'moved-on' can count as an early skip.
 */
export function createPlayTracker({ stats, botUserId = () => null, now = Date.now, logger = console }) {
  const open = new Map();

  const finalize = (entry, reason) => {
    open.delete(entry.guildId);
    const at = now();
    // Server-reported position plus unpaused time since the last report,
    // bounded by both wall time and the track length.
    const estimate = entry.position + (entry.paused ? 0 : at - entry.sampledAt);
    const wall = entry.startPosition + (at - entry.startedAt);
    const durationMs = entry.handle.durationMs;
    const playedMs = Math.max(0, Math.min(estimate, wall, durationMs || Infinity));
    if (reason === 'failed' && playedMs < 30_000) return stats.finish(entry.handle, { discard: true });
    const completed = isComplete({ playedMs, durationMs, finished: reason === 'finished' });
    const skipped = reason === 'moved-on' && !completed && isEarlySkip({ playedMs, durationMs });
    stats.finish(entry.handle, { playedMs: reason === 'finished' ? durationMs : playedMs, completed, skipped });
  };

  const guard = (operation) => (...args) => {
    try { return operation(...args); } catch { logger.error('[Stats] Could not track a play.'); }
  };

  return {
    started: guard((player, track, { recovering = false } = {}) => {
      if (!validId(player?.guildId) || !track || track.info?.isStream) {
        const previous = open.get(player?.guildId);
        if (previous) finalize(previous, 'moved-on');
        return;
      }
      const identity = trackIdentity(track);
      const previous = open.get(player.guildId);
      // Recovery replays the same song (or a conservative mirror of it); it
      // continues the same play rather than starting another.
      if (previous && recovering && previous.player === player) { previous.identity = identity; previous.failed = false; return; }
      if (previous) finalize(previous, previous.failed ? 'failed' : 'moved-on');
      const handle = stats.begin({ guildId: player.guildId, voiceChannelId: player.voiceChannelId, track, ...requesterOf(track, botUserId()) });
      if (!handle) return;
      const at = now(); const startPosition = Math.max(0, Number(player.lastPosition) || 0);
      open.set(player.guildId, { guildId: player.guildId, player, identity, handle, startedAt: at, startPosition,
        position: startPosition, sampledAt: at, paused: Boolean(player.paused), failed: false });
    }),
    progress: guard((player) => {
      const entry = open.get(player?.guildId);
      if (!entry || entry.player !== player || trackIdentity(player.queue?.current) !== entry.identity) return;
      entry.position = Math.max(0, Number(player.lastPosition) || 0); entry.sampledAt = now(); entry.paused = Boolean(player.paused);
    }),
    failed: guard((player) => {
      const entry = open.get(player?.guildId);
      if (entry && entry.player === player) entry.failed = true;
    }),
    ended: guard((player, reason) => {
      const entry = open.get(player?.guildId);
      if (!entry || entry.player !== player) return;
      finalize(entry, entry.failed && reason !== 'finished' ? 'failed' : reason);
    }),
    closeAll: guard(() => { for (const entry of [...open.values()]) finalize(entry, 'ended'); }),
    openCount: () => open.size,
  };
}
