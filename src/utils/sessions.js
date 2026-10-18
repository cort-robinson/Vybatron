import { trackReference, validId, LIBRARY_LIMITS } from './library.js';

export const SESSION_RETENTION_MS = 72 * 60 * 60_000;
// Periodic checkpoints round progress down to 30 s: a playing track then
// rewrites the library at most every 30 s instead of every 15 s tick, and a
// crash restore replays at most ~45 s (30 s step + 15 s tick) rather than
// skipping ahead. Graceful shutdown still saves the exact position.
export const SESSION_POSITION_STEP_MS = 30_000;
// Unchanged checkpoints are refreshed hourly so a long pause never ages past retention.
export const SESSION_REFRESH_MS = 60 * 60_000;

export function sessionSnapshot(player, now = Date.now(), { positionStepMs = 1 } = {}) {
  if (!validId(player?.guildId) || !validId(player.voiceChannelId) || !validId(player.textChannelId)) return null;
  const tracks = [player.queue?.current, ...(player.queue?.tracks || [])].filter(Boolean);
  const references = tracks.map(trackReference).filter(Boolean).slice(0, LIBRARY_LIMITS.queue + 1);
  if (!references.length) return null;
  // Position applies only if the current track itself could be restored.
  const hasCurrent = Boolean(trackReference(player.queue?.current));
  return {
    voiceChannelId: player.voiceChannelId, textChannelId: player.textChannelId,
    savedAt: now, tracks: references,
    position: hasCurrent && !player.queue.current.info.isStream ? Math.max(0, Math.floor((player.lastPosition ?? player.position ?? 0) / positionStepMs) * positionStepMs) : 0,
    volume: Number.isInteger(player.volume) ? Math.max(0, Math.min(100, player.volume)) : 100,
    paused: Boolean(player.paused), repeatMode: ['off', 'track', 'queue'].includes(player.repeatMode) ? player.repeatMode : 'off',
  };
}

export function savedSession(library, guildId, now = Date.now()) {
  const session = library.readGuild(guildId).session;
  if (!session || session.savedAt > now + 60_000 || now - session.savedAt > SESSION_RETENTION_MS) return null;
  return session;
}

// True when `saved` already records `snapshot` and is recent enough to keep.
export function sameSession(saved, snapshot) {
  if (!saved || saved.savedAt > snapshot.savedAt || snapshot.savedAt - saved.savedAt >= SESSION_REFRESH_MS) return false;
  return JSON.stringify({ ...saved, savedAt: 0 }) === JSON.stringify({ ...snapshot, savedAt: 0 });
}

export function attachSessionSnapshots(client, { intervalMs = 15_000, logger = console } = {}) {
  const timers = new Map();
  let stopped = false;
  const save = async (player, positionStepMs = SESSION_POSITION_STEP_MS) => {
    if (!validId(player?.guildId)) return;
    const snapshot = sessionSnapshot(player, Date.now(), { positionStepMs });
    // An outage clears library state before it emits destroy; retain the last
    // useful checkpoint until intentional stop or a genuine empty queue.
    if (!snapshot) return;
    await client.library.updateGuild(player.guildId, guild => { guild.session = snapshot; },
      { skip: guild => sameSession(guild?.session, snapshot) });
  };
  const schedule = (player) => {
    if (stopped || !player?.guildId || timers.has(player.guildId)) return;
    const timer = setTimeout(() => {
      timers.delete(player.guildId);
      void save(player).catch(() => logger.error('[Library] Could not save a session checkpoint.'));
    }, 500);
    timer.unref?.(); timers.set(player.guildId, timer);
  };
  const clearSession = (player) => {
    const timer = timers.get(player.guildId);
    if (timer) clearTimeout(timer);
    timers.delete(player.guildId);
    if (!validId(player.guildId) || client.runtimeState?.draining) return;
    void client.library.updateGuild(player.guildId, guild => { guild.session = null; }, { skip: guild => !guild?.session })
      .catch(() => logger.error('[Library] Could not clear a session checkpoint.'));
  };
  const onDestroy = (player, reason) => {
    const timer = timers.get(player.guildId);
    if (timer) clearTimeout(timer);
    timers.delete(player.guildId);
    if (/node|disconnect|shutdown/i.test(String(reason || ''))) return;
    clearSession(player);
  };
  const onQueueEnd = (player) => { if (player.queue?.tracks?.length) schedule(player); else clearSession(player); };
  const events = [['trackStart', schedule], ['playerClientUpdate', (_old, player) => schedule(player)], ['queueEnd', onQueueEnd], ['playerDestroy', onDestroy]];
  for (const [name, handler] of events) client.lavalink.on(name, handler);
  const interval = setInterval(() => {
    for (const player of client.lavalink.players.values()) schedule(player);
  }, intervalMs);
  interval.unref?.();
  return async () => {
    if (stopped) return;
    stopped = true; clearInterval(interval);
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const [name, handler] of events) client.lavalink.off(name, handler);
    await Promise.all([...client.lavalink.players.values()].map(player => save(player, 1)));
  };
}
