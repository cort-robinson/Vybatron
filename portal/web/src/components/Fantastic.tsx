import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import type { Look } from '../skin';

// Fantastic scenery: Earth-828 at dusk, as a 1964 broadcast would paint it. A ringed planet
// rises over a Googie skyline (the Baxter Building flies the 4), a monorail glides past, Kirby
// krackle trails the cosmic storm across the sky, and the bay below prints in Ben-Day dots.
// Pure decoration behind the content; every piece is aria-hidden, and motion is gated by the
// ambient scene's moving state. Pieces marked data-travel glide between layouts (motion.ts).

function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const f = (value: number) => value.toFixed(1);
const percent = (value: number) => `${value.toFixed(3)}%`;
// Several same-coloured dots as one path, so a scene copy (RoomLight) mounts few elements.
const dots = (list: { x: number; y: number; r: number }[]) => list.map(({ x, y, r }) => `M${f(x - r)},${f(y)} a${f(r)},${f(r)} 0 1,0 ${f(r * 2)},0 a${f(r)},${f(r)} 0 1,0 ${f(-r * 2)},0 Z`).join(' ');

export const W = 1600; export const H = 180;
// The Baxter Building sits right of centre, where both the phone crop and the desktop deck see it.
export const BAXTER = { x: 1018, width: 58, top: 22 };
export const RAIL = `M-40,${H - 62} C 380,${H - 92} 820,${H - 40} 1640,${H - 78}`;

type Window = { x: number; y: number; delay: number };

// Bullet towers, saucer-topped needles, domes, and set-back slabs; taller toward both edges so
// the planet stays clear above the middle of the city.
export function skyline(seed: number, scale: number, baxter: boolean) {
  const next = random(seed);
  const parts: string[] = [];
  const windows: Window[] = [];
  const light = (x: number, y: number, width: number, height: number) => {
    if (scale !== 1 || height < 40) return;
    for (let count = 0; count < 3; count++) if (next() < .5) windows.push({ x: x + 4 + next() * Math.max(1, width - 12), y: y + 10 + next() * (height - 24), delay: next() * 11 });
  };
  let x = -10;
  while (x < W) {
    // Leave a clear lot either side of the Baxter Building; it is drawn last, on its own.
    if (baxter && x + 90 > BAXTER.x - 14 && x < BAXTER.x + BAXTER.width + 14) { x = BAXTER.x + BAXTER.width + 14; continue; }
    const kind = next();
    const edge = Math.abs(x / W - .5) * 2;
    const height = (26 + next() * 44 + edge ** 1.5 * 62) * scale;
    const y = H - height;
    if (kind < .32) {
      const width = 30 + next() * 34; const r = width / 2;
      parts.push(`M${f(x)},${H} V${f(y + r)} A${f(r)},${f(r)} 0 0 1 ${f(x + width)},${f(y + r)} V${H} Z`);
      light(x, y + r, width, height - r); x += width + 4 + next() * 10;
    } else if (kind < .52) {
      const rx = 22 + next() * 16; const ry = 5 + next() * 3; const cx = x + rx; const stalk = 7 + next() * 4;
      parts.push(`M${f(cx - stalk / 2)},${H} V${f(y)} H${f(cx + stalk / 2)} V${H} Z`,
        `M${f(cx - rx)},${f(y)} A${f(rx)},${f(ry)} 0 1 0 ${f(cx + rx)},${f(y)} A${f(rx)},${f(ry)} 0 1 0 ${f(cx - rx)},${f(y)} Z`,
        `M${f(cx - 8)},${f(y - ry + 1)} A8,8 0 0 1 ${f(cx + 8)},${f(y - ry + 1)} Z`,
        `M${f(cx - 1)},${f(y - ry - 6)} V${f(y - ry - 26 * scale)} H${f(cx + 1)} V${f(y - ry - 6)} Z`);
      x += rx * 2 + 6 + next() * 12;
    } else if (kind < .7) {
      const width = 70 + next() * 60; const base = 12 + next() * 10; const r = width * .4;
      parts.push(`M${f(x)},${H} V${f(H - base)} H${f(x + width / 2 - r)} A${f(r)},${f(r * .82)} 0 0 1 ${f(x + width / 2 + r)},${f(H - base)} H${f(x + width)} V${H} Z`);
      x += width + 6 + next() * 10;
    } else {
      const width = 34 + next() * 40; const step = 8 + next() * 10; const mid = x + width / 2;
      parts.push(`M${f(x)},${H} V${f(y + 22)} H${f(x + step)} V${f(y)} H${f(x + width - step)} V${f(y + 22)} H${f(x + width)} V${H} Z`,
        `M${f(mid - 1)},${f(y)} V${f(y - 18 * scale)} H${f(mid + 1)} V${f(y)} Z`);
      light(x + step, y, width - step * 2, height); x += width + 4 + next() * 10;
    }
  }
  if (baxter) {
    const { x: left, width, top } = BAXTER; const mid = left + width / 2;
    parts.push(`M${left},${H} V${top + 30} H${left + 8} V${top + 12} H${left + width - 8} V${top + 30} H${left + width} V${H} Z`,
      `M${mid - 2},${top + 12} V${top - 6} H${mid + 2} V${top + 12} Z`);
    for (let row = top + 40; row < H - 12; row += 11) for (let column = left + 6; column < left + width - 6; column += 9) if (next() < .42) windows.push({ x: column, y: row, delay: next() * 11 });
  }
  return { path: parts.join(' '), windows };
}

