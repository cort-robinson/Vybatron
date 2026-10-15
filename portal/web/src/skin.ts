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


// Fixed synthwave partner to the cover-derived accent; decorative only, never a state color.
export const neon = '#e04cff';
