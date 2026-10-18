// A sleep timer ends the listening session the way an intentional Stop does.
// It is in-memory and belongs to one player: Stop, a disconnect or a restart
// discards it with the player. One timer per player; setting one replaces it.
export const SLEEP_MINUTES = Object.freeze({ min: 1, max: 720 });

const timers = new WeakMap();

function fire(player, entry) {
  timers.delete(player);
  void Promise.resolve().then(() => entry.onFire(player, entry.mode))
    .catch(() => console.error('[Sleep] Could not stop the session for a sleep timer.'));
}

// { mode: 'time', endsAt } | { mode: 'track' } | null
export function sleepTimer(player) {
  const entry = player ? timers.get(player) : null;
  if (!entry) return null;
  return entry.mode === 'track' ? { mode: 'track' } : { mode: 'time', endsAt: entry.endsAt };
}

export function validSleepMinutes(minutes) {
  return Number.isSafeInteger(minutes) && minutes >= SLEEP_MINUTES.min && minutes <= SLEEP_MINUTES.max;
}

export function setSleepTimer(player, { minutes = null, afterTrack = false, onFire, now = Date.now(), timers: clock = globalThis } = {}) {
  if (!afterTrack && !validSleepMinutes(minutes)) throw new RangeError(`Choose ${SLEEP_MINUTES.min} to ${SLEEP_MINUTES.max} minutes.`);
  cancelSleepTimer(player);
  const entry = afterTrack ? { mode: 'track', onFire } : { mode: 'time', endsAt: now + minutes * 60_000, onFire, clock };
  if (!afterTrack) {
    entry.timer = clock.setTimeout(() => { if (timers.get(player) === entry) fire(player, entry); }, minutes * 60_000);
    entry.timer?.unref?.();
  }
  timers.set(player, entry);
  return sleepTimer(player);
}

export function cancelSleepTimer(player) {
  const entry = player ? timers.get(player) : null;
  if (!entry) return false;
  if (entry.timer) entry.clock.clearTimeout(entry.timer);
  timers.delete(player);
  return true;
}

// Called for an accepted, naturally finished track before the audio library
// advances. True means the session is stopping instead: no queued track and no
// autoplay pick may start.
export function claimFinishedTrack(player) {
  const entry = player ? timers.get(player) : null;
  if (entry?.mode !== 'track') return false;
  fire(player, entry);
  return true;
}

export function sleepTimerText(timer, now = Date.now()) {
  if (!timer) return null;
  if (timer.mode === 'track') return 'Stops after this track.';
  const minutes = Math.max(1, Math.ceil((timer.endsAt - now) / 60_000));
  return `Stops in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}
