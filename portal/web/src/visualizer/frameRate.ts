import { useSyncExternalStore } from 'react';

// How often the visualizers draw, chosen in Settings for this device. 30 is the default: smooth
// enough for the presets and light on a phone's battery. Native draws on every refresh the display
// gives, whatever its rate. Small and on its own, shared by Settings and the visualizer chunk.
export type FrameRate = 15 | 30 | 45 | 60 | 'native';
export const FRAME_RATES: readonly FrameRate[] = [15, 30, 45, 60, 'native'];

const key = 'vybertron.visualizerFps';
const parse = (value: string | null): FrameRate => value === 'native' ? 'native' : FRAME_RATES.find(rate => String(rate) === value) ?? 30;
let chosen: FrameRate = (() => { try { return parse(localStorage.getItem(key)); } catch { return 30; } })();
const listeners = new Set<() => void>();
export function chooseFrameRate(rate: FrameRate) {
  chosen = rate;
  try { localStorage.setItem(key, String(rate)); } catch { /* Optional, non-sensitive preference. */ }
  listeners.forEach(listener => listener());
}
// Milliseconds between frames, 0 for native; read by the engine on each frame, so a change applies at once.
export const frameInterval = () => chosen === 'native' ? 0 : 1000 / chosen;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useFrameRate = () => useSyncExternalStore(subscribe, () => chosen);
