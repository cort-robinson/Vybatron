import { mixOklab } from './art';

// The room relights with each cover. Every element reads the accent and ground, so each change to
// them restyles and repaints the whole page. A CSS transition on :root did that every frame, which
// stuttered and dropped frames on phones. Stepping the glide about twenty times a second looks the
// same for a slow color change and costs a fraction of the work. (The light pools are only three
// elements, so they keep a per-frame CSS transition.)
const stepMs = 50;
const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  const curve = (u: number, a: number, b: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  const slope = (u: number, a: number, b: number) => 3 * a * (1 - u) ** 2 + 6 * (b - a) * u * (1 - u) + 3 * (1 - b) * u * u;
  return (t: number) => {
    let u = t;
    for (let i = 0; i < 8; i++) { const error = curve(u, x1, x2) - t; const d = slope(u, x1, x2); if (Math.abs(error) < 1e-4 || !d) break; u = Math.min(1, Math.max(0, u - error / d)); }
    return curve(u, y1, y2);
  };
};
const ease = bezier(.25, .1, .25, 1);
const plan: Record<string, [duration: number, curve: (t: number) => number]> = {
  '--accent': [1200, bezier(.2, .7, .2, 1)], '--ground': [1600, ease],
};
const shown = new Map<string, string>();
let frame = 0;

// Glides the root colors to `colors`. Reduced motion shortens the glide; `instant` sets them at once.
export function relight(colors: Record<string, string>, mode: 'glide' | 'quick' | 'instant' = 'glide') {
  cancelAnimationFrame(frame);
  const root = document.documentElement.style;
  const from = new Map(Object.keys(colors).map(name => [name, shown.get(name) ?? colors[name]]));
  const apply = (elapsed: number) => {
    let done = true;
    for (const [name, to] of Object.entries(colors)) {
      const [duration, curve] = plan[name] || [0, ease];
      const t = mode === 'instant' ? 1 : Math.min(1, elapsed / (mode === 'quick' ? 300 : duration));
      if (t < 1) done = false;
      const value = t >= 1 ? to : mixOklab(from.get(name)!, to, curve(t));
      if (shown.get(name) !== value) { shown.set(name, value); root.setProperty(name, value); }
    }
    return done;
  };
  if (apply(mode === 'instant' ? Infinity : 0)) return;
  const start = performance.now(); let last = start;
  const tick = (now: number) => {
    if (now - last >= stepMs - 4) { last = now; if (apply(now - start)) return; }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}
