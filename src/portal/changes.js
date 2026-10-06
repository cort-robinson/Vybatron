import { randomUUID } from 'node:crypto';
import { validId } from '../utils/library.js';

// Lavalink events that can change a projected session. Queue edits, volume,
// loop and filters have no event, so a short local revision scan covers them.
const PLAYER_EVENTS = ['trackStart', 'trackEnd', 'queueEnd', 'playerCreate', 'playerDestroy', 'playerPaused', 'playerResumed',
  'playerMove', 'playerDisconnect'];

// A private wake-up feed for the portal API. Entries carry only a guild ID and
// a counter: no actor, track, channel or permission data, and never a snapshot.
// Every consumer still performs its own fresh authorized read after a wake.
export function createChangeFeed(client, revisions, { scanMs = 250, idleMs = 60_000, retained = 256, maxWaiters = 4, now = Date.now } = {}) {
  const instanceId = randomUUID();
  const entries = []; const waiters = new Set(); const known = new Map(); const pending = new Set();
  let sequence = 0; let lastConsumer = -Infinity; let closed = false; let flushQueued = false;
  const consuming = () => now() - lastConsumer < idleMs;
  const flush = () => {
    flushQueued = false;
    if (closed || !pending.size) return;
    for (const guildId of pending) {
      entries.push({ sequence: ++sequence, guildId });
      if (entries.length > retained) entries.shift();
    }
    pending.clear();
    for (const waiter of waiters) waiter();
  };
  const publish = guildId => {
    if (closed || !validId(guildId) || !consuming()) return;
    pending.add(guildId);
    // Coalesce bursts (track end + start, voice move) into one wake per guild.
    if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
  };
  const check = guildId => {
    if (closed || !validId(guildId) || !consuming()) return;
    let revision;
    try { revision = revisions.revision(guildId); } catch { return; }
    if (known.get(guildId) !== revision) publish(guildId);
    if (client.lavalink?.getPlayer?.(guildId)) known.set(guildId, revision); else known.delete(guildId);
  };
  const scan = () => {
    if (!consuming()) { known.clear(); return; }
    const ids = new Set(known.keys());
    for (const player of client.lavalink?.players?.values?.() || []) if (player?.guildId) ids.add(player.guildId);
    for (const guildId of ids) check(guildId);
  };
  const listeners = [];
  const listen = (emitter, event, handler) => { emitter?.on?.(event, handler); listeners.push([emitter, event, handler]); };
  for (const event of PLAYER_EVENTS) listen(client.lavalink, event, player => { if (player?.guildId) queueMicrotask(() => check(player.guildId)); });
  // Gateway changes that alter listeners, same-voice controls or visibility.
  // Member role edits need the privileged members intent and stay on polling.
  listen(client, 'voiceStateUpdate', (before, after) => {
    if (before?.channelId !== after?.channelId) publish(after?.guild?.id || before?.guild?.id);
  });
  for (const event of ['channelUpdate', 'channelDelete']) listen(client, event, (...channels) => publish(channels.at(-1)?.guildId));
  for (const event of ['roleCreate', 'roleUpdate', 'roleDelete']) listen(client, event, (...roles) => publish(roles.at(-1)?.guild?.id));
  listen(client, 'guildUpdate', (_before, after) => publish(after?.id));
  const timer = setInterval(scan, scanMs); timer.unref?.();

  const read = after => {
    const oldest = entries.length ? entries[0].sequence : sequence + 1;
    if (!Number.isSafeInteger(after) || after < oldest - 1 || after > sequence) return { instanceId, sequence, reset: true, guildIds: [] };
    const guildIds = [...new Set(entries.filter(entry => entry.sequence > after).map(entry => entry.guildId))];
    return { instanceId, sequence, reset: false, guildIds };
  };
  return {
    // Long poll: answer immediately with anything newer than the caller's
    // cursor, otherwise hold until a change or the bounded wait expires.
    async next({ instance, after, waitMs = 20_000, signal } = {}) {
      if (closed) return { instanceId, sequence, reset: true, guildIds: [] };
      if (!consuming()) { known.clear(); lastConsumer = now(); scan(); }
      lastConsumer = now();
      if (instance !== instanceId) return read(Number.NaN);
      const ready = read(after);
      if (ready.reset || ready.guildIds.length) return ready;
      if (waiters.size >= maxWaiters) return ready;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(deadline); waiters.delete(finish); signal?.removeEventListener('abort', finish); resolve(); };
        const deadline = setTimeout(finish, waitMs); deadline.unref?.();
        waiters.add(finish); signal?.addEventListener('abort', finish, { once: true });
      });
      lastConsumer = now();
      return read(after);
    },
    close() {
      closed = true; clearInterval(timer);
      for (const [emitter, event, handler] of listeners) emitter?.off?.(event, handler);
      for (const waiter of [...waiters]) waiter();
      entries.length = 0; known.clear(); pending.clear();
    },
  };
}
