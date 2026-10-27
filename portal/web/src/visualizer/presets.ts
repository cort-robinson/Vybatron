import { useSyncExternalStore } from 'react';
import type { Skin } from '../skin';

export type PresetId = 'neon' | 'gridrunner' | 'cosmic' | 'receiver';
export const PRESETS: readonly { id: PresetId; name: string }[] = [
  { id: 'neon', name: 'Neon' }, { id: 'gridrunner', name: 'Gridrunner' }, { id: 'cosmic', name: 'Cosmic Broadcast' }, { id: 'receiver', name: 'Receiver' },
];
// Until someone picks one, the visualizer follows the look.
const bySkin: Record<Skin, PresetId> = { overdrive: 'gridrunner', fantastic: 'cosmic', classic: 'receiver' };

const key = 'vybertron.visualizer';
const read = (): PresetId | null => { try { const stored = localStorage.getItem(key); return PRESETS.some(preset => preset.id === stored) ? stored as PresetId : null; } catch { return null; } };
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
