import { useCallback, useRef } from 'react';

// Live state arrives as fresh JSON on every frame, even when little or nothing changed. Sharing
// the parts that are equal with the previous value keeps their identity, so memoized rows, shelves
// and lists can skip rendering again. The result always equals `next`; only identities differ.
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const idOf = (value: unknown) => plain(value) && typeof value.id === 'string' ? value.id : undefined;

export function share<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    // A skip, removal or move shifts list items: an item keeps its identity by its id, not its index.
    let pool: Map<string, unknown[]> | undefined;
    const reuse = (item: unknown, index: number) => {
      const kept = share(previous[index], item);
      if (kept === previous[index]) return kept;
      const id = idOf(item); if (id === undefined) return kept;
      if (!pool) { pool = new Map(); for (const old of previous) { const key = idOf(old); if (key !== undefined) pool.set(key, [...pool.get(key) || [], old]); } }
      const candidates = pool.get(id) || [];
      for (let at = 0; at < candidates.length; at++) {
        const match = share(candidates[at], item);
        if (match === candidates[at]) { candidates.splice(at, 1); return match; }
      }
      return kept;
    };
    const merged = next.map(reuse);
    return (merged.length === previous.length && merged.every((item, index) => item === previous[index]) ? previous : merged) as T;
  }
  if (plain(previous) && plain(next)) {
    const keys = Object.keys(next);
    let same = keys.length === Object.keys(previous).length;
    const merged: Record<string, unknown> = {};
    for (const key of keys) {
      merged[key] = share(previous[key], next[key]);
      if (merged[key] !== previous[key] || !(key in previous)) same = false;
    }
    return (same ? previous : merged) as T;
  }
  return next;
}

// The previous value's equal parts, carried into this render's value.
export function useShared<T>(value: T): T {
  const kept = useRef(value);
  kept.current = share(kept.current, value);
  return kept.current;
}

// The same object as last render while every field is the same, so it can be a memo dependency.
export function useStableObject<T extends object>(value: T): T {
  const kept = useRef(value);
  const previous = kept.current as Record<string, unknown>; const next = value as Record<string, unknown>;
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(previous).length || keys.some(key => !Object.is(previous[key], next[key]))) kept.current = value;
  return kept.current;
}

// A handler whose identity never changes and that always calls the latest render's version, for
// event props of memoized components.
export function useEvent<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  const latest = useRef(handler); latest.current = handler;
  return useCallback((...args: A) => latest.current(...args), []);
}