// Kirby krackle: clusters of black voids rimmed in cosmic energy along the storm's arc. Each
// cluster's voids breathe together around its lead void, in a box (in the storm's 800x400 frame)
// that becomes one small compositor layer.
export function krackle(seed: number) {
  const next = random(seed);
  const clusters: { voids: { x: number; y: number; r: number }[]; delay: number; box: { x: number; y: number; width: number; height: number } }[] = [];
  for (let cluster = 0; cluster < 26; cluster++) {
    const t = (cluster + next() * .8) / 26; const u = 1 - t;
    const cx = u * u * 30 + 2 * u * t * 300 + t * t * 780; const cy = u * u * 330 + 2 * u * t * 40 + t * t * 70;
    const swell = Math.sin(t * Math.PI); const count = 2 + Math.floor(next() * 4);
    const voids: { x: number; y: number; r: number }[] = []; let delay = 0;
    for (let index = 0; index < count; index++) {
      const angle = next() * Math.PI * 2; const reach = next() * 30 * (.4 + swell);
      voids.push({ x: cx + Math.cos(angle) * reach, y: cy + Math.sin(angle) * reach, r: (index === 0 ? 5 + next() * 7 : 1.4 + next() * 4.5) * (.45 + swell * .7) });
      const voidDelay = next() * 4; if (index === 0) delay = voidDelay;
    }
    const left = Math.min(...voids.map(dot => dot.x - dot.r)); const top = Math.min(...voids.map(dot => dot.y - dot.r));
    clusters.push({ voids, delay, box: { x: left, y: top, width: Math.max(...voids.map(dot => dot.x + dot.r)) - left, height: Math.max(...voids.map(dot => dot.y + dot.r)) - top } });
  }
  return clusters;
}
// The energy rims never move, so they paint as one element: a radial-gradient background layer per
// rim, each sized to its own square (percentages of the field, so they scale with the storm). Layers
// list topmost first, so the rims stack as the original circles did, later ones above.
function glowField(clusters: ReturnType<typeof krackle>) {
  const rims = clusters.flatMap(cluster => cluster.voids).map(dot => ({ x: dot.x, y: dot.y, r: dot.r * 3 })).reverse();
  const x0 = Math.min(...rims.map(rim => rim.x - rim.r)); const y0 = Math.min(...rims.map(rim => rim.y - rim.r));
  const width = Math.max(...rims.map(rim => rim.x + rim.r)) - x0; const height = Math.max(...rims.map(rim => rim.y + rim.r)) - y0;
  // A background-position percentage aligns that fraction of the layer with that fraction of the box.
  const place = (start: number, size: number, extent: number) => percent((start / extent) / (1 - size / extent) * 100);
  return {
    left: percent(x0 / 8), top: percent(y0 / 4), width: percent(width / 8), height: percent(height / 4),
    backgroundImage: rims.map(() => 'var(--ff-rim)').join(', '),
    backgroundSize: rims.map(rim => `${percent(rim.r * 2 / width * 100)} ${percent(rim.r * 2 / height * 100)}`).join(', '),
    backgroundPosition: rims.map(rim => `${place(rim.x - rim.r - x0, rim.r * 2, width)} ${place(rim.y - rim.r - y0, rim.r * 2, height)}`).join(', '),
  };
}

