import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Player } from 'lavalink-client';
import { cancelSleepTimer, claimFinishedTrack } from './utils/sleep-timer.js';

export const ATTEMPT_KEY = 'vybertronPlaybackAttempt';
export const RESUME_SECONDS = 120;
const RECOVERY_PLAY = Symbol('recoveryPlay');
const playbackLocks = new WeakMap();
const destructionTasks = new WeakMap();
const playbackWriters = new AsyncLocalStorage();
const destroyingPlayers = new WeakSet();
const attachedNodes = new WeakSet();

function service(player) {
  return player?.LavalinkManager?.playbackRecovery;
}

function playerActive(player) {
  return player?.LavalinkManager?.getPlayer(player.guildId) === player
    && !destroyingPlayers.has(player) && !player.getData?.('vybertron.stopping')
    && !player.getData?.('internal_destroystatus');
}

function requireActivePlayer(player) {
  if (!playerActive(player)) throw abortError();
}

function cancelledOperation() {
  const result = Promise.reject(abortError());
  // Automatic library playback is fire-and-forget; command callers still see
  // the rejection, while cancellation cannot become a fatal runtime event.
  void result.catch(() => {});
  return result;
}

export function invalidatePlaybackRecovery(player, options = {}) {
  service(player)?.invalidate(player, { preservePassiveVoice: true, ...options });
}

export function isPlaybackRecovering(player) {
  return service(player)?.isRecovering(player) === true;
}

// Audio writes share a lane. A skip invalidates a pending retry immediately, then
// follows any request already sent to Lavalink, rather than racing its response.
function withPlaybackLock(player, action) {
  const previous = playbackLocks.get(player) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => playbackWriters.run(player, action));
  const settled = result.catch(() => {});
  playbackLocks.set(player, settled);
  void settled.then(() => {
    if (playbackLocks.get(player) === settled) playbackLocks.delete(player);
  });
  return result;
}

export class HardenedPlayer extends Player {
  play(options = {}) {
    if (!playerActive(this)) return cancelledOperation();
    const guard = options[RECOVERY_PLAY];
    if (!guard) service(this)?.invalidate(this, { newTrack: true, preservePassiveVoice: true });
    const generation = service(this)?.generation(this);
    const expectedTrack = options.clientTrack || this.queue.current || this.queue.tracks[0];
    const cleanOptions = { ...options };
    delete cleanOptions[RECOVERY_PLAY];
    const result = withPlaybackLock(this, () => {
      requireActivePlayer(this);
      if (guard && !guard()) return this;
      return super.play(cleanOptions);
    });
    // The library invokes automatic play() without awaiting it. Observe its
    // rejection while retaining the rejected promise for command callers.
    void result.catch((error) => {
      if (error.name !== 'AbortError' && !guard && this.queue.current === expectedTrack
        && service(this)?.generation(this) === generation) {
        void service(this)?.handleFailure(this, this.queue.current, {
          type: 'PlaybackRequestError', exception: { message: error.message },
        });
      }
    });
    return result;
  }

  skip(...args) {
    if (!playerActive(this)) return cancelledOperation();
    invalidatePlaybackRecovery(this);
    if (!this.playing && !this.queue.current) return this.play();
    return withPlaybackLock(this, () => {
      requireActivePlayer(this);
      return super.skip(...args);
    });
  }

  stopPlaying(...args) {
    invalidatePlaybackRecovery(this);
    return withPlaybackLock(this, () => super.stopPlaying(...args));
  }

  seek(...args) {
    if (!playerActive(this)) return cancelledOperation();
    invalidatePlaybackRecovery(this, { retryCurrent: true });
    return withPlaybackLock(this, () => {
      requireActivePlayer(this);
      return super.seek(...args);
    });
  }

  destroy(...args) {
    if (destructionTasks.has(this)) return destructionTasks.get(this);
    if (this.LavalinkManager?.getPlayer(this.guildId) !== this) return Promise.resolve(this);
    destroyingPlayers.add(this);
    // A sleep timer must not fire into a teardown that is still awaiting the
    // audio server: it would stop playback and discard the kept checkpoint.
    cancelSleepTimer(this);
    service(this)?.invalidate(this);
    const recovery = service(this);
    const result = recovery?.destroyPlayer ? recovery.destroyPlayer(this, ...args)
      : withPlaybackLock(this, () => {
        if (this.LavalinkManager?.getPlayer(this.guildId) !== this) return this;
        return super.destroy(...args);
      });
    destructionTasks.set(this, result);
    // The native library has fire-and-forget destroy callers. Keep failures
    // observable by command callers without an unhandled rejection.
    void result.then(() => destructionTasks.delete(this), () => destructionTasks.delete(this));
    return result;
  }

  connect() {
    if (!playerActive(this)) return cancelledOperation();
    const recovery = service(this);
    return recovery ? recovery.connectVoice(this, () => super.connect()) : super.connect();
  }

  changeVoiceState(data) {
    if (!playerActive(this)) return cancelledOperation();
    const recovery = service(this);
    return recovery ? recovery.connectVoice(this, () => super.changeVoiceState(data), data.voiceChannelId)
      : super.changeVoiceState(data);
  }
}

function abortError() {
  return Object.assign(new Error('Playback recovery cancelled'), { name: 'AbortError' });
}

