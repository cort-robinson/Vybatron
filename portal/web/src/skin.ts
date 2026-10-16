// Portal look. Overdrive layers the synthwave horizon and HUD chrome over the receiver;
// Fantastic tunes it to a 1960s retro-future broadcast (Earth-828); Classic is the original
// receiver, untouched. Every skin's styles are scoped to :root[data-skin='…'], so switching
// is a single attribute change. Overdrive stays the default; the others are opt-in.
export type Skin = 'overdrive' | 'fantastic' | 'classic';

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
