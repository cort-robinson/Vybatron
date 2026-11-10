import { useSyncExternalStore } from 'react';

// The bot keeps one import preview per listener (src/utils/playlist-import.js): a
// new preview replaces the last, and confirming the replaced one is refused. Two
// callers on this device use it, the playlist form and a heart's one-song save, so
// each takes this slot first and neither replaces the other's preview. A playlist
// holds it from its lookup until its preview closes; a song from lookup to commit.
export type ImportOwner = 'playlist' | 'song';
export type ImportSlot = { state: 'idle' } | { state: 'previewing' | 'confirming'; owner: ImportOwner };
export type ImportLease = { previewing(): void; confirming(): void; release(): void };

const IDLE: ImportSlot = { state: 'idle' };
let slot: ImportSlot = IDLE;
let holder: object | null = null;
const waiting: (() => void)[] = [];
const listeners = new Set<() => void>();
const set = (next: ImportSlot) => { slot = next; listeners.forEach(listener => listener()); };

/** Takes the slot now, or returns null while another caller holds it. */
export function claimImport(owner: ImportOwner): ImportLease | null {
  if (holder) return null;
  const lease = {}; holder = lease; set({ state: 'previewing', owner });
  // A lease that was released does nothing, so a late call can't free the next holder's slot.
  const mine = () => holder === lease;
  return {
    previewing: () => { if (mine()) set({ state: 'previewing', owner }); },
    confirming: () => { if (mine()) set({ state: 'confirming', owner }); },
    release: () => { if (!mine()) return; holder = null; set(IDLE); waiting.shift()?.(); },
  };
}

/** Waits for the slot, first come first served, and takes it. */
export function waitForImport(owner: ImportOwner) {
  return new Promise<ImportLease>(resolve => {
    const take = () => { const lease = claimImport(owner); if (lease) resolve(lease); else waiting.push(take); };
    take();
  });
}

export const useImportSlot = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => slot);
