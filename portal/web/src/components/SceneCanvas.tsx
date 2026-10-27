import { useEffect, useRef, useState } from 'react';
import { startScene } from '../scene';

// The room as one WebGL canvas (scene/index.ts). It sits first in the ambient scene, under
// the DOM scenery that it reads and that styles.css hides. A device without WebGL2, or one that
// loses the context, falls back to the CSS scenery.
export function SceneCanvas({ onFail }: { onFail: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fail = useRef(onFail); fail.current = onFail;
  // Creating the WebGL context and compiling shaders blocks the main thread. They wait until the
  // page has painted and asked for its state (the app's own effects run after this one), so the
  // first request and the first frame never queue behind them.
  useEffect(() => {
    const canvas = ref.current!; let stop: (() => void) | undefined;
    const start = () => { stop = startScene(canvas, canvas.parentElement!, () => fail.current()); };
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(start, { timeout: 300 }); return () => { cancelIdleCallback(id); stop?.(); }; }
    const timer = setTimeout(start, 50);
    return () => { clearTimeout(timer); stop?.(); };
  }, []);
  return <canvas ref={ref} className="scene-canvas" aria-hidden="true" />;
}

// Rendering preference for previews and comparisons: ?scene=css or ?scene=gl (remembered on this
// device, including the installed app), and ?fps=1 / ?fps=0 for a frame-rate readout.
const remember = (name: string, key: string, values: string[]) => {
  const asked = new URLSearchParams(location.search).get(name);
  try {
    if (asked !== null && values.includes(asked)) localStorage.setItem(key, asked);
    return localStorage.getItem(key);
  } catch { return asked; }
};
export const glSceneChosen = () => remember('scene', 'vybertron.scene', ['gl', 'css']) !== 'css';
export const fpsChosen = () => remember('fps', 'vybertron.fps', ['1', '0']) === '1';

export function FpsMeter() {
  const [reading, setReading] = useState('');
  useEffect(() => {
    let frame = 0; let start = performance.now(); let count = 0; let worst = 0; let previous = start;
    const tick = (now: number) => {
      count++; worst = Math.max(worst, now - previous); previous = now;
      if (now - start >= 1000) { setReading(`${Math.round(count * 1000 / (now - start))} fps · worst ${Math.round(worst)} ms`); start = now; count = 0; worst = 0; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <output className="fps-meter" aria-hidden="true">{reading}</output>;
}
