import { useSyncExternalStore } from 'react';
import type { Skin } from '../skin';

export type PresetId = 'milkdrop' | 'gridrunner' | 'cosmic' | 'receiver' | 'pumpkins' | 'witching';
export const PRESETS: readonly { id: PresetId; name: string }[] = [
  { id: 'milkdrop', name: 'MilkDrop' }, { id: 'gridrunner', name: 'Gridrunner' }, { id: 'cosmic', name: 'Cosmic Broadcast' }, { id: 'receiver', name: 'Receiver' },
  { id: 'pumpkins', name: 'Pumpkin Patch' }, { id: 'witching', name: 'Witching Hour' },
];
// Until someone picks one, the visualizer follows the look.
const bySkin: Record<Skin, PresetId> = { overdrive: 'gridrunner', fantastic: 'cosmic', haunted: 'pumpkins', classic: 'receiver' };

const key = 'vybertron.visualizer';
// MilkDrop took Neon's place in the picker, and someone who had chosen Neon keeps that place.
// Rewriting the stored choice is best effort; the migrated one stands even if that fails.
const read = (): PresetId | null => {
  let stored: string | null;
  try { stored = localStorage.getItem(key); } catch { return null; }
  if (stored === 'neon') { stored = 'milkdrop'; try { localStorage.setItem(key, stored); } catch { /* Optional, non-sensitive preference. */ } }
  return PRESETS.some(preset => preset.id === stored) ? stored as PresetId : null;
};
let chosen = read();
const listeners = new Set<() => void>();
export function choosePreset(id: PresetId) {
  chosen = id;
  try { localStorage.setItem(key, id); } catch { /* Optional, non-sensitive preference. */ }
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
// The sleeve and the full-screen view share one choice.
export function usePreset(skin: Skin) {
  return useSyncExternalStore(subscribe, () => chosen) ?? bySkin[skin];
}
