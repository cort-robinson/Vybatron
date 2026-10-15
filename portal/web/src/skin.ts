// Portal look. Overdrive layers the synthwave horizon and HUD chrome over the receiver;
// Classic is the original receiver, untouched. Every Overdrive style is scoped to
// :root[data-skin='overdrive'], so switching back is a single attribute change.
export type Skin = 'overdrive' | 'classic';

const key = 'vybertron.skin';

export function initialSkin(): Skin {
  try { return localStorage.getItem(key) === 'classic' ? 'classic' : 'overdrive'; } catch { return 'overdrive'; }
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

// Fixed synthwave partner to the cover-derived accent; decorative only, never a state color.
export const neon = '#e04cff';
