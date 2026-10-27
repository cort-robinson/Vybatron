import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/michroma/latin.css';
import { App } from './App';
import { applyPerformance, applySkin, initialPerformance, initialSkin, loadLook } from './skin';
import './styles.css';
import './overdrive.css';
import './boot.css';

// Apply the look before the first paint so no look ever flashes another. An opt-in look's
// stylesheet and scenery load first; until then the page is the bare ground every look shares.
// A look that fails to load still leaves a working portal in the shared base styles.
const skin = initialSkin();
applySkin(skin, false);
applyPerformance(initialPerformance(), false);
void loadLook(skin).catch(() => undefined).then(() => {
  // One power-on sequence per page load; styles ignore it under reduced motion.
  document.documentElement.dataset.boot = '';
  setTimeout(() => { delete document.documentElement.dataset.boot; }, 2200);
  ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