function wait(ms, signal, timers) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = timers.setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    function cancel() {
      timers.clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function within(promise, ms, signal, timers) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      timers.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      callback(value);
    };
    const cancel = () => finish(reject, abortError());
    const timer = timers.setTimeout(() => finish(reject, new Error('Playback recovery timed out')), ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function duration(track) {
  return track?.info?.duration ?? track?.info?.length;
}

function normalized(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/\s*[-–—]\s*topic$/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function validIsrc(value) {
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/i.test(value || '');
}

export function sameRecording(original, candidate) {
  if (!original?.info || !candidate?.info || !candidate.encoded) return false;
  if (original.info.isStream || candidate.info.isStream) return false;
  const originalDuration = duration(original);
  const candidateDuration = duration(candidate);
  if (!(originalDuration > 0) || !(candidateDuration > 0)
    || Math.abs(candidateDuration - originalDuration) > Math.min(3000, originalDuration * 0.02)) return false;
  if (validIsrc(original.info.isrc)) {
    return String(original.info.isrc).toUpperCase() === String(candidate.info.isrc || '').toUpperCase();
  }
  // A direct video/SoundCloud recording is an exact request. Metadata mirrors
  // without ISRC are permitted only for providers that already mirror songs.
  if (!['spotify', 'deezer', 'applemusic', 'tidal', 'qobuz'].includes(original.info.sourceName)) return false;
  return normalized(original.info.title).length > 0
    && normalized(original.info.title) === normalized(candidate.info.title)
    && normalized(original.info.author).length > 0
    && normalized(original.info.author) === normalized(candidate.info.author);
}

export function exactTrackQuery(track) {
  const info = track?.info || {};
  if (info.sourceName === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(info.identifier || '')) {
    return `https://www.youtube.com/watch?v=${info.identifier}`;
  }
  // Preserve the provider URI instead of searching its title or reusing an
  // encoded track with potentially expired source metadata.
  try {
    const url = new URL(info.uri);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function isPermanentFailure(payload) {
  const exception = payload?.exception || payload;
  const description = `${exception?.message || ''} ${exception?.cause || ''}`;
  // Youtube's aggregate includes every client's failure. A single client's
  // login restriction alongside HTTP/stream errors does not establish that
  // the recording is unavailable; retain the bounded exact-source retry.
  if (/\bAllClientsFailedException\b|\ball clients failed to load\b/i.test(description)) return false;
  return /private video|video (?:has been |was )?(?:removed|deleted)|copyright|not available in (?:your|this) country|unavailable in (?:your|this) country|age[ -]restricted|this video requires login/i.test(description);
}

export function playbackFilters(player) {
  const manager = player?.filterManager;
  if (!manager) return undefined;
  return structuredClone({ ...manager.data, equalizer: manager.equalizerBands || [] });
}

function replacementTrack(original, candidate) {
  return { ...candidate, requester: original.requester,
    userData: { ...candidate.userData, ...original.userData },
    pluginInfo: { ...candidate.pluginInfo, clientData: { ...candidate.pluginInfo?.clientData,
      ...original.pluginInfo?.clientData } } };
}

export function createPlaybackRecovery({
  manager,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  delay = (ms, signal) => wait(ms, signal, timers),
  search = (player, query, requester) => player.search(query, requester),
  onRecovering = () => {},
  onFailed = () => {},
  onResumed = () => {},
  // A song's other verified sources (ADR-0017), best first, and where to report how one went.
  alternates = () => [],
  // Whether the song has verified sources besides this upload, cooling down or not.
  hasAlternates = () => false,
  onSourceResult = () => {},
  logger = console,
  retryDelays = [1500, 4000],
  requestTimeoutMs = 12_000,
  voiceServerGraceMs = 250,
  circuitWindowMs = 60_000,
  circuitFailures = 3,
  circuitCooldownMs = 60_000,
} = {}) {
  const states = new WeakMap();
  const circuits = new Map();
  const disconnected = new Map();
  const idleDisconnected = new Map();
  const finalizedPlayers = new WeakSet();
  const counters = { retries: 0, recovered: 0, skipped: 0, circuitTrips: 0, staleEvents: 0, voiceReconnects: 0 };

  function stateFor(player) {
    let state = states.get(player);
    if (!state) {
      state = { epoch: 0, original: null, attempts: 0, token: null, encoded: null,
        endedTokens: new Set(), failedTokens: new Set(), triedSources: new Set(), recovering: false,
        task: null, abort: null, pendingFailure: null, paused: false,
        voiceRefresh: null, voiceEpoch: 0, passiveVoiceEpoch: null,
        voiceFailures: [], voiceTask: false, requestedPaused: false };
      states.set(player, state);
    }
    return state;
  }

  function valid(player, state, epoch, track) {
    return state.epoch === epoch && playerActive(player) && player.queue.current === track;
  }

  async function destroyPlayer(player, reason, disconnect = true) {
    const owned = () => manager.getPlayer(player.guildId) === player;
    const queueTimer = player.getData('internal_queueempty');
    if (queueTimer) clearTimeout(queueTimer);
    player.setData('internal_queueempty', undefined);
    player.setData('internal_destroystatus', true);
    if (!disconnect) player.setData('internal_destroywithoutdisconnect', true);
    const leave = Promise.resolve().then(() => {
      if (disconnect && owned()) return Player.prototype.disconnect.call(player, true);
    });
    const audio = withPlaybackLock(player, async () => {
      if (!owned()) return [];
      // Queue storage and the remote DELETE are independent teardown steps.
      // Keep the old manager entry until both finish, and never launch either
      // against a replacement created while an earlier audio write awaited.
      return Promise.allSettled([
        Promise.resolve().then(() => { if (owned()) return player.queue.utils.destroy(); }),
        Promise.resolve().then(() => { if (owned()) return player.node.destroyPlayer(player.guildId); }),
      ]);
    });
    let failure;
    try {
      // One deadline includes the audio lane and all teardown requests. A hung
      // gateway/storage/REST request cannot leave a permanently dead player.
      const results = await within(Promise.allSettled([leave, audio]), requestTimeoutMs, null, timers);
      failure = [...results, ...(results[1].status === 'fulfilled' ? results[1].value : [])]
        .find((result) => result.status === 'rejected')?.reason;
    } catch (error) {
      failure = error;
    } finally {
      if (!finalizedPlayers.has(player)) {
        finalizedPlayers.add(player);
        player.connected = false;
        player.playing = false;
        player.paused = false;
        player.voice = {};
        if (owned()) manager.players.delete(player.guildId);
        manager.emit('playerDestroy', player, reason);
      }
    }
    if (failure) throw failure;
    return player;
  }

  function invalidate(player, { newTrack = false, retryCurrent = false, preservePassiveVoice = false } = {}) {
    const state = stateFor(player);
    state.epoch += 1;
    state.abort?.abort();
    state.abort = null;
    state.task = null;
    state.pendingFailure = null;
    state.recovering = false;
    if (!preservePassiveVoice || state.passiveVoiceEpoch !== state.voiceEpoch) {
      state.voiceEpoch += 1;
      state.voiceRefresh?.abort?.abort();
      state.voiceRefresh = null;
    }
    state.voiceTask = false;
    if (newTrack) {
      state.original = null;
      state.attempts = 0;
      state.failedTokens.clear();
      state.triedSources.clear();
      state.voiceFailures = [];
    } else if (retryCurrent) {
      // A deliberate seek supersedes an in-flight retry. Keep its wire token
      // fence, but allow a subsequent current-attempt stall to recover again.
      state.attempts = 0;
      state.failedTokens.delete(state.token || player.queue.current);
    }
  }

  function circuitFor(player, track = player.queue.current) {
    const key = `${player.node?.id || 'main'}:${track?.info?.sourceName || 'unknown'}`;
    let circuit = circuits.get(key);
    if (!circuit) {
      circuit = { failures: [], until: 0 };
      circuits.set(key, circuit);
    }
    circuit.failures = circuit.failures.filter((at) => now() - at < circuitWindowMs);
    return circuit;
  }

  function rememberEnd(state, token) {
    if (token) state.endedTokens.add(token);
    while (state.endedTokens.size > 32) state.endedTokens.delete(state.endedTokens.values().next().value);
  }

  function beginRequest(player, track) {
    const state = stateFor(player);
    const token = randomUUID();
    state.token = token;
    state.encoded = track.encoded || null;
    state.original ||= player.queue.current;
    track.userData = { ...track.userData, [ATTEMPT_KEY]: token };
    if (player.queue.current) {
      player.queue.current.userData = { ...player.queue.current.userData, [ATTEMPT_KEY]: token };
    }
    return token;
  }

  function acceptsEvent(player, payload) {
    const state = stateFor(player);
    const token = payload?.track?.userData?.[ATTEMPT_KEY];
    const encoded = payload?.track?.encoded;
    if (token && (token !== state.token || state.endedTokens.has(token))) return false;
    // The current attempt token identifies playback. Lavalink re-encodes the
    // live AudioTrack for events, including its current position; a seek or
    // nonzero restore therefore changes encoded without changing the attempt.
    // Missing/old tokens must still be rejected after the first stamped play.
    if (state.token) return token === state.token;
    if (encoded && state.encoded && encoded !== state.encoded) return false;
    return true;
  }

  async function candidateFor(player, original, attempt, signal) {
    if (attempt === 0) {
      const query = exactTrackQuery(original);
      if (!query) return null;
      const result = await within(search(player, { query }, original.requester), requestTimeoutMs, signal, timers);
      const candidate = result?.tracks?.find((track) => {
        if (!track?.encoded || track.info?.sourceName !== original.info?.sourceName) return false;
        return original.info?.identifier
          ? track.info.identifier === original.info.identifier
          : track.info.uri === original.info?.uri;
      });
      return candidate || null;
    }
    if (original.info?.isStream) return null;
    const enabled = player.node?.info?.sourceManagers || [];
    const sources = [
      ...(enabled.includes('soundcloud') && original.info?.sourceName !== 'soundcloud' ? ['scsearch'] : []),
      ...(enabled.includes('youtube') && original.info?.sourceName !== 'youtube' ? ['ytmsearch'] : []),
    ];
    if (!validIsrc(original.info?.isrc)
      && !['spotify', 'deezer', 'applemusic', 'tidal', 'qobuz'].includes(original.info?.sourceName)) return null;
    for (const source of sources) {
      if (signal.aborted) throw abortError();
      const query = `${original.info?.author || ''} ${original.info?.title || ''}`.trim();
      const result = await within(search(player, { query, source }, original.requester), requestTimeoutMs, signal, timers);
      const candidate = result?.tracks?.find((track) => sameRecording(original, track));
      if (candidate) return candidate;
    }
    return null;
  }

  function recoveryPosition(player, candidate, reportedPosition = player.lastPosition) {
    if (candidate.info?.isStream || candidate.info?.isSeekable === false) return 0;
    const position = Math.max(0, Number(reportedPosition) || 0);
    const length = duration(candidate);
    return length > 0 ? Math.min(position, Math.max(0, length - 1000)) : position;
  }

  async function terminal(player, failedTrack, state, epoch, payload) {
    const circuit = circuitFor(player, state.original || failedTrack);
    // Private/deleted recordings are individual availability failures rather
    // than evidence that the audio provider is experiencing an outage.
    if (!isPermanentFailure(payload)) circuit.failures.push(now());
    if (circuit.failures.length >= circuitFailures && circuit.until <= now()) {
      circuit.until = now() + circuitCooldownMs;
      counters.circuitTrips += 1;
    }
    const circuitOpen = circuit.until > now();
    let next = null;
    await withPlaybackLock(player, async () => {
      if (!valid(player, state, epoch, failedTrack)) return;
      // Consume this attempt's eventual stopped/loadFailed event. Queue changes
      // happen once below, independent of provider event ordering and loop mode.
      rememberEnd(state, state.token);
      await within(player.node.updatePlayer({ guildId: player.guildId,
        playerOptions: { track: { encoded: null }, paused: false } }), requestTimeoutMs, state.abort?.signal, timers);
      if (!valid(player, state, epoch, failedTrack)) return;
      state.recovering = false;
      player.playing = false;
      player.paused = false;
      onFailed(player, failedTrack, { circuitOpen, payload });
      if (player.queue.previous) {
        player.queue.previous.unshift(failedTrack);
        const limit = player.queue.options?.maxPreviousTracks ?? 25;
        player.queue.previous.splice(limit);
      }
      player.queue.current = null;
      if (!circuitOpen) {
        // Do not append the broken recording to a repeat queue.
        next = player.queue.tracks.shift() || null;
        player.queue.current = next;
      }
      await player.queue.utils?.save?.();
      counters.skipped += 1;
    });
    if (state.epoch !== epoch || manager.getPlayer(player.guildId) !== player) return;
    if (next) {
      try {
        await player.play({ paused: false });
      } catch (error) {
        void handleFailure(player, next, { type: 'PlaybackRequestError', exception: { message: error.message } });
      }
    } else if (!player.queue.current) {
      manager.emit('queueEnd', player, failedTrack, { type: 'TrackEndEvent', reason: 'loadFailed', recoveryCircuit: circuitOpen });
    }
  }

  async function run(player, failedTrack, payload, state, epoch, signal) {
    const original = state.original || failedTrack;
    state.original = original;
    // After a failed executor is removed, playerUpdate can report position 0
    // before its exception arrives. The accepted current-token event retains
    // the failed AudioTrack's position; snapshot it before awaiting a retry.
    const eventPosition = payload?.track?.info?.position;
    const length = duration(failedTrack);
    const failurePosition = Number.isSafeInteger(eventPosition) && eventPosition >= 0
      && Number.isFinite(length) && length > 0 && eventPosition <= length
      ? eventPosition : player.lastPosition;
    const circuit = circuitFor(player, original);
    // A song with verified sources (ADR-0017) never takes a metadata mirror: its retries stay exact.
    let verified = false;
    try { verified = Boolean(hasAlternates(original)); } catch {}
    if (!isPermanentFailure(payload) && circuit.until <= now()) {
      while (state.attempts < retryDelays.length && valid(player, state, epoch, failedTrack)) {
        const attempt = state.attempts++;
        await delay(retryDelays[attempt], signal);
        if (!valid(player, state, epoch, failedTrack)) return;
        let candidate;
        try {
          candidate = attempt > 0 && verified ? null : await candidateFor(player, original, attempt, signal);
        } catch (error) {
          if (signal.aborted || error.name === 'AbortError') return;
          continue;
        }
        if (!valid(player, state, epoch, failedTrack)) return;
        if (!candidate) continue;
        if (await replace(candidate)) return;
      }
    }
    // The recording's other verified sources, once each, before giving up on the song.
    if (circuit.until <= now() && valid(player, state, epoch, failedTrack)) {
      onSourceResult(failedTrack, false);
      for (const source of safeAlternates(original)) {
        if (source.uri === original.info?.uri || state.triedSources.has(source.uri)) continue;
        state.triedSources.add(source.uri);
        let candidate = null;
        try {
          const result = await within(search(player, { query: source.uri }, original.requester), requestTimeoutMs, signal, timers);
          candidate = result?.tracks?.find((track) => track?.encoded && track.info?.sourceName === source.sourceName
            && track.info?.identifier === source.identifier) || null;
        } catch (error) {
          if (signal.aborted || error.name === 'AbortError') return;
        }
        if (!valid(player, state, epoch, failedTrack)) return;
        if (!candidate) { onSourceResult({ info: { uri: source.uri } }, false); continue; }
        if (await replace(candidate)) return;
      }
    }
    if (valid(player, state, epoch, failedTrack)) await terminal(player, failedTrack, state, epoch, payload);

    // Plays a replacement for the failed track. True when nothing further is needed here.
    async function replace(candidate) {
      const replacement = replacementTrack(original, candidate);
      const guard = () => valid(player, state, epoch, failedTrack);
      state.paused = player.paused;
      counters.retries += 1;
      try {
        await player.play({ clientTrack: replacement, noReplace: false,
          position: recoveryPosition(player, replacement, failurePosition), paused: state.paused,
          [RECOVERY_PLAY]: guard });
        return true;
      } catch (error) {
        if (signal.aborted || error.name === 'AbortError') return true;
        // play() switches queue.current before sending its request. Keep the
        // replacement as the active failed attempt if that request failed.
        if (state.epoch === epoch && player.queue.current === replacement) {
          state.pendingFailure = { track: replacement, payload: { type: 'PlaybackRequestError' } };
          return true;
        }
        return false;
      }
    }
  }

  function safeAlternates(track) {
    try { const sources = alternates(track); return Array.isArray(sources) ? sources : []; } catch { return []; }
  }

  function handleFailure(player, track, payload = {}) {
    if (!track || !playerActive(player) || player.queue.current !== track) return Promise.resolve();
    const state = stateFor(player);
    const token = state.token || track;
    if (state.failedTokens.has(token)) return state.task || Promise.resolve();
    state.failedTokens.add(token);
    if (state.task) {
      state.pendingFailure = { track, payload };
      return state.task;
    }
    const epoch = state.epoch;
    const abort = new AbortController();
    state.abort = abort;
    state.recovering = true;
    onRecovering(player, track, { type: 'stream', attempt: state.attempts + 1 });
    const task = run(player, track, payload, state, epoch, abort.signal).catch((error) => {
      if (error.name !== 'AbortError' && state.epoch === epoch) {
        state.recovering = false;
        player.playing = false;
        onFailed(player, track, { transport: true, payload });
        logger.error('[Lavalink] playback recovery request failed.');
      }
    }).finally(() => {
      if (state.task !== task) return;
      state.task = null;
      const pending = state.pendingFailure;
      state.pendingFailure = null;
      if (pending && state.epoch === epoch) {
        state.failedTokens.delete(state.token || pending.track);
        void handleFailure(player, pending.track, pending.payload);
      }
    });
    state.task = task;
    return task;
  }

  function started(player) {
    const state = stateFor(player);
    if (state.recovering && state.attempts > 0) counters.recovered += 1;
    // The pinned client resets pause on TrackStart, which can arrive after a
    // pause request or a paused session restore. Preserve the last intent.
    player.paused = state.requestedPaused;
    player.playing = !state.requestedPaused;
    state.recovering = false;
    // Retry allowance follows the logical recording across trackStart events.
  }

  function consumeVoiceUpdate(packet) {
    if (!['VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE'].includes(packet?.t)) return false;
    const data = packet.d;
    const player = manager.getPlayer(data?.guild_id);
    if (!player) return false;
    if (!playerActive(player)) return packet.t === 'VOICE_SERVER_UPDATE';
    const state = stateFor(player);
    let pending = state.voiceRefresh;
    if (!pending) {
      if (packet.t === 'VOICE_STATE_UPDATE') {
        if (data.user_id !== manager.options.client.id || !data.channel_id) return false;
        // Self mute/deaf events carry an existing session and cannot establish
        // a fresh pair. A genuine external move can arrive state-first.
        if (data.channel_id === player.voice?.channelId && data.session_id === player.voice?.sessionId) return false;
        startPassiveVoice(player, state, data.channel_id);
      } else {
        // Hold a server-first update until the matching fresh bot state. Never
        // reuse previous credentials during an explicit join or move. An
        // established same-channel server failover may have no state event.
        const fallbackVoice = player.connected && player.voice?.sessionId
          && player.voice.channelId === player.voiceChannelId ? { ...player.voice, epoch: state.epoch } : null;
        startPassiveVoice(player, state, null, fallbackVoice);
      }
      pending = state.voiceRefresh;
    }
    if (packet.t === 'VOICE_STATE_UPDATE') {
      if (data.user_id !== manager.options.client.id) return false;
      if (!data.channel_id || (pending.channelId && data.channel_id !== pending.channelId)) {
        // A genuine kick/move/stop supersedes our reconnect request.
        invalidate(player);
        return false;
      }
      // A fresh self state wins over the same-channel failover fallback.
      pending.fallbackVoice = null;
      timers.clearTimeout(pending.serverTimer);
      pending.serverTimer = null;
      pending.channelId ||= data.channel_id;
      if (data.session_id) pending.voice.sessionId = data.session_id;
    } else {
      if (data.endpoint === null) {
        pending.allocationGone = true;
        delete pending.voice.token;
        delete pending.voice.endpoint;
        timers.clearTimeout(pending.serverTimer);
        pending.serverTimer = null;
        player.connected = false;
        player.playing = false;
        onRecovering(player, player.queue.current, { type: 'voice' });
        return true;
      }
      if (data.token && data.endpoint) {
        pending.voice.token = data.token;
        pending.voice.endpoint = data.endpoint;
        if (pending.passive && pending.fallbackVoice && !pending.serverTimer) {
          // Let a server-first move supply its new state before treating this
          // as failover of the existing voice instance. Session and generation
          // must still match when the brief coalescing window expires.
          pending.serverTimer = timers.setTimeout(() => {
            pending.serverTimer = null;
            const previous = pending.fallbackVoice;
            if (state.voiceRefresh !== pending || !previous || !playerActive(player)
              || state.epoch !== previous.epoch || player.voiceChannelId !== previous.channelId
              || player.voice?.channelId !== previous.channelId || player.voice?.sessionId !== previous.sessionId) return;
            pending.channelId = previous.channelId;
            pending.voice.sessionId = previous.sessionId;
            resolveVoicePair(player, pending);
          }, Math.min(voiceServerGraceMs, Math.max(1, Math.floor(requestTimeoutMs / 4))));
        }
      }
    }
    resolveVoicePair(player, pending);
    // Hold only server updates during refresh. Otherwise the client may PATCH
    // a new token with the previous voice session when events arrive reversed.
    return packet.t === 'VOICE_SERVER_UPDATE';
  }

  function resolveVoicePair(player, pending) {
    if (pending.channelId && pending.voice.sessionId && pending.voice.token && pending.voice.endpoint) {
      player.voice = { ...pending.voice, channelId: pending.channelId };
      pending.resolve({ ...player.voice });
    }
  }

  function voiceValid(player, state, epoch, track, passive) {
    return playerActive(player)
      && (passive || (state.epoch === epoch && (!track || player.queue.current === track)));
  }

  async function voicePair(player, state, request, { epoch = state.epoch, track, signal, channelId,
    passive = false, fallbackVoice = null } = {}) {
    if (!voiceValid(player, state, epoch, track, passive)) throw abortError();
    state.voiceEpoch += 1;
    state.passiveVoiceEpoch = passive ? state.voiceEpoch : null;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) abort.abort();
    else signal?.addEventListener('abort', cancel, { once: true });
    const pending = { channelId, voice: {}, resolve: null, abort, passive, fallbackVoice,
      serverTimer: null, allocationGone: false };
    const received = new Promise((resolve) => { pending.resolve = resolve; });
    state.voiceRefresh = pending;
    const deadline = within(received, requestTimeoutMs, abort.signal, timers);
    // Observe this promise immediately in case the gateway send rejects first.
    void deadline.catch(() => {});
    try {
      await within(Promise.resolve().then(() => {
        if (!voiceValid(player, state, epoch, track, passive) || abort.signal.aborted) throw abortError();
        return request();
      }), requestTimeoutMs, abort.signal, timers);
      const voice = await deadline;
      if (!voiceValid(player, state, epoch, track, passive)) throw abortError();
      return voice;
    } finally {
      // If sending the gateway request failed first, cancel the pair deadline
      // immediately instead of leaving its timer alive until the timeout.
      abort.abort();
      timers.clearTimeout(pending.serverTimer);
      signal?.removeEventListener('abort', cancel);
      if (state.voiceRefresh === pending) state.voiceRefresh = null;
    }
  }

  function startPassiveVoice(player, state, channelId, fallbackVoice = null) {
    const epoch = state.epoch;
    const voiceEpoch = state.voiceEpoch + 1;
    const task = voicePair(player, state, () => {}, { channelId, passive: true, fallbackVoice }).then(async (voice) => {
      await withPlaybackLock(player, async () => {
        if (state.voiceEpoch !== voiceEpoch || !voiceValid(player, state, epoch, null, true)
          || player.voiceChannelId !== voice.channelId) return;
        await within(player.node.updatePlayer({ guildId: player.guildId,
          playerOptions: { voice } }), requestTimeoutMs, null, timers);
        if (state.voiceEpoch === voiceEpoch && playerActive(player)) {
          player.paused = state.requestedPaused;
          player.playing = Boolean(player.queue.current) && !player.paused;
          onResumed(player);
        }
      });
    }).catch((error) => {
      if (error.name !== 'AbortError' && state.voiceEpoch === voiceEpoch && manager.getPlayer(player.guildId) === player) {
        player.connected = false;
        player.playing = false;
        onFailed(player, player.queue.current, { transport: true, voice: true });
      }
    }).finally(() => {
      if (state.passiveVoiceEpoch === voiceEpoch) state.passiveVoiceEpoch = null;
    });
    // The raw gateway event is not awaitable. Observe every rejection and bound
    // both incomplete gateway pairs and the eventual Lavalink voice PATCH.
    void task.catch(() => {});
  }

  async function connectVoice(player, request, channelId = player.options?.voiceChannelId || player.voiceChannelId) {
    const state = stateFor(player);
    const epoch = state.epoch;
    const voiceEpoch = state.voiceEpoch + 1;
    state.voiceRefresh?.abort?.abort();
    try {
      const voice = await voicePair(player, state, request, { epoch, channelId });
      await withPlaybackLock(player, async () => {
        if (state.voiceEpoch !== voiceEpoch || !voiceValid(player, state, epoch)) throw abortError();
        await within(player.node.updatePlayer({ guildId: player.guildId,
          playerOptions: { voice } }), requestTimeoutMs, null, timers);
      });
    } catch (error) {
      if (error.name !== 'AbortError' && state.voiceEpoch === voiceEpoch && voiceValid(player, state, epoch)) {
        player.connected = false;
        player.playing = false;
        onFailed(player, player.queue.current, { transport: true, voice: true });
      }
      throw error;
    }
    return player;
  }

  async function freshVoice(player, state, epoch, track, signal) {
    if (!valid(player, state, epoch, track) || !player.voiceChannelId) throw abortError();
    return voicePair(player, state, () => Player.prototype.connect.call(player),
      { epoch, track, signal, channelId: player.voiceChannelId });
  }

  function handleVoiceClosed(player, payload) {
    if (!player.queue.current || !playerActive(player)) return Promise.resolve();
    const state = stateFor(player);
    player.connected = false;
    if (state.voiceRefresh?.passive && state.voiceRefresh.allocationGone) return state.task || Promise.resolve();
    if (state.voiceTask || (state.voiceRefresh && !state.voiceRefresh.passive)) return state.task || Promise.resolve();
    if (![1006, 4000, 4006, 4009, 4011, 4015].includes(payload?.code)) {
      invalidate(player);
      player.playing = false;
      onFailed(player, player.queue.current, { transport: true, voice: true, payload });
      return Promise.resolve();
    }
    state.voiceFailures = state.voiceFailures.filter((at) => now() - at < circuitWindowMs);
    if (state.voiceFailures.length >= 2) {
      invalidate(player);
      player.playing = false;
      onFailed(player, player.queue.current, { transport: true, voice: true, payload });
      return Promise.resolve();
    }
    state.voiceFailures.push(now());
    invalidate(player);
    const track = player.queue.current;
    const epoch = state.epoch;
    const position = Math.max(0, Number(player.lastPosition) || 0);
    const paused = player.paused;
    const abort = new AbortController();
    state.abort = abort;
    state.recovering = true;
    state.voiceTask = true;
    state.paused = paused;
    onRecovering(player, track, { type: 'voice' });
    const task = (async () => {
      await delay(1000, abort.signal);
      if (!valid(player, state, epoch, track)) return;
      const voice = await freshVoice(player, state, epoch, track, abort.signal);
      const guard = () => valid(player, state, epoch, track);
      if (!guard()) return;
      counters.voiceReconnects += 1;
      await player.play({ clientTrack: track, position: track.info?.isStream ? 0 : position,
        paused, voice, [RECOVERY_PLAY]: guard });
    })().catch((error) => {
      if (error.name === 'AbortError' || !valid(player, state, epoch, track)) return;
      state.recovering = false;
      player.playing = false;
      onFailed(player, track, { transport: true, voice: true, payload });
    }).finally(() => {
      if (state.task === task) {
        state.task = null;
        state.voiceTask = false;
      }
    });
    state.task = task;
    return task;
  }

  function nodeDisconnected(node) {
    const snapshots = [];
    const idle = [];
    if (node.sessionId) node.options.sessionId = node.sessionId;
    for (const player of manager.players.values()) {
      if (player.node !== node) continue;
      if (!player.queue.current) {
        idle.push({ player, epoch: stateFor(player).epoch });
        continue;
      }
      const track = player.queue.current;
      const position = Math.max(0, Number(player.lastPosition) || 0);
      const paused = player.paused;
      invalidate(player);
      const state = stateFor(player);
      state.recovering = true;
      snapshots.push({ player, track, epoch: state.epoch, position, paused,
        filters: playbackFilters(player) });
      onRecovering(player, track, { type: 'node' });
    }
    disconnected.set(node.id, snapshots);
    idleDisconnected.set(node.id, idle);
  }

  async function nodeReady(node, payload) {
    node.options.sessionId = payload.sessionId;
    // The raw event precedes the library assigning node.sessionId. A microtask
    // lets its synchronous ready handler run before this REST request.
    await Promise.resolve();
    const snapshots = disconnected.get(node.id) || [];
    const idle = idleDisconnected.get(node.id) || [];
    const resetIdleVoice = (remotePlayers = null) => {
      for (const { player, epoch } of idle) {
        if (!playerActive(player) || player.node !== node || stateFor(player).epoch !== epoch
          || player.queue.current) continue;
        const remote = remotePlayers?.find((item) => item.guildId === player.guildId);
        if (remote?.state?.connected === true) continue;
        // An empty local player can outlive a Lavalink process. Its next play
        // must acquire fresh voice, while any preserved queue remains intact.
        player.connected = false;
        player.voice = {};
      }
    };
    const failSnapshots = () => {
      for (const { player, track, epoch } of snapshots) {
        const state = stateFor(player);
        if (!valid(player, state, epoch, track)) continue;
        state.recovering = false;
        player.playing = false;
        onFailed(player, track, { transport: true, voice: false });
      }
      logger.error('[Lavalink] node session reconciliation failed.');
    };
    try {
      await within(node.updateSession(true, RESUME_SECONDS), requestTimeoutMs, null, timers);
    } catch {
      failSnapshots();
      return;
    }
    disconnected.delete(node.id);
    idleDisconnected.delete(node.id);
    if (payload.resumed) {
      let remotePlayers;
      try {
        remotePlayers = await within(node.fetchAllPlayers(), requestTimeoutMs, null, timers);
        if (!Array.isArray(remotePlayers)) throw new Error('Invalid remote player response');
      } catch {
        failSnapshots();
        return;
      }
      resetIdleVoice(remotePlayers);
      for (const snapshot of snapshots) {
        const { player, track, epoch } = snapshot;
        const state = stateFor(player);
        if (!valid(player, state, epoch, track)) continue;
        const remote = remotePlayers.find((item) => item.guildId === player.guildId);
        if (!remote?.track) {
          // No buffered completion may exist after a resumed session loses a
          // player. Refresh the exact recording; never advance its queue based
          // only on an absent remote track. Real finish/stop/skip events still
          // invalidate this generation and own ordinary queue progression.
          const abort = new AbortController();
          state.abort = abort;
          let replacement;
          const guard = () => state.epoch === epoch && playerActive(player)
            && (player.queue.current === track || (replacement && player.queue.current === replacement));
          const voiceConnected = remote?.state?.connected === true;
          try {
            const candidate = await candidateFor(player, track, 0, abort.signal);
            if (!valid(player, state, epoch, track)) continue;
            if (!candidate) throw new Error('The current recording could not be refreshed');
            replacement = replacementTrack(track, candidate);
            state.paused = snapshot.paused;
            if (!voiceConnected) player.connected = false;
            const voice = voiceConnected ? undefined : await freshVoice(player, state, epoch, track, abort.signal);
            if (!guard()) continue;
            await within(player.play({ clientTrack: replacement, position: snapshot.position,
              paused: snapshot.paused, filters: snapshot.filters, ...(voice ? { voice } : {}),
              [RECOVERY_PLAY]: guard }), requestTimeoutMs, abort.signal, timers);
            if (!guard()) continue;
            state.recovering = false;
            onResumed(player);
          } catch (error) {
            if (error.name !== 'AbortError' && guard()) {
              state.recovering = false;
              player.playing = false;
              onFailed(player, player.queue.current, { transport: true, voice: false });
            }
          }
          continue;
        }
        const sameAttempt = remote.track.userData?.[ATTEMPT_KEY] === state.token;
        const voiceConnected = remote.state?.connected === true;
        if (!sameAttempt || !voiceConnected) {
          // A REST play request may have been in flight when the socket died.
          // A resumed control session also does not prove that Discord voice
          // resumed. Disconnected voice needs a new pair for either attempt.
          const guard = () => valid(player, state, epoch, track);
          const paused = sameAttempt ? remote.paused === true : snapshot.paused;
          const position = sameAttempt ? remote.state?.position ?? snapshot.position : snapshot.position;
          state.paused = paused;
          const abort = new AbortController();
          state.abort = abort;
          if (!voiceConnected) {
            player.connected = false;
            player.playing = false;
          }
          try {
            const voice = voiceConnected ? undefined : await freshVoice(player, state, epoch, track, abort.signal);
            if (guard()) await player.play({ clientTrack: track, position, paused,
              filters: snapshot.filters, ...(voice ? { voice } : {}), [RECOVERY_PLAY]: guard });
          } catch {
            if (guard()) {
              state.recovering = false;
              player.playing = false;
              onFailed(player, track, { transport: true, voice: !voiceConnected });
            }
          }
          continue;
        }
        player.lastPosition = remote.state?.position ?? snapshot.position;
        player.lastPositionChange = now();
        player.paused = remote.paused === true;
        state.requestedPaused = player.paused;
        player.playing = !player.paused;
        player.connected = remote.state?.connected === true;
        state.recovering = false;
        onResumed(player);
      }
      return;
    }
    resetIdleVoice();
    for (const snapshot of snapshots) {
      const { player, track, epoch } = snapshot;
      const state = stateFor(player);
      const guard = () => valid(player, state, epoch, track);
      if (!guard()) continue;
      state.paused = snapshot.paused;
      const abort = new AbortController();
      state.abort = abort;
      try {
        // A new Lavalink session needs a new gateway voice handshake. Discord
        // voice server tokens are transient and must not be replayed from a
        // saved snapshot; a successful session resume does not need this step.
        const voice = await freshVoice(player, state, epoch, track, abort.signal);
        if (!guard()) continue;
        await player.play({ clientTrack: track, position: snapshot.position,
          paused: snapshot.paused, filters: snapshot.filters, voice,
          [RECOVERY_PLAY]: guard });
      } catch {
        if (guard()) {
          state.recovering = false;
          player.playing = false;
          onFailed(player, track, { transport: true, voice: true });
        }
      }
    }
  }

  function attachNode(node) {
    if (attachedNodes.has(node)) return;
    if (typeof node.handleEvent !== 'function' || typeof node.updatePlayer !== 'function') {
      throw new Error('Unsupported lavalink-client event adapter; run audio contract tests before upgrading');
    }
    attachedNodes.add(node);
    const dispatch = node.handleEvent.bind(node);
    const update = node.updatePlayer.bind(node);
    node.updatePlayer = (request) => {
      const track = request.playerOptions?.track;
      const player = manager.getPlayer(request.guildId);
      const owner = playbackWriters.getStore();
      if (owner?.guildId === request.guildId && owner !== player) return cancelledOperation();
      // Native play() can await queue persistence or track resolution after
      // entering our audio lane. Recheck at its actual REST write as well.
      // Stop's null-track write remains available while the player drains.
      if ((!player || !playerActive(player)) && track?.encoded !== null) return cancelledOperation();
      if (player) {
        const state = stateFor(player);
        if (track?.encoded || track?.identifier) {
          state.requestedPaused = request.playerOptions.paused === true;
          beginRequest(player, track);
        } else if (typeof request.playerOptions?.paused === 'boolean') state.requestedPaused = request.playerOptions.paused;
      }
      return update(request);
    };
    // lavalink-client 2.10.3 shifts a stuck queue before an async event listener
    // can finish. This narrow adapter owns failure events, while the library
    // remains responsible for ordinary finishes, skips, radio, and its queue.
    node.handleEvent = async (payload) => {
      const player = manager.getPlayer(payload.guildId);
      if (!player || player.node !== node) return;
      const state = stateFor(player);
      if (/^Track(?:Start|End|Exception|Stuck)Event$/.test(payload.type)) {
        if (!acceptsEvent(player, payload)) {
          counters.staleEvents += 1;
          return;
        }
      }
      if (payload.type === 'TrackExceptionEvent' || payload.type === 'TrackStuckEvent'
        || (payload.type === 'TrackEndEvent' && payload.reason === 'loadFailed')) {
        manager.emit(payload.type === 'TrackStuckEvent' ? 'trackStuck' : 'trackError', player, player.queue.current, payload);
        return;
      }
      if (payload.type === 'TrackEndEvent' && payload.reason !== 'replaced') {
        rememberEnd(state, state.token);
        invalidate(player, { preservePassiveVoice: true });
        // Stop after this track ends the session here, before the library
        // advances to a queued track or asks autoplay for a pick.
        if (payload.reason === 'finished' && claimFinishedTrack(player)) return;
      }
      return dispatch(payload);
    };
  }

  return { invalidate, destroyPlayer, handleFailure, handleVoiceClosed, consumeVoiceUpdate, connectVoice, started, beginRequest, acceptsEvent, attachNode,
    generation: (player) => stateFor(player).epoch,
    nodeDisconnected, nodeReady, isRecovering: (player) => stateFor(player).recovering,
    summary: () => ({ ...counters, recovering: [...(manager?.players?.values() || [])]
      .filter((player) => stateFor(player).recovering).length }),
  };
}
