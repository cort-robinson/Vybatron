// Portal look. Overdrive layers the synthwave horizon and HUD chrome over the receiver;
// Fantastic tunes it to a 1960s retro-future broadcast (Earth-828); Classic is the original
// receiver, untouched. Every skin's styles are scoped to :root[data-skin='…'], so switching
// is a single attribute change. Overdrive stays the default; the others are opt-in.
import type { ComponentType, PointerEvent } from 'react';
import { look as overdrive } from './components/Overdrive';

export type Skin = 'overdrive' | 'fantastic' | 'classic';

// The default look ships in the main bundle. Opt-in looks keep their stylesheet and scenery in
// their own chunk, so no device downloads, parses or style-matches a look it doesn't show.
// Load a look before applying it; it never flashes.
export type Look = {
  Scenery: ComponentType<{ prepared?: boolean }>;
  Sleeve: ComponentType<{ track: string }>;
  tilt?: (event: PointerEvent<HTMLElement>) => void;
  untilt?: (event: PointerEvent<HTMLElement>) => void;
};
const loaders: Record<Skin, () => Promise<Look | undefined>> = {
  overdrive: async () => overdrive,
  fantastic: () => import('./components/Fantastic').then(module => module.look),
  classic: async () => undefined,
};
const looks = new Map<Skin, Look | undefined>();
const loading = new Map<Skin, Promise<void>>();

export function loadLook(skin: Skin) {
  let pending = loading.get(skin);
  if (!pending) {
    pending = loaders[skin]().then(look => { looks.set(skin, look); });
    // A failed chunk (offline before the worker cached it) can be retried later.
    pending.catch(() => loading.delete(skin));
    loading.set(skin, pending);
  }
  return pending;
}

export const skinLook = (skin: Skin) => looks.get(skin);

const key = 'vybertron.skin';
const skins: readonly Skin[] = ['overdrive', 'fantastic', 'classic'];

export function initialSkin(): Skin {
  try { const stored = localStorage.getItem(key); return skins.includes(stored as Skin) ? stored as Skin : 'overdrive'; } catch { return 'overdrive'; }
}

export function applySkin(skin: Skin, persist = true) {
  document.documentElement.dataset.skin = skin;
  if (persist) try { localStorage.setItem(key, skin); } catch { /* Optional, non-sensitive preference. */ }
}


// Performance mode trades glass blur, blurred cover light, and ambient motion for lighter
// rendering on older or battery-powered devices. Layout, controls, and playback are unchanged.
const performanceKey = 'vybertron.performance';

export function initialPerformance() {
  try { return localStorage.getItem(performanceKey) === 'on'; } catch { return false; }
}

export function applyPerformance(on: boolean, persist = true) {
  if (on) document.documentElement.dataset.performance = ''; else delete document.documentElement.dataset.performance;
  if (persist) try { localStorage.setItem(performanceKey, on ? 'on' : 'off'); } catch { /* Optional, non-sensitive preference. */ }
}

// Fixed scenery partners to the cover-derived accent; decorative only, never a state color.
export const neon = '#e04cff';
export const flame = '#ff7a38';
export const skinTint = (skin: Skin) => skin === 'overdrive' ? neon : skin === 'fantastic' ? flame : undefined;
