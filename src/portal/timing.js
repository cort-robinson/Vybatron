import { AsyncLocalStorage } from 'node:async_hooks';
import { withTimeout } from '../utils/enqueue.js';

const active = new AsyncLocalStorage();
const authorityPhase = new AsyncLocalStorage();
const commands = new Set(['pause', 'resume', 'seek', 'filter', 'volume', 'play', 'playnext']);
const stages = new Set(['authorization', 'playback', 'presentation']);
const phases = new Set(['native', 'finalDisclosure']);
const inputs = new Set(['user', 'application', 'guild', 'actorMember', 'botMember', 'channels']);
const rounded = value => Math.max(0, Math.round(value));
const phaseMetrics = () => ({ count: 0, wallMs: 0, inputs: Object.fromEntries([...inputs].map(input =>
  [input, { count: 0, waitMs: 0, maxMs: 0, timeouts: 0 }])) });
const live = trace => trace && !trace.sealed && !trace.lifecycle.closed && trace.wallClock() <= trace.expiresAt;

// Fixed labels and numeric timings only. No request, actor, guild, track,
// permission, query, payload or error objects are retained in the ring.
export function createCommandTimings({ clock = () => performance.now(), wallClock = () => Date.now() } = {}) {
  const records = []; const lifecycle = { closed: false };
  const prune = () => {
    const cutoff = wallClock() - 15 * 60_000;
    while (records.length && records[0].at < cutoff) records.shift();
  };
  return {
    async run(command, operation) {
      if (lifecycle.closed || !commands.has(command)) return operation();
      const start = clock();
      const trace = { clock, wallClock, start, expiresAt: wallClock() + 900_000, lifecycle, sealed: false,
        readyMs: null, authorization: { count: 0, ms: 0 }, playback: { count: 0, ms: 0 }, presentation: { count: 0, ms: 0 },
        authority: { native: phaseMetrics(), finalDisclosure: phaseMetrics() } };
      let success = false;
      try { return await active.run(trace, async () => { const result = await operation(); success = true; return result; }); }
      finally {
        const publish = live(trace);
        trace.sealed = true;
        if (publish) {
          prune();
          records.push({ at: wallClock(), command, success, totalMs: rounded(clock() - start),
            readyForMutationMs: trace.readyMs, ...Object.fromEntries([...stages].map(stage => [stage, { count: trace[stage].count, ms: rounded(trace[stage].ms) }])),
            authority: Object.fromEntries([...phases].map(phase => [phase, {
              count: trace.authority[phase].count, wallMs: rounded(trace.authority[phase].wallMs),
              inputs: Object.fromEntries([...inputs].map(input => {
                const value = trace.authority[phase].inputs[input];
                return [input, { count: value.count, waitMs: rounded(value.waitMs), maxMs: rounded(value.maxMs), timeouts: value.timeouts }];
              })),
            }])) });
          if (records.length > 32) records.shift();
        }
      }
    },
    snapshot() { prune(); return { retentionSeconds: 900, capacity: 32, records: structuredClone(records) }; },
    close() { lifecycle.closed = true; records.length = 0; },
  };
}

export async function commandTimingSpan(stage, operation) {
  const trace = active.getStore();
  if (!live(trace) || !stages.has(stage)) return operation();
  if (stage === 'playback') commandReadyForMutation();
  const start = trace.clock(); trace[stage].count++;
  try { return await operation(); }
  finally { if (live(trace)) trace[stage].ms += Math.max(0, trace.clock() - start); }
}

export function commandReadyForMutation() {
  const trace = active.getStore();
  if (live(trace) && trace.readyMs === null) trace.readyMs = rounded(trace.clock() - trace.start);
}

// A separate scope leaves the parent trace shared: native playback still records
// readiness on that parent after policy returns, and parallel commands stay isolated.
export function commandAuthorityPhase(phase, operation) {
  const trace = active.getStore();
  if (!live(trace) || !phases.has(phase)) return operation();
  const metrics = trace.authority[phase]; const start = trace.clock();
  const scope = { trace, metrics, open: true }; metrics.count++;
  return authorityPhase.run(scope, async () => {
    try { return await operation(); }
    finally {
      scope.open = false;
      if (live(trace)) metrics.wallMs += Math.max(0, trace.clock() - start);
    }
  });
}

// Time the bounded caller wait, including shared reads and channel-pool queues.
// Underlying settlement only sets a local boolean; it never updates a trace or
// releases policy admission. A native error with timeout-like text is not a timeout.
export function commandAuthorityInput(input, pending) {
  const trace = active.getStore(); const scope = authorityPhase.getStore();
  if (!live(trace) || scope?.trace !== trace || !scope.open || !inputs.has(input)) return withTimeout(pending, 5000);
  const metrics = scope.metrics.inputs[input]; const start = trace.clock(); metrics.count++;
  let settled = false;
  const observed = pending.then(value => { settled = true; return value; }, error => { settled = true; throw error; });
  return (async () => {
    try { return await withTimeout(observed, 5000); }
    catch (error) { if (!settled && live(trace) && scope.open) metrics.timeouts++; throw error; }
    finally {
      if (live(trace) && scope.open) {
        const wait = Math.max(0, trace.clock() - start);
        metrics.waitMs += wait; metrics.maxMs = Math.max(metrics.maxMs, wait);
      }
    }
  })();
}
