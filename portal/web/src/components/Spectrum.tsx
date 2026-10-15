import { useEffect, useRef } from 'react';

// Decorative VFD-style spectrum. The browser never receives audio, so motion is
// generated per track rather than measured, and it makes no sync claim.
export type SpectrumMode = 'playing' | 'standby';

function random(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
}
function rgb(hex: string) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

export function Spectrum({ seed, color, tint, mode, animate, bands = 48, segment = 3, gap = 2, glow = true, ghost = .09, className = '' }: {
  seed: string; color: string; tint?: string; mode: SpectrumMode; animate: boolean; bands?: number; segment?: number; gap?: number; glow?: boolean; ghost?: number; className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef({ mode, animate, target: rgb(color), tint, wake: () => {} });
  live.current.mode = mode; live.current.animate = animate; live.current.target = rgb(color); live.current.tint = tint;

  useEffect(() => {
    const canvas = canvasRef.current; const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const next = random(seed);
    const voices = Array.from({ length: bands }, (_, i) => {
      const position = i / (bands - 1);
      return { base: .36 + .56 * (1 - position) ** .8 + .12 * Math.exp(-(((position - .45) / .14) ** 2)), f1: .7 + next() * 2.2, f2: 2.4 + next() * 4.6, p1: next() * 6.3, p2: next() * 6.3 };
    });
    const swellPhase = next() * 6.3;
    const level = new Float32Array(bands); const peak = new Float32Array(bands); const hold = new Float32Array(bands);
    const shown = [...live.current.target];
    let hit = 0; let clock = next() * 40; let frame = 0; let last = 0; let width = 0; let height = 0;

    const targetFor = (i: number, t: number) => {
      if (live.current.mode === 'standby') return .02;
      const v = voices[i];
      const swell = .86 + .14 * Math.sin(t * .31 + swellPhase) * Math.sin(t * .113 + swellPhase * 2);
      const motion = .72 + .18 * Math.sin(t * v.f1 + v.p1) + .1 * Math.sin(t * v.f2 + v.p2);
      const punch = i < bands * .3 ? hit * (1 - i / (bands * .3)) * .4 : 0;
      return Math.min(1, v.base * motion * swell + punch + (i > bands * .6 ? Math.max(0, next() - .93) * .5 : 0));
    };
    const draw = () => {
      if (!width || !height) return;
      const dpr = canvas.width / width; const unit = segment + gap;
      const rows = Math.max(1, Math.floor((height + gap) / unit)); const column = width / bands; const bar = Math.max(1, column - Math.min(gap + 1, column * .3));
      const lit = new Path2D(); const unlit = new Path2D(); const caps = new Path2D();
      for (let i = 0; i < bands; i++) {
        const x = i * column + (column - bar) / 2; const on = Math.max(1, Math.round(level[i] * rows)); const cap = Math.min(rows - 1, Math.round(peak[i] * rows));
        for (let r = 0; r < rows; r++) {
          const y = height - (r + 1) * unit + gap;
          (r < on ? lit : r === cap && cap >= on ? caps : unlit).rect(x, y, bar, segment);
        }
      }
      const base = `rgb(${shown.map(Math.round).join(' ')})`;
      // A tint carries the column from the accent at its foot to the tint at full scale.
      let fill: string | CanvasGradient = base;
      if (live.current.tint) { fill = context.createLinearGradient(0, height, 0, 0); fill.addColorStop(0, base); fill.addColorStop(.55, base); fill.addColorStop(1, live.current.tint); }
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
      context.fillStyle = fill; if (ghost) { context.globalAlpha = ghost; context.fill(unlit); }
      if (glow) { context.save(); context.filter = 'blur(5px)'; context.globalAlpha = .55; context.fill(lit); context.restore(); }
      context.globalAlpha = 1; context.fill(lit); context.globalAlpha = .75; context.fill(caps); context.globalAlpha = 1;
    };
    const settle = () => {
      // A still frame: the track's own shape when playing, a quiet baseline otherwise.
      for (let i = 0; i < bands; i++) { level[i] = live.current.mode === 'playing' ? voices[i].base * .7 : .02; peak[i] = level[i]; }
      shown.splice(0, 3, ...live.current.target); draw();
    };
    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(.1, (now - (last || now)) / 1000);
      if (last && now - last < 30) { frame = requestAnimationFrame(tick); return; }
      last = now; clock += dt;
      if (live.current.mode === 'playing' && next() < dt * 1.6) hit = Math.max(hit, .55 + next() * .45);
      hit *= Math.exp(-dt * 6);
      let moving = live.current.mode === 'playing';
      for (let i = 0; i < bands; i++) {
        const target = targetFor(i, clock);
        level[i] += (target - level[i]) * (target > level[i] ? .6 : Math.min(1, dt * 7));
        if (level[i] >= peak[i]) { peak[i] = level[i]; hold[i] = .4; } else if ((hold[i] -= dt) <= 0) peak[i] = Math.max(level[i], peak[i] - dt * .7);
        if (Math.abs(level[i] - target) > .004 || peak[i] - level[i] > .004) moving = true;
      }
      for (let c = 0; c < 3; c++) { shown[c] += (live.current.target[c] - shown[c]) * Math.min(1, dt * 2.5); if (Math.abs(shown[c] - live.current.target[c]) > .5) moving = true; }
      draw();
      if (moving && live.current.animate) frame = requestAnimationFrame(tick); else last = 0;
    };
    const wake = () => {
      if (!live.current.animate) { cancelAnimationFrame(frame); frame = 0; last = 0; settle(); return; }
      if (!frame) frame = requestAnimationFrame(tick);
    };
    live.current.wake = wake;
    const resize = () => {
      const box = canvas.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
      width = box.width; height = box.height;
      canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
      if (frame) draw(); else settle();
      wake();
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); live.current.wake = () => {}; };
  }, [seed, bands, segment, gap, glow, ghost]);

  useEffect(() => { live.current.wake(); }, [mode, animate, color, tint]);
  return <canvas ref={canvasRef} className={`spectrum ${className}`} aria-hidden="true" />;
}
