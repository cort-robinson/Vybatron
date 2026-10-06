import { AsyncLocalStorage } from 'node:async_hooks';

const active = new AsyncLocalStorage();
const commands = new Set(['pause', 'resume', 'seek', 'filter', 'volume']);
const stages = new Set(['authorization', 'playback', 'presentation']);
const rounded = value => Math.max(0, Math.round(value));

// Fixed labels and numeric timings only. No request, actor, guild, track,
// permission, query, payload or error objects are retained in the ring.
export function createCommandTimings({ clock = () => performance.now(), wallClock = () => Date.now() } = {}) {
  const records = []; let closed = false;
  const prune = () => {
    const cutoff = wallClock() - 15 * 60_000;
    while (records.length && records[0].at < cutoff) records.shift();
  };
  return {
    async run(command, operation) {
      if (closed || !commands.has(command)) return operation();
      const start = clock();
      const trace = { clock, start, readyMs: null, authorization: { count: 0, ms: 0 }, playback: { count: 0, ms: 0 }, presentation: { count: 0, ms: 0 } };
      let success = false;
      try { return await active.run(trace, async () => { const result = await operation(); success = true; return result; }); }
      finally {
        if (!closed) {
          prune();
          records.push({ at: wallClock(), command, success, totalMs: rounded(clock() - start),
            readyForMutationMs: trace.readyMs, ...Object.fromEntries([...stages].map(stage => [stage, { count: trace[stage].count, ms: rounded(trace[stage].ms) }])) });
          if (records.length > 32) records.shift();
        }
      }
    },
    snapshot() { prune(); return { retentionSeconds: 900, capacity: 32, records: structuredClone(records) }; },
    close() { closed = true; records.length = 0; },
  };
}

export async function commandTimingSpan(stage, operation) {
  const trace = active.getStore();
  if (!trace || !stages.has(stage)) return operation();
  if (stage === 'playback') commandReadyForMutation();
  const start = trace.clock(); trace[stage].count++;
  try { return await operation(); }
  finally { trace[stage].ms += Math.max(0, trace.clock() - start); }
}

export function commandReadyForMutation() {
  const trace = active.getStore();
  if (trace && trace.readyMs === null) trace.readyMs = rounded(trace.clock() - trace.start);
}
