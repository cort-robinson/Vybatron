import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource/michroma/latin.css';
import { App } from './App';
import { applyPerformance, applySkin, initialPerformance, initialSkin } from './skin';
import './styles.css';
import './overdrive.css';
import './fantastic.css';

// Apply the look before the first paint so no look ever flashes another.
applySkin(initialSkin(), false);
applyPerformance(initialPerformance(), false);
// One power-on sequence per page load; styles ignore it under reduced motion.
document.documentElement.dataset.boot = '';
setTimeout(() => { delete document.documentElement.dataset.boot; }, 2200);

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
