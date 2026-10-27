import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { RecapWindow, StatsWindow } from './types';

// Listening stats and recaps, kept in this tab's memory only (never a persistent
// cache) so Home, Server favorites and a return to Home share one read and show
// what they have at once. A read older than `freshMs` is shown while it's re-read.
// Keys start with the viewer, so a sign-out (which clears everything) or another
// account never sees them.
const freshMs = 60_000;
export interface Read<T> { value?: T; error: string; at: number }
const reads = new Map<string, Read<unknown>>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
// Bumped whenever reads are forgotten, so results already on their way are discarded.
let generation = 0;
// Bumped only by a deliberate clear (Clear my request stats), which shown reads start again after.
let resets = 0;
let unauthorized: () => void = () => {};
// The portal signs out when a read finds the session gone.
export function onReadsUnauthorized(handler: () => void) { unauthorized = handler; return () => { if (unauthorized === handler) unauthorized = () => {}; }; }
const publish = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function forget(prefix: string, guildId?: string) {
  generation++;
  const drop = (key: string) => key.startsWith(prefix) && (!guildId || key.split(':')[1] === guildId);
  for (const key of [...reads.keys()]) if (drop(key)) reads.delete(key);
  for (const key of [...loading.keys()]) if (drop(key)) loading.delete(key);
}
// Forget reads whose key starts with `prefix` (all of them by default), or that
// belong to `guildId`, including any still on their way. Reads still on screen
// start again, except after lost access, which must not ask again by itself.
export function clearReads(prefix = '', guildId?: string, { reload = true } = {}) {
  forget(prefix, guildId);
  if (reload) resets++;
  publish();
}

// Start a read unless a fresh one is held or one is already on its way. `force`
// re-reads anyway (Refresh, Try again). Existing data stays shown meanwhile.
export function loadRead<T>(key: string, fetch: () => Promise<T>, force = false): Promise<void> {
  const held = reads.get(key);
  const inflight = loading.get(key);
  if (inflight) return inflight;
  if (!force && held?.value !== undefined && Date.now() - held.at < freshMs) return Promise.resolve();
  const started = generation;
  const request = fetch().then(value => {
    if (started !== generation) return;
    reads.set(key, { value, error: '', at: Date.now() });
  }, failure => {
    if (started !== generation) return;
    const status = failure instanceof ApiError ? failure.status : 0;
    // Lost access clears everything held under that grant: every read for the server
    // (or, signed out, all of them), including any still on their way.
    if (status === 401) { forget(''); unauthorized(); return; }
    if (status === 403 || status === 404) forget('', key.split(':')[1]);
    // A store that would refuse Play too clears its lists rather than leaving a stale
    // view. Anything else keeps what's shown.
    const drop = [403, 404, 503].includes(status);
    reads.set(key, { value: drop ? undefined : reads.get(key)?.value, error: errorMessage(failure), at: reads.get(key)?.at ?? 0 });
  }).finally(() => {
    if (loading.get(key) === request) loading.delete(key);
    publish();
  });
  loading.set(key, request);
  publish();
  return request;
}

// The held read for `key` (shown at once), started when it's missing and re-read
// when it's old. Cleared reads (after Clear my request stats) start again.
export function useRead<T>(key: string | null, fetch: () => Promise<T>) {
  const read = useSyncExternalStore(subscribe, () => key ? reads.get(key) as Read<T> | undefined : undefined);
  const cleared = useSyncExternalStore(subscribe, () => resets);
  const fetchRef = useRef(fetch); fetchRef.current = fetch;
  useEffect(() => { if (key) void loadRead(key, () => fetchRef.current()); }, [key, cleared]);
  const reload = useCallback(() => key ? loadRead(key, () => fetchRef.current(), true) : Promise.resolve(), [key]);
  return { value: read?.value, error: read?.error || '', reload };
}

// One read per viewer, server and range, whichever surface asks.
export const statsRead = (viewer: string, guildId: string, window: StatsWindow) =>
  ({ key: `${viewer}:${guildId}:stats:${window}`, fetch: () => api.stats(guildId, window) });
export const recapRead = (viewer: string, guildId: string, window: RecapWindow) =>
  ({ key: `${viewer}:${guildId}:recap:${window}`, fetch: () => api.recap(guildId, window) });
