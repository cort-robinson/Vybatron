// These browser tests exercise the portal's protocols, not its rendering. Under CI's software GPU the
// WebGL room shares two cores with the servers under test and delays them, so pages use the CSS
// scenery (portal/web scene-gl.spec covers the canvas).
export const cssScene = () => localStorage.setItem('vybertron.scene', 'css');
