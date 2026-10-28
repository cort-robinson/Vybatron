import { BANDS, type EnergyMap } from './signal';

// A song's energy map from the portal (docs/portal-contract.md), fetched once per song while a
// visualizer shows it. The reply is immutable per video, so the browser keeps it privately and a
// second look is answered from its cache. The bot may still be measuring the song: "pending"
// is asked again after its retryMs, and a busy bot after a moment, a bounded number of times.
// A song it can't measure (404), or any other failure, leaves the ambient motion in place and
// isn't asked again for a while, so nothing retries in a loop.
const ATTEMPTS = 12; const RETRY_AFTER_FAILURE_MS = 5 * 60_000; const KEPT = 8;
type Entry = { promise: Promise<EnergyMap | null>; controller: AbortController; users: number; settled: boolean; map: EnergyMap | null; at: number };
const entries = new Map<string, Entry>();

const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

function decode(body: unknown): EnergyMap | null {
  const data = body as { version?: unknown; status?: unknown; frameRate?: unknown; frameCount?: unknown; bandCount?: unknown; levels?: unknown; beats?: unknown } | null;
  if (data?.version !== 1 || data.status !== 'ready' || data.frameRate !== 30 || data.bandCount !== BANDS || typeof data.levels !== 'string' || !Array.isArray(data.beats)) return null;
  const frameCount = Number(data.frameCount);
  let levels: Uint8Array;
  try { const text = atob(data.levels); levels = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) levels[i] = text.charCodeAt(i); } catch { return null; }
  if (!Number.isInteger(frameCount) || frameCount < 1 || levels.length !== frameCount * BANDS) return null;
  const beats = Float64Array.from(data.beats.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))).sort();
  return { frameCount, levels, beats };
}

async function load(guildId: string, videoId: string, signal: AbortSignal): Promise<EnergyMap | null> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`/api/guilds/${encodeURIComponent(guildId)}/analysis/${encodeURIComponent(videoId)}`,
        { credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
    } catch (error) { if (signal.aborted) throw error; return null; }
    if (response.status === 429) { await response.body?.cancel(); await wait(3000 * attempt, signal); continue; }
    if (!response.ok) { await response.body?.cancel(); return null; }
    const body = await response.json().catch(() => null) as { status?: unknown; retryMs?: unknown } | null;
    if (body?.status !== 'pending') return decode(body);
    await wait(Math.min(10_000, Math.max(500, Number(body.retryMs) || 2000)), signal);
  }
  return null;
}

// The map of one song, or null to stay ambient. Every caller passes its own signal; the request
// itself stops only once every caller waiting on it has gone.
export function analysisFor(guildId: string, videoId: string, signal: AbortSignal): Promise<EnergyMap | null> {
  const key = `${guildId}/${videoId}`;
  let entry = entries.get(key);
  // A failure is tried again after a while; a map is kept.
  if (entry?.settled && !entry.map && Date.now() - entry.at > RETRY_AFTER_FAILURE_MS) { entries.delete(key); entry = undefined; }
  if (!entry) {
    const controller = new AbortController();
    const created: Entry = { controller, users: 0, settled: false, map: null, at: Date.now(), promise: Promise.resolve(null) };
    created.promise = load(guildId, videoId, controller.signal).then(map => { created.settled = true; created.map = map; created.at = Date.now(); return map; },
      error => { if (entries.get(key) === created) entries.delete(key); throw error; });
    void created.promise.catch(() => {});
    entries.set(key, created); entry = created;
    for (const old of entries.keys()) { if (entries.size <= KEPT) break; if (entries.get(old)!.settled) entries.delete(old); }
  }
  const shared = entry; shared.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = () => { if (done) return; done = true; signal.removeEventListener('abort', abort); if (--shared.users === 0 && !shared.settled) { shared.controller.abort(); if (entries.get(key) === shared) entries.delete(key); } };
    const abort = () => { leave(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    shared.promise.then(map => { if (!done) { leave(); resolve(map); } }, error => { if (!done) { leave(); reject(error); } });
    if (signal.aborted) abort();
  });
}
