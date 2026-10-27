import { useEffect, useRef, useState } from 'react';
import { stylesheet } from '../skin';
import styles from './visualizer.css?url';

// The visualizers (their shaders, engine and full-screen view) ship in their own chunk with their
// stylesheet, so nobody who never opens one downloads or parses them. Only this loader and the
// player's switches are in the main bundle. The stylesheet is linked as skin.ts links a look's.
type Module = typeof import('./Visualizer');
let loaded: Module | undefined; let pending: Promise<Module> | undefined;
function load() {
  pending ||= Promise.all([import('./Visualizer'), stylesheet(styles)]).then(([module]) => loaded = module);
  // A failed chunk can be asked for again later.
  pending.catch(() => { pending = undefined; });
  return pending;
}
export function useVisualizer(wanted: boolean, failed: () => void) {
  const [module, setModule] = useState(loaded);
  const fail = useRef(failed); fail.current = failed;
  useEffect(() => {
    if (!wanted || module) return;
    let current = true;
    load().then(value => { if (current) setModule(value); }, () => { if (current) fail.current(); });
    return () => { current = false; };
  }, [wanted, module]);
  return module;
}
