import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { Look } from '../skin';

// Haunted scenery: a hollow on All Hallows' Eve. A full moon tinted by the cover rises over two
// ridges of hills, where a crooked house keeps its windows lit, bare trees reach across the sky,
// a churchyard leans on its fence and jack-o'-lanterns burn in the grass. Fog drifts through the
// low ground; bats cross the moon behind the sleeve. Pure decoration behind the content; every
// piece is aria-hidden, and motion is gated by the ambient scene's moving state. Pieces marked
// data-travel glide between layouts (motion.ts).

function random(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const f = (value: number) => value.toFixed(1);
// Several same-coloured dots as one path, so a scene copy (RoomLight) mounts few elements.
const dots = (list: { x: number; y: number; r: number }[]) => list.map(({ x, y, r }) => `M${f(x - r)},${f(y)} a${f(r)},${f(r)} 0 1,0 ${f(r * 2)},0 a${f(r)},${f(r)} 0 1,0 ${f(-r * 2)},0 Z`).join(' ');
// A closed polygon, wound the same way as every other piece, so overlapping pieces fill as one.
const polygon = (points: [number, number][]) => `M${points.map(([x, y]) => `${f(x)},${f(y)}`).join(' L')} Z`;

export const W = 1600; export const H = 220;
// The house stands on its own crest right of centre, where both the phone crop and the desktop see it.
export const HOUSE = { x: 1150, width: 74 };
const edge = (x: number) => Math.abs(x / W - .5) * 2;
// The ridges rise toward both edges so the moon stays clear above the middle of the hollow.
export const farRidge = (x: number) => H - (78 + 22 * Math.sin(x / 210 + .6) + 12 * Math.sin(x / 83 + 2.1) + edge(x) ** 1.5 * 34) * .82;
export const nearRidge = (x: number) => H - (30 + 12 * Math.sin(x / 160 + 1.7) + 7 * Math.sin(x / 57 + .4) + edge(x) ** 1.6 * 46 + 30 * Math.exp(-(((x - HOUSE.x - HOUSE.width / 2) / 130) ** 2)));

type Light = { x: number; y: number; delay: number };
type Lantern = { x: number; y: number; r: number; delay: number };

// Bare trees: a gnarled trunk that forks into ever finer branches, each depth one stroked path.
function tree(next: () => number, x: number, y: number, height: number, lean: number, depths: string[][]) {
  const grow = (x: number, y: number, length: number, angle: number, depth: number) => {
    const bend = (next() - .5) * .7 + lean * .12;
    const mx = x + Math.cos(angle) * length * .5; const my = y + Math.sin(angle) * length * .5;
    const turned = angle + bend; const ex = mx + Math.cos(turned) * length * .5; const ey = my + Math.sin(turned) * length * .5;
    depths[depth].push(`M${f(x)},${f(y)} Q${f(mx)},${f(my)} ${f(ex)},${f(ey)}`);
    if (depth === depths.length - 1) return;
    const children = depth === 0 ? 3 : next() < .45 ? 3 : 2;
    for (let child = 0; child < children; child++) {
      const spread = (child - (children - 1) / 2) * (.5 + next() * .35) + (next() - .5) * .3 + lean * .1;
      grow(ex, ey, length * (.58 + next() * .2), turned + spread, depth + 1);
    }
  };
  grow(x, y + 4, height * .36, -Math.PI / 2 + lean * .12, 0);
}
export const TREE_WIDTHS = [7, 4.6, 3, 1.9, 1.2, .8];

// The hollow: far hills, the near ridge with its trees, the churchyard, the fence and the house,
// the house's lit windows and the jack-o'-lanterns in the grass. Seeded, so every screen agrees.
export function hollow(seed: number) {
  const next = random(seed);
  const ridge = (curve: (x: number) => number) => { const points: [number, number][] = [[0, H]]; for (let x = 0; x <= W; x += 8) points.push([x, curve(x)]); points.push([W, H]); return polygon(points); };
  const far = ridge(farRidge); const near = ridge(nearRidge);
  // The near ridge's crest alone, for the moonlight along its edge.
  const rim = `M${Array.from({ length: W / 8 + 1 }, (_, i) => `${i * 8},${f(nearRidge(i * 8))}`).join(' L')}`;

  // Far hills carry a few small trees; the near ridge one large gnarled tree at each side.
  const trees: string[][] = TREE_WIDTHS.map(() => []);
  tree(next, 228, nearRidge(228), 150, .5, trees);
  tree(next, 1452, nearRidge(1452), 118, -.6, trees);
  tree(next, 640, nearRidge(640), 64, .2, trees);
  const farTrees: string[][] = TREE_WIDTHS.map(() => []);
  for (const x of [120, 470, 860, 1330]) tree(next, x, farRidge(x), 46 + next() * 20, (next() - .5) * .8, farTrees);

  // The churchyard: leaning stones, crosses and a pointed slab, each turned about its foot.
  const stones: string[] = [];
  const turn = (points: [number, number][], x: number, y: number, angle: number): [number, number][] => points.map(([px, py]) => { const dx = px - x; const dy = py - y; return [x + dx * Math.cos(angle) - dy * Math.sin(angle), y + dx * Math.sin(angle) + dy * Math.cos(angle)]; });
  for (const x of [452, 488, 528, 571, 702, 738, 1296, 1336, 1374]) {
    const y = nearRidge(x) + 3; const width = 10 + next() * 7; const height = 13 + next() * 10; const angle = (next() - .5) * .3; const kind = next();
    const left = x - width / 2; const right = x + width / 2;
    if (kind < .55) {
      const r = width / 2; const arc: [number, number][] = Array.from({ length: 9 }, (_, i) => { const a = Math.PI + i * Math.PI / 8; return [x + Math.cos(a) * r, y - height + r + Math.sin(a) * r]; });
      stones.push(polygon(turn([[left, y], ...arc, [right, y]], x, y, angle)));
    } else if (kind < .8) {
      const bar = Math.max(2.6, width * .26); const top = y - height - 5; const arm = top + (height + 5) * .3;
      stones.push(polygon(turn([[x - bar / 2, y], [x - bar / 2, top], [x + bar / 2, top], [x + bar / 2, y]], x, y, angle)));
      stones.push(polygon(turn([[left, arm + bar / 2], [left, arm - bar / 2], [right, arm - bar / 2], [right, arm + bar / 2]], x, y, angle)));
    } else stones.push(polygon(turn([[left, y], [left, y - height], [x, y - height - width * .5], [right, y - height], [right, y]], x, y, angle)));
  }

  // A wrought-iron fence: spear-topped bars and two rails that follow the ground.
  const fence: string[] = [];
  for (let x = 780; x <= 980; x += 13) {
    const y = nearRidge(x) + 3; const top = y - 22;
    fence.push(polygon([[x - .9, y], [x - .9, top], [x - 2.4, top], [x, top - 5], [x + 2.4, top], [x + .9, top], [x + .9, y]]));
    if (x + 13 <= 980) for (const rise of [7, 17]) { const y2 = nearRidge(x + 13) + 3; fence.push(polygon([[x, y - rise - .8], [x + 13, y2 - rise - .8], [x + 13, y2 - rise + .8], [x, y - rise + .8]])); }
  }

  // The house on the hill: a gabled hall, a crooked tower with a spire and a leaning chimney.
  const { x: hx, width: hw } = HOUSE; const ground = Math.min(nearRidge(hx), nearRidge(hx + hw)) + 4; const eave = ground - 40; const towerX = hx - 4;
  const house = [
    polygon([[hx, ground], [hx, eave], [hx + hw, eave], [hx + hw, ground]]),
    polygon([[hx - 5, eave + 1], [hx + hw * .55, eave - 30], [hx + hw + 5, eave + 1]]),
    polygon([[towerX, ground], [towerX, eave - 34], [towerX + 22, eave - 36], [towerX + 22, ground]]),
    polygon([[towerX - 4, eave - 33], [towerX + 14, eave - 78], [towerX + 26, eave - 35]]),
    polygon([[hx + hw - 16, eave - 8], [hx + hw - 14, eave - 26], [hx + hw - 6, eave - 25], [hx + hw - 7, eave - 3]]),
  ];
  const windows: Light[] = [];
  for (const [x, y] of [[hx + 30, eave + 7], [hx + 46, eave + 7], [hx + 60, eave + 7], [hx + 30, eave + 22], [hx + 60, eave + 22], [towerX + 8, eave - 26], [towerX + 8, eave - 8], [hx + 42, eave - 14]] as const) if (next() < .78) windows.push({ x, y, delay: next() * 13 });

  // Jack-o'-lanterns in the grass: by the gate, the churchyard and the porch.
  const lanterns: Lantern[] = [452 + 18, 620, 764, 1000, hx + hw + 18, 1250, 1404].map(x => ({ x, y: nearRidge(x) + 1, r: 3.4 + next() * 1.8, delay: next() * 5 }));
  const stars = Array.from({ length: 96 }, () => ({ x: next() * 1600, y: next() * 470, r: .6 + next() ** 3 * 1.4 }));
  return { far, near, rim, trees: trees.map(list => list.join(' ')), farTrees: farTrees.map(list => list.join(' ')), stones: stones.join(' '), fence: fence.join(' '), house: house.join(' '), windows, lanterns, stars };
}

// A bat in flight, about its own centre, wings spread; it flaps by squashing its wings.
export const BAT = 'M0,-1.6 C1.2,-1.6 1.6,-3 1.8,-4 C2.6,-2.6 6,-3.6 11,-1.4 C8.6,-.6 7.6,1.2 7.8,2.8 C6.2,1.4 4.6,1.6 3.6,2.8 C2.8,1.6 1.4,1.6 0,3.6 C-1.4,1.6 -2.8,1.6 -3.6,2.8 C-4.6,1.6 -6.2,1.4 -7.8,2.8 C-7.6,1.2 -8.6,-.6 -11,-1.4 C-6,-3.6 -2.6,-2.6 -1.8,-4 C-1.6,-3 -1.2,-1.6 0,-1.6 Z';
// Each bat's flight across the moon: its period (s), start delay, height and size (share of the sky).
export const BATS = [
  { period: 17, delay: 0, y: .34, size: 1, wobble: .05 },
  { period: 23, delay: 6, y: .22, size: .72, wobble: .04 },
  { period: 19, delay: 11, y: .46, size: .86, wobble: .06 },
  { period: 29, delay: 3, y: .16, size: .58, wobble: .03 },
] as const;

export function Hollow({ prepared = false }: { prepared?: boolean }) {
  // Content and controls paint first; the scenery joins on the next idle moment and fades in.
  const [ready, setReady] = useState(prepared);
  useEffect(() => {
    if (prepared) return;
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(() => setReady(true), { timeout: 600 }); return () => cancelIdleCallback(id); }
    const id = setTimeout(() => setReady(true), 120); return () => clearTimeout(id);
  }, []);
  const scene = useMemo(() => hollow(1031), []);
  const stars = useMemo(() => dots(scene.stars), [scene]);
  if (!ready) return null;
  return <div className="hh-scene">
    <div className="hh-sky" data-travel />
    <div className="hh-stars" data-travel><svg viewBox="0 0 1600 600" preserveAspectRatio="xMidYMin slice" focusable="false"><path d={stars} /></svg></div>
    <div className="hh-moon" data-travel><span className="hh-moon-disc" /></div>
    <div className="hh-bats">{BATS.map((bat, index) => <svg key={index} className="hh-bat" viewBox="-12 -5 24 10" focusable="false"
      style={{ '--y': bat.y, '--size': bat.size, animationDuration: `${bat.period}s`, animationDelay: `${bat.delay}s` } as CSSProperties}><path d={BAT} /></svg>)}</div>
    <svg className="hh-hills" data-travel viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" focusable="false">
      <path className="hh-hills-far" d={scene.far} />
      {scene.farTrees.map((d, depth) => <path key={depth} className="hh-tree-far" d={d} strokeWidth={TREE_WIDTHS[depth] * .7} />)}
      <path className="hh-hills-near" d={scene.near} />
      <path className="hh-rim" d={scene.rim} />
      {scene.trees.map((d, depth) => <path key={depth} className="hh-tree" d={d} strokeWidth={TREE_WIDTHS[depth]} />)}
      <path className="hh-house" d={`${scene.house} ${scene.stones} ${scene.fence}`} />
      {scene.windows.map((light, index) => <rect key={index} className="hh-window" x={f(light.x)} y={f(light.y)} width="6" height="8" rx="1" style={{ animationDelay: `${light.delay.toFixed(2)}s` }} />)}
      {scene.lanterns.map((lantern, index) => <circle key={index} className="hh-lantern" cx={f(lantern.x)} cy={f(lantern.y - lantern.r)} r={f(lantern.r)} style={{ animationDelay: `${lantern.delay.toFixed(2)}s` }} />)}
    </svg>
    <div className="hh-ground" data-travel />
    <div className="hh-fog" data-travel />
  </div>;
}

// The sleeve's cover hangs in a candlelit frame: a thin iron border, a cobweb across one corner,
// and the warm light of a candle below it. Each new track blows a breath of fog across the cover.
function Sleeve({ track }: { track: string }) {
  return <><span className="hh-frame" aria-hidden="true" /><svg className="hh-web" viewBox="0 0 60 60" aria-hidden="true" focusable="false">
    <path d="M0,0 L60,6 M0,0 L50,22 M0,0 L36,40 M0,0 L20,54 M0,0 L5,60" />
    <path d="M12,1.2 Q11,6 10.2,9.2 Q7,10.6 4.4,11.8 Q2.4,11 1,12 M24,2.4 Q21.6,11 20.4,18.4 Q14,21 9,24 Q4,22.6 1.8,24 M38,3.8 Q34,15.6 31.6,28.2 Q22,32.6 14,37.6 Q6.4,35 2.8,36.6 M52,5.2 Q46.4,19.8 43.4,33.8" />
  </svg><span key={track} className="hh-mist" aria-hidden="true" /></>;
}

export const look: Look = { Scenery: Hollow, Sleeve };