// Googie starbursts and plain stars across the upper sky. Bursts are drawn about their own centre,
// each as its own small layer placed in the sky's 1600x600 frame (fantastic.css).
export function stars(seed: number) {
  const next = random(seed);
  const bursts = Array.from({ length: 11 }, () => {
    const x = next() * 1600; const y = 30 + next() * 380; const R = 6 + next() * 10;
    const points = Array.from({ length: 16 }, (_, index) => {
      const r = index % 2 ? R * .12 : index % 4 === 0 ? R : R * .45; const angle = index * Math.PI / 8;
      return `${f(Math.sin(angle) * r)},${f(-Math.cos(angle) * r)}`;
    }).join(' ');
    return { x, y, R, points, delay: next() * 6 };
  });
  const specks = Array.from({ length: 70 }, () => ({ x: next() * 1600, y: next() * 460, r: .7 + next() * 1.3 }));
  return { bursts, specks };
}

// The 4, drawn as one counter-cut polygon so it reads at any size.
export const FOUR = 'M11,3 H15.5 V11 H17.5 V14 H15.5 V17 H12 V14 H3 V11.3 Z M12,7.6 L7.2,11 H12 Z';

export function Earth828({ prepared = false }: { prepared?: boolean }) {
  // Content and controls paint first; the scenery joins on the next idle moment and fades in.
  const [ready, setReady] = useState(prepared);
  useEffect(() => {
    if (prepared) return;
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(() => setReady(true), { timeout: 600 }); return () => cancelIdleCallback(id); }
    const id = setTimeout(() => setReady(true), 120); return () => clearTimeout(id);
  }, []);
  const id = useId().replace(/:/g, '');
  const far = useMemo(() => skyline(11, .7, false), []);
  const near = useMemo(() => skyline(4, 1, true), []);
  const storm = useMemo(() => krackle(1961), []);
  const rims = useMemo(() => glowField(storm), [storm]);
  const sky = useMemo(() => stars(828), []);
  const specks = useMemo(() => dots(sky.specks), [sky]);
  if (!ready) return null;
  const mid = BAXTER.x + BAXTER.width / 2;
  return <div className="ff-scene">
    <div className="ff-sky" data-travel />
    <div className="ff-stars" data-travel>
      <svg className="ff-specks" viewBox="0 0 1600 600" preserveAspectRatio="xMidYMin slice" focusable="false"><path className="ff-speck" d={specks} /></svg>
      {sky.bursts.map((burst, index) => <svg key={index} className="ff-burst" viewBox={`${f(-burst.R)} ${f(-burst.R)} ${f(burst.R * 2)} ${f(burst.R * 2)}`} focusable="false"
        style={{ '--x': f(burst.x), '--y': f(burst.y), '--size': f(burst.R * 2), animationDelay: `${burst.delay.toFixed(2)}s` } as CSSProperties}><polygon points={burst.points} /></svg>)}
    </div>
    <div className="ff-krackle">
      <span className="ff-krackle-glow" style={rims} />
      {storm.map(({ voids, delay, box }, group) => <svg key={group} className="ff-void" viewBox={`${f(box.x)} ${f(box.y)} ${f(box.width)} ${f(box.height)}`} focusable="false"
        style={{ left: percent(box.x / 8), top: percent(box.y / 4), width: percent(box.width / 8), height: percent(box.height / 4), animationDelay: `${delay.toFixed(2)}s`,
          transformOrigin: `${percent((voids[0].x - box.x) / box.width * 100)} ${percent((voids[0].y - box.y) / box.height * 100)}` }}><path d={dots(voids)} /></svg>)}
    </div>
    <span className="ff-herald" />
    <svg className="ff-planet" data-travel viewBox="-100 -100 200 200" focusable="false">
      <defs>
        <linearGradient id={`${id}-planet`} x1="0" y1="0" x2=".35" y2="1"><stop offset="0" className="ff-planet-light" /><stop offset=".55" className="ff-planet-mid" /><stop offset="1" className="ff-planet-dark" /></linearGradient>
        <pattern id={`${id}-dots`} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1.5" className="ff-planet-dot" /></pattern>
        <linearGradient id={`${id}-shade`} x1="0" y1="0" x2="1" y2="1"><stop offset=".45" stopColor="#000" /><stop offset="1" stopColor="#fff" /></linearGradient>
        <mask id={`${id}-shadow`}><rect x="-60" y="-60" width="120" height="120" fill={`url(#${id}-shade)`} /></mask>
        <clipPath id={`${id}-front`}><rect x="-110" y="0" width="220" height="60" /></clipPath>
      </defs>
      <g transform="rotate(-16)">
        <ellipse className="ff-ring" rx="94" ry="20" />
        <circle r="56" fill={`url(#${id}-planet)`} />
        <circle r="56" fill={`url(#${id}-dots)`} mask={`url(#${id}-shadow)`} />
        <path className="ff-band" d="M-55,-12 Q0,-4 55,-12" /><path className="ff-band" d="M-50,22 Q0,30 50,22" />
        <ellipse className="ff-ring" rx="94" ry="20" clipPath={`url(#${id}-front)`} />
      </g>
    </svg>
    <svg className="ff-skyline" data-travel viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" focusable="false">
      <path className="ff-skyline-far" d={far.path} />
      <path className="ff-skyline-near" d={near.path} />
      {near.windows.map((light, index) => <rect key={index} className="ff-window" x={f(light.x)} y={f(light.y)} width="4" height="3" rx="1" style={{ animationDelay: `${light.delay.toFixed(2)}s` }} />)}
      <g className="ff-emblem" transform={`translate(${mid} ${BAXTER.top - 20})`}><circle r="13" /><path d={FOUR} transform="translate(-10.4 -10)" /></g>
      <path className="ff-rail" d={RAIL} />
      <g className="ff-train" style={{ offsetPath: `path('${RAIL}')` }}><rect x="-38" y="-6" width="76" height="11" rx="5.5" /><path className="ff-train-windows" d="M-26,-2.5 h7 v3 h-7 Z M-14,-2.5 h7 v3 h-7 Z M-2,-2.5 h7 v3 h-7 Z M10,-2.5 h7 v3 h-7 Z M22,-2.5 h7 v3 h-7 Z" /></g>
    </svg>
    <div className="ff-bay" data-travel><span className="ff-glint" data-travel /></div>
  </div>;
}

// The sleeve's cover sits in a 1960s television: an enamel cabinet with two dials and curved
// glass. The frame stays still; only the cover inside changes.
// The set warms up (ff-tune) on each new track.
function Sleeve({ track }: { track: string }) {
  return <><span className="ff-tv" aria-hidden="true"><i /><i /></span><span className="ff-tv-glass" aria-hidden="true" /><span key={track} className="ff-tune" aria-hidden="true" /></>;
}

export const look: Look = { Scenery: Earth828, Sleeve };
