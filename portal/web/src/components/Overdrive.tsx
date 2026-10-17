import { useEffect, useMemo, useState, type PointerEvent } from 'react';

// Overdrive scenery: a cover-tinted sunset over an angular Cybertronian skyline and a neon
// floor that rolls toward the viewer while music plays. Pure decoration behind the content;
// every piece is aria-hidden, and motion is gated by the ambient scene's moving state. Pieces
// marked data-travel glide between the browse and sleeve layouts (motion.ts).

function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const W = 1600; const H = 150;

// Towers rise toward both edges and dip in the middle so the sun stays visible above them.
function skyline(seed: number, scale: number) {
  const next = random(seed);
  const points: string[] = [`0,${H}`];
  const windows: { x: number; y: number; delay: number }[] = [];
  let x = 0;
  while (x < W) {
    const width = 26 + next() * 64; const x1 = Math.min(W, x + width);
    const edge = Math.abs((x + width / 2) / W - .5) * 2;
    const height = (18 + next() * 46 + edge ** 1.6 * 70) * scale; const y = H - height; const cut = Math.min(10, width / 4);
    const base = H - (6 + next() * 10) * scale;
    points.push(`${x.toFixed(1)},${base.toFixed(1)}`);
    const kind = next();
    if (kind < .38) points.push(`${x.toFixed(1)},${(y + cut).toFixed(1)}`, `${(x + cut).toFixed(1)},${y.toFixed(1)}`, `${(x1 - cut).toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${(y + cut).toFixed(1)}`);
    else if (kind < .62) { const mid = (x + x1) / 2; points.push(`${x.toFixed(1)},${(y + 24).toFixed(1)}`, `${(mid - 3).toFixed(1)},${(y + 10).toFixed(1)}`, `${mid.toFixed(1)},${(y - 22 * scale).toFixed(1)}`, `${(mid + 3).toFixed(1)},${(y + 10).toFixed(1)}`, `${x1.toFixed(1)},${(y + 24).toFixed(1)}`); }
    else if (kind < .84) { const step = x + width * .4; points.push(`${x.toFixed(1)},${(y + 18).toFixed(1)}`, `${step.toFixed(1)},${(y + 18).toFixed(1)}`, `${step.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`); }
    else points.push(`${x.toFixed(1)},${y.toFixed(1)}`, `${(x1 - cut * 1.6).toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${(y + cut * 1.6).toFixed(1)}`);
    points.push(`${x1.toFixed(1)},${base.toFixed(1)}`);
    if (scale === 1 && height > 46 && next() < .55) windows.push({ x: x + 6 + next() * Math.max(1, width - 16), y: y + 14 + next() * (height - 30), delay: next() * 9 });
    x = x1 + next() * 6;
  }
  points.push(`${W},${H}`);
  return { path: points.join(' '), windows };
}

export function Horizon({ prepared = false }: { prepared?: boolean }) {
  // Content and controls paint first; the scenery joins on the next idle moment and fades in.
  const [ready, setReady] = useState(prepared);
  useEffect(() => {
    if (prepared) return;
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(() => setReady(true), { timeout: 600 }); return () => cancelIdleCallback(id); }
    const id = setTimeout(() => setReady(true), 120); return () => clearTimeout(id);
  }, []);
  const far = useMemo(() => skyline(7, .72), []);
  const near = useMemo(() => skyline(23, 1), []);
  if (!ready) return null;
  return <div className="od-horizon">
    <div className="od-sky" />
    <div className="od-sun" data-travel />
    <svg className="od-skyline" data-travel viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" focusable="false">
      <polygon className="od-skyline-far" points={far.path} />
      <polygon className="od-skyline-near" points={near.path} />
      {near.windows.map((light, index) => <rect key={index} className="od-window" x={light.x} y={light.y} width="5" height="2" style={{ animationDelay: `${light.delay.toFixed(2)}s` }} />)}
    </svg>
    <div className="od-floor" data-travel><div className="od-plane" /></div>
    <div className="od-crt" />
  </div>;
}

// Targeting brackets around a framed object; the frame stays still while the object floats inside.
export function Hud({ className = '' }: { className?: string }) {
  return <span className={`od-hud ${className}`} aria-hidden="true"><i /><i /><i /><i /></span>;
}

// The sleeve cover leans toward a fine pointer. Overdrive-only; reduced motion keeps it flat.
const lean = matchMedia('(pointer: fine)');
export function tilt(event: PointerEvent<HTMLElement>) {
  const element = event.currentTarget;
  if (document.documentElement.dataset.skin !== 'overdrive' || !lean.matches || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = element.getBoundingClientRect();
  element.style.setProperty('--tilt-x', `${(((event.clientX - box.left) / box.width) - .5) * 9}deg`);
  element.style.setProperty('--tilt-y', `${(((event.clientY - box.top) / box.height) - .5) * -9}deg`);
}
export function untilt(event: PointerEvent<HTMLElement>) {
  event.currentTarget.style.removeProperty('--tilt-x'); event.currentTarget.style.removeProperty('--tilt-y');
}
