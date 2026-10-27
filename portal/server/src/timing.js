import { AsyncLocalStorage } from 'node:async_hooks';

// Server-Timing for /api responses: the portal's own handling time, the time
// spent waiting on the bot bridge, and the bot's reported breakdown. Only these
// fixed metric names and durations are emitted, never identifiers or content.
const current = new AsyncLocalStorage();
const UPSTREAM = ['bot', 'discord'];
const ms = value => Math.max(0, value).toFixed(1);

// The bridge's own Server-Timing is optional. Anything missing, oversized or
// malformed is ignored rather than trusted or forwarded.
export function parseUpstreamTiming(value) {
  const metrics = {};
  if (typeof value !== 'string' || value.length > 256) return metrics;
  for (const part of value.split(',')) {
    const match = /^\s*([a-z]{1,16});dur=(\d{1,7}(?:\.\d{1,3})?)\s*$/.exec(part);
    if (match && UPSTREAM.includes(match[1])) metrics[match[1]] = (metrics[match[1]] || 0) + Number(match[2]);
  }
  return metrics;
}

export function serverTimingHeader(timing, now = timing.clock()) {
  const metrics = [`portal;dur=${ms(now - timing.start)}`];
  if (timing.bridgeCalls) metrics.push(`bridge;dur=${ms(timing.bridgeMs)}`);
  for (const name of UPSTREAM) if (timing.upstream[name] !== undefined) metrics.push(`${name};dur=${ms(timing.upstream[name])}`);
  return metrics.join(', ');
}

// Wraps the request handler. API responses get the header just before their
// status line is written, whichever path (JSON, error, SSE, audio) writes it.
export function timeRequests(handler, clock = () => performance.now()) {
  return (req, res) => {
    if (!/^\/api(?:[/?]|$)/.test(req.url || '')) return handler(req, res);
    const timing = { clock, start: clock(), bridgeMs: 0, bridgeCalls: 0, upstream: {} };
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!this.headersSent) this.setHeader('Server-Timing', serverTimingHeader(timing));
      return writeHead.apply(this, args);
    };
    return current.run(timing, () => handler(req, res));
  };
}

// Times one bridge round trip for the current API request, if any, and keeps
// the bot's own breakdown from the reply's Server-Timing header.
export async function bridgeTime(operation) {
  const timing = current.getStore();
  if (!timing) return operation();
  const start = timing.clock(); let result;
  try { result = await operation(); return result; }
  finally {
    timing.bridgeCalls++; timing.bridgeMs += timing.clock() - start;
    for (const [name, value] of Object.entries(parseUpstreamTiming(result?.timing))) timing.upstream[name] = (timing.upstream[name] || 0) + value;
  }
}
