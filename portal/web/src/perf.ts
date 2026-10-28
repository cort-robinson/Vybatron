import type { Command } from './types';
import { fromList, isListed } from './favorites';
// Opt-in latency measurement: `?perf` in the URL or localStorage.vybPerf = '1'.
// Off, every export is a no-op (timed() hands back the same function) and no
// observer, mark or timer exists. On, results stay on this device: DevTools
// shows the vyb:* measures, the console gets a table every few actions, and
// window.__vybPerf() returns p50/p95 aggregates.
const enabled = (() => {
  try { return new URLSearchParams(location.search).has('perf') || localStorage.getItem('vybPerf') === '1'; }
  catch { return false; }
})();
const LOG_EVERY = 10;
const KEEP = 200;
const samples = new Map<string, number[]>();
let actions = 0;
let booted = false;

function record(name: string, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  const list = samples.get(name) ?? [];
  list.push(ms); if (list.length > KEEP) list.shift();
  samples.set(name, list);
}

function measure(name: string, start: number, end: number, detail?: string) {
  record(detail ? `${name} ${detail}` : name, end - start);
  try { performance.measure(name, { start, end, detail }); } catch { /* User Timing is optional. */ }
}

// The frame that shows a state change has painted once a task runs after its
// animation frame callback.
const afterPaint = (then: (at: number) => void) => requestAnimationFrame(() => setTimeout(() => then(performance.now()), 0));

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
export interface PerfRow { metric: string; count: number; p50: number; p95: number; max: number }
export function summary(): PerfRow[] {
  return [...samples].sort(([a], [b]) => a.localeCompare(b)).map(([metric, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const round = (value: number) => Math.round(value * 10) / 10;
    return { metric, count: sorted.length, p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted.at(-1)!) };
  });
}

// Times an action from its click (the input event's own timestamp, so input
// delay counts) to the painted optimistic frame and to the bot's confirmation.
// The label is the command name only. Wrappers are cached so callers keep a
// stable function identity for memoized children.
const wrapped = new WeakMap<object, unknown>();
// Commands that actually went to the bot. A no-op, a set-state choice replaced
// before sending, or a blocked tap also settles, but confirms nothing.
const sentBodies = new WeakSet<object>();
export function sent(body: object) { if (enabled) sentBodies.add(body); }
export function timed<A extends [{ command: string; subcommand?: string }, ...unknown[]]>(action: (...args: A) => Promise<boolean>) {
  if (!enabled) return action;
  const cached = wrapped.get(action) as typeof action | undefined;
  if (cached) return cached;
  const wrapper = (...args: A) => {
    const now = performance.now();
    const stamp = window.event?.timeStamp;
    const start = stamp && stamp > 0 && stamp <= now ? stamp : now;
    const label = args[0].subcommand ? `${args[0].command}/${args[0].subcommand}` : args[0].command;
    // Each tap gets its own body, so overlapping taps reusing one object keep separate sent marks.
    const body = { ...args[0] };
    // The copy keeps a list action's mark, so it still follows its song by id.
    if (isListed(args[0] as Command)) fromList(body as Command);
    const result = action(...[body, ...args.slice(1)] as A);
    afterPaint(at => measure('vyb:tap→paint', start, at, label));
    void result.then(ok => {
      if (!sentBodies.delete(body)) return;
      measure(ok ? 'vyb:tap→confirmed' : 'vyb:tap→rejected', start, performance.now(), label);
      if (++actions % LOG_EVERY === 0) console.table(summary());
    }, () => undefined);
    return result;
  };
  wrapped.set(action, wrapper);
  return wrapper;
}

// Navigation start to the first painted snapshot with controls enabled.
export function interactive() {
  if (!enabled || booted) return;
  booted = true;
  afterPaint(at => { measure('vyb:boot→interactive', 0, at); console.table(summary()); });
}

// API routes without IDs, so samples aggregate and logs stay free of them.
const route = (path: string) => path.replace(/^\/api\//, '').replace(/^guilds\/[^/]+/, 'guilds/:id').replace(/\/(audio|lyrics|analysis)\/[\w-]+$/, '/$1/:video');

if (enabled && typeof PerformanceObserver === 'function') {
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const url = new URL(entry.name, location.href);
        if (url.origin !== location.origin || !url.pathname.startsWith('/api/') || url.pathname.endsWith('/events')) continue;
        const name = `api ${route(url.pathname)}`;
        record(name, entry.duration);
        for (const metric of entry.serverTiming ?? []) record(`${name} ${metric.name}`, metric.duration);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch { /* Resource Timing is optional. */ }
}

if (enabled) Object.assign(window, { __vybPerf: Object.assign(() => summary(), { reset: () => { samples.clear(); actions = 0; } }) });
