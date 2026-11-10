import { isPlaybackRecovering, isVoiceReallocating, playbackGeneration } from '../playback-recovery.js';

// The status of one listening session, as every surface shows it: the Discord
// controller, /nowplaying, controller buttons and the portal. Read it with
// sessionStatus(); never re-derive it from player flags at a call site.
//
//   playing ⇄ paused           the current track, from the player
//   recovering                 a stream, voice or audio-service reconnect is in
//                              progress (lavalink.js onRecovering)
//   unavailable                recovery gave up; the queue is kept (onFailed,
//                              or handleQueueEnd after a failure)
//   queue-finished             nothing left to play (handleQueueEnd)
//   ended                      the session is over (requestControllerEnd)
//
// The recovery service owns "recovering": a stream, voice or audio-service
// recovery, or Discord voice being reallocated (which outlives skips and
// seeks). A controller label that says so counts only for the recovery
// generation it was set in: any skip, seek, play, stop, move or teardown starts
// a new generation, and the label lapses with it.
export const SESSION_STATUS = Object.freeze({
  PLAYING: 'playing',
  PAUSED: 'paused',
  RECOVERING: 'recovering',
  UNAVAILABLE: 'unavailable',
  QUEUE_FINISHED: 'queue-finished',
  ENDED: 'ended',
});

const STICKY = new Set([SESSION_STATUS.UNAVAILABLE, SESSION_STATUS.QUEUE_FINISHED]);

// A label to keep on a controller record: recovering is stamped with the
// generation it belongs to.
export function statusLabel(player, state) {
  return state === SESSION_STATUS.RECOVERING
    ? { state, recoveryGeneration: playbackGeneration(player) }
    : { state, recoveryGeneration: undefined };
}

// `label` is the controller record ({ state, recoveryGeneration }) or null.
export function sessionStatus(player, label = null) {
  if (isPlaybackRecovering(player) || isVoiceReallocating(player)) return SESSION_STATUS.RECOVERING;
  if (label?.state === SESSION_STATUS.RECOVERING
    && label.recoveryGeneration === playbackGeneration(player)) return SESSION_STATUS.RECOVERING;
  if (STICKY.has(label?.state)) return label.state;
  if (!player?.queue?.current) return SESSION_STATUS.QUEUE_FINISHED;
  return player.paused ? SESSION_STATUS.PAUSED : SESSION_STATUS.PLAYING;
}
