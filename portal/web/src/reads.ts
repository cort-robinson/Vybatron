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
// Bumped per key whenever its read is forgotten, so a result already on its way
// for that key (and only that key) is discarded.
const versions = new Map<string, number>();
const version = (key: string) => versions.get(key) ?? 0;
// Bumped only by a deliberate clear (Clear my request stats), which shown reads start again after.
let resets = 0;
let unauthorized: () => void = () => {};
// The portal signs out when a read finds the session gone.
export function onReadsUnauthorized(handler: () => void) { unauthorized = handler; return () => { if (unauthorized === handler) unauthorized = () => {}; }; }
const publish = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Forget matching reads; with `error`, keep each as that error instead, so every
// surface showing one explains it and offers its own retry.
function forget(match: (key: string) => boolean, error?: string) {
  for (const key of new Set([...reads.keys(), ...loading.keys()])) {
    if (!match(key)) continue;
    versions.set(key, version(key) + 1); loading.delete(key);
    if (error) reads.set(key, { error, at: 0 }); else reads.delete(key);
  }
}
const guildOf = (key: string) => key.split(':')[1];
// Forget reads whose key starts with `prefix` (all of them by default), or that
// belong to `guildId`, including any still on their way. Reads still on screen
// start again, except after lost access, which must not ask again by itself.
export function clearReads(prefix = '', guildId?: string, { reload = true } = {}) {
  forget(key => key.startsWith(prefix) && (!guildId || guildOf(key) === guildId));
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
  const started = version(key);
  const request = fetch().then(value => {
    if (started !== version(key)) return;
    reads.set(key, { value, error: '', at: Date.now() });
  }, failure => {
    if (started !== version(key)) return;
    const status = failure instanceof ApiError ? failure.status : 0;
    // Signed out: nothing held stays, and the portal signs out.
    if (status === 401) { forget(() => true); unauthorized(); return; }
    // Lost access to a server replaces everything held for it (and anything still on
    // its way) with the reason. Nothing asks again by itself; each surface's retry does.
    if (status === 403 || status === 404) { forget(other => guildOf(other) === guildOf(key), errorMessage(failure)); return; }
    // A store that would refuse Play too clears its lists rather than leaving a stale
    // view. Anything else keeps what's shown.
    const drop = status === 503;
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
