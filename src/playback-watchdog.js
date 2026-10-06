// Use reported Lavalink positions. player.position extrapolates wall-clock time
// even while the source is frozen, so it cannot establish audio progress.
export function createPlaybackWatchdog({
  onStall = () => {},
  isRecovering = () => false,
  now = Date.now,
  stallMs = 25_000,
  startupGraceMs = 35_000,
  seekGraceMs = 10_000,
  updateFreshMs = 15_000,
  intervalMs = 5000,
  timers = { setInterval, clearInterval },
} = {}) {
  const players = new Map();
  let interval = null;

  function trackStarted(player) {
    players.set(player, { track: player.queue?.current,
      token: player.queue?.current?.userData?.vybertronPlaybackAttempt,
      position: Number(player.lastPosition) || 0, startedAt: now(),
      lastProgressAt: now(), lastUpdateAt: now(), graceUntil: now() + startupGraceMs,
      samples: 0, signalled: false });
  }

  function touch(player) {
    if (!players.has(player)) return;
    const state = players.get(player);
    state.position = Number(player.lastPosition) || 0;
    state.lastProgressAt = now();
    state.graceUntil = now() + seekGraceMs;
    state.signalled = false;
  }

  function observe(player) {
    const track = player.queue?.current;
    if (!track) { players.delete(player); return false; }
    let state = players.get(player);
    if (!state || state.track !== track
      || state.token !== track.userData?.vybertronPlaybackAttempt) {
      trackStarted(player);
      state = players.get(player);
    }
    const position = Number(player.lastPosition);
    if (!Number.isFinite(position)) return false;
    state.lastUpdateAt = now();
    state.samples += 1;
    if (player.paused || !player.playing || !player.connected || player.node?.connected === false
      || player.voiceState?.serverMute || player.voiceState?.suppress || isRecovering(player)) {
      touch(player);
      return false;
    }
    let progressed = false;
    if (position < state.position - 500) {
      touch(player); // Backward seeks need a new progress baseline.
    } else if (position >= state.position + 250) {
      state.lastProgressAt = now();
      state.signalled = false;
      progressed = true;
    }
    state.position = position;
    return progressed;
  }

  function tick() {
    for (const [player, state] of players) {
      const track = player.queue?.current;
      if (!track) {
        players.delete(player);
        continue;
      }
      if (track !== state.track || track.userData?.vybertronPlaybackAttempt !== state.token) {
        trackStarted(player);
        continue;
      }
      // Live sources can report a fixed position despite outputting audio. They
      // use Lavalink's TrackStuckEvent rather than a position-based detector.
      if (track.info?.isStream || player.paused || !player.playing || !player.connected
        || player.node?.connected === false || player.voiceState?.serverMute
        || player.voiceState?.suppress || isRecovering(player)) {
        touch(player);
        continue;
      }
      const length = track.info?.duration ?? track.info?.length;
      if (length > 0 && state.position >= length - 1000) continue;
      if (state.samples < 2 || state.signalled || now() < state.graceUntil
        || now() - state.lastUpdateAt > updateFreshMs || now() - state.lastProgressAt < stallMs) continue;
      state.signalled = true;
      // A stuck source is signalled once until progress, seek, pause, or a new
      // attempt changes the baseline. Callback rejections never escape a timer.
      try { void Promise.resolve(onStall(player, track)).catch(() => {}); } catch {}
    }
  }

  function start() {
    if (interval) return;
    interval = timers.setInterval(tick, intervalMs);
    interval.unref?.();
  }

  function stop() {
    if (interval) timers.clearInterval(interval);
    interval = null;
    players.clear();
  }

  return { trackStarted, observe, touch, tick, start, stop, remove: (player) => players.delete(player) };
}
