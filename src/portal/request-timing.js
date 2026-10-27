import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request bridge timing for the portal's Server-Timing header. Only fixed
// metric names and durations leave this module: no actor, guild, channel,
// query or payload is ever recorded.
const current = new AsyncLocalStorage();
const byResponse = new WeakMap();
const ms = value => Math.max(0, value).toFixed(1);

export function startRequestTiming(response, clock = () => performance.now()) {
  const timing = { clock, start: clock(), discordMs: 0, open: 0, openedAt: 0 };
  byResponse.set(response, timing);
  return operation => current.run(timing, operation);
}

// Wall time with at least one Discord authorization read open. Overlapping
// reads (bootstrap checks several servers at once) count once, not per read.
export async function discordTime(operation) {
  const timing = current.getStore();
  if (!timing) return operation();
  if (timing.open++ === 0) timing.openedAt = timing.clock();
  try { return await operation(); }
  finally { if (--timing.open === 0) timing.discordMs += timing.clock() - timing.openedAt; }
}

export function measureDiscord(policy) {
  return { ...policy, identity: (...args) => discordTime(() => policy.identity(...args)),
    guild: (...args) => discordTime(() => policy.guild(...args)) };
}

export function serverTiming(response) {
  const timing = byResponse.get(response);
  if (!timing) return null;
  const now = timing.clock();
  const discord = timing.discordMs + (timing.open ? now - timing.openedAt : 0);
  return `bot;dur=${ms(now - timing.start)}, discord;dur=${ms(discord)}`;
}
