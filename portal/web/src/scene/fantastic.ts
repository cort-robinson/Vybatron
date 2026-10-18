import { mixOklab } from '../art';
import { BAXTER, FOUR, H as SKY_H, RAIL, W as SKY_W, krackle, skyline, stars } from '../components/Fantastic';
import { alternate, dataTexture, ease, slice, texture, type LookScene } from './shared';

// Fantastic: Earth-828 at dusk (fantastic.css). The ringed planet, the sky and the bay are drawn
// analytically; the skyline, specks and the krackle's energy rims are rasterised once into masks
// the shader tints with the cover's palette. Boxes and fades come from the unpainted .ff-* elements.
const cream = '#f3e5c8'; const suit = '#4a8fd4'; const mustard = '#e8b54a'; const flame = '#ff7a38'; const navy = '#0b1628';
const CLUSTERS = 26; const BURSTS = 11;
const tilt = -16 * Math.PI / 180; const herald = -11 * Math.PI / 180;

const glsl = `
uniform float uSceneA, uPlanetA, uLineA, uBayA, uKrackleA, uRailA, uShimmer, uPerf;
uniform vec4 uStars, uKrackle, uPlanet, uLine, uBay, uHerald, uTrain;
uniform vec4 uCluster[${CLUSTERS}], uClusterBox[${CLUSTERS}];
uniform vec4 uBurst[${BURSTS}];
uniform float uBurstA[${BURSTS}];
uniform int uWinN, uVoidN;
uniform sampler2D uLineT, uMarkT, uRimT, uSpeckT;

vec2 rot(vec2 v, float a) { float c = cos(a); float s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
// Distance to an axis-aligned ellipse outline (good near the curve, which is all a stroke needs).
float ellipse(vec2 q, vec2 r) { float k = length(q / r); return (k - 1.0) * k / max(length(q / (r * r)), 1e-4); }
// A Googie starburst: 16 points alternating long, short and fine spikes, about its centre.
float burst(vec2 q, float R) {
  float a = atan(q.x, -q.y); if (a < 0.0) a += 6.2831853;
  int k = int(a / .3926991); int j = k + 1;
  float ra = (k % 2 == 1) ? .12 : (k % 4 == 0) ? 1.0 : .45; float rb = (j % 2 == 1) ? .12 : (j % 4 == 0) ? 1.0 : .45;
  vec2 A = vec2(sin(float(k) * .3926991), -cos(float(k) * .3926991)) * ra * R; vec2 B = vec2(sin(float(j) * .3926991), -cos(float(j) * .3926991)) * rb * R;
  vec2 n = normalize(vec2(B.y - A.y, A.x - B.x)); if (dot(n, A) < 0.0) n = -n;
  return dot(q - A, n);
}
float rbox(vec2 q, vec2 h, float r) { vec2 k = abs(q) - h + r; return length(max(k, 0.0)) + min(max(k.x, k.y), 0.0) - r; }

void scenery(inout vec3 col, vec2 p) {
  if (uSceneA <= 0.0) return;
  vec4 g = vec4(0);
  float horizon = uBay.y; float planetX = uPlanet.x;
  if (p.y < horizon) {
    // Dusk: navy overhead, suit blue at altitude, a Torch-orange band where the sun just went down.
    float t = p.y / horizon;
    vec4 a = vec4(0); vec4 s = vec4(uC[5].rgb * uC[5].a, uC[5].a); vec4 f = vec4(uC[6].rgb * uC[6].a, uC[6].a); vec4 m = vec4(uC[7].rgb * uC[7].a, uC[7].a);
    vec4 sky = t < .18 ? a : t < .55 ? mix(a, s, (t - .18) / .37) : t < .88 ? mix(s, f, (t - .55) / .33) : mix(f, m, (t - .88) / .12);
    g = sky;
    float e = length((p - vec2(planetX, horizon)) / vec2(.38 * uSize.x, .46 * horizon));
    over(g, uC[4].rgb, uC[4].a * clamp(1.0 - e / .72, 0.0, 1.0));
  }
  // Specks and starbursts, in the stars' slice-fitted 1600x600 frame.
  vec2 fs = (p - uStars.xy) / uStars.zw;
  if (fs.x >= 0.0 && fs.x <= 1.0 && fs.y >= 0.0 && fs.y <= 1.0) {
    over(g, uC[8].rgb, .5 * texture(uSpeckT, fs).r);
    vec2 w = fs * vec2(1600.0, 600.0); float fw = fwidth(w.x);
    for (int i = 0; i < ${BURSTS}; i++) {
      vec4 b = uBurst[i]; vec2 q = w - b.xy;
      if (dot(q, q) > b.z * b.z) continue;
      over(g, uC[8].rgb, uBurstA[i] * disc(burst(rot(q, -b.w), b.z), fw));
    }
  }
  // Kirby krackle: energy rims, then each cluster's voids breathing about its lead void.
  if (uKrackleA > 0.0) {
    vec2 fk = (p - uKrackle.xy) / uKrackle.zw;
    vec4 k = vec4(0);
    if (fk.x >= -.1 && fk.x <= 1.1 && fk.y >= -.1 && fk.y <= 1.1) {
      vec4 r = texture(uRimT, clamp(fk, 0.0, 1.0)) * step(0.0, fk.x) * step(fk.x, 1.0) * step(0.0, fk.y) * step(fk.y, 1.0);
      k = vec4(r.r * uC[9].rgb + r.g * uC[10].rgb, r.a);
      vec2 w = fk * vec2(800.0, 400.0); float fw = fwidth(w.x);
      for (int c = 0; c < ${CLUSTERS}; c++) {
        vec4 box = uClusterBox[c];
        if (w.x < box.x || w.y < box.y || w.x > box.z || w.y > box.w) continue;
        vec4 cl = uCluster[c]; int last = c + 1 < ${CLUSTERS} ? int(uCluster[c + 1].w) : uVoidN;
        vec2 q = cl.xy + (w - cl.xy) / cl.z;
        for (int i = int(cl.w); i < last; i++) { vec4 v = datum(i, 1); over(k, uC[11].rgb, disc(length(q - v.xy) - v.z, fw / cl.z)); }
      }
    }
    place(g, k, uKrackleA);
  }
  // The Silver Surfer, now and then.
  if (uHerald.w > 0.0) {
    vec2 q = rot(p - uHerald.xy, ${(-herald).toFixed(6)}); float h = uHerald.z * .5;
    float x = (q.x + h) / uHerald.z;
    if (x >= 0.0 && x <= 1.0 && abs(q.y) < 1.5) {
      vec4 c = x < .6 ? vec4(vec3(.839, .886, .961), .35 * x / .6) : mix(vec4(vec3(.839, .886, .961), .35), vec4(.957, .973, 1.0, 1.0), (x - .6) / .4);
      over(g, c.rgb, c.a * clamp(1.5 - abs(q.y), 0.0, 1.0) * uHerald.w);
    }
    float d = length(q - vec2(h - 1.0, 0.0));
    over(g, vec3(.839, .902, 1.0), .8 * exp(-pow(max(d - 6.0, 0.0) / 5.0, 2.0)) * uHerald.w);
    over(g, vec3(1.0), disc(d - 3.0, 1.0 / uScale) * uHerald.w);
  }
  // The planet, in its own -100..100 frame, tilted -16deg: back ring, disc, Ben-Day shading, bands, front ring.
  if (uPlanetA > 0.0) {
    vec2 l = rot((p - uPlanet.xy) / uPlanet.z, ${(-tilt).toFixed(6)});
    if (max(abs(l.x), abs(l.y)) < 100.0) {
      float px = fwidth(l.x); vec4 pl = vec4(0);
      float ring = line(ellipse(l, vec2(94.0, 20.0)), 2.25, px);
      over(pl, uC[16].rgb, ring);
      float body = disc(length(l) - 56.0, px);
      if (body > 0.0) {
        vec2 dir = vec2(39.2, 112.0); float t = dot(l + 56.0, dir) / dot(dir, dir);
        vec3 c = t < .55 ? mix(uC[12].rgb, uC[13].rgb, clamp(t / .55, 0.0, 1.0)) : mix(uC[13].rgb, uC[14].rgb, clamp((t - .55) / .45, 0.0, 1.0));
        over(pl, c, body);
        float shade = clamp(((l.x + l.y + 120.0) / 240.0 - .45) / .55, 0.0, 1.0);
        over(pl, uC[15].rgb, .6 * shade * body * disc(length(mod(l, 6.0) - 3.0) - 1.5, px));
        float t1 = clamp((l.x + 55.0) / 110.0, 0.0, 1.0); float t2 = clamp((l.x + 50.0) / 100.0, 0.0, 1.0);
        float b1 = length(vec2(l.x - clamp(l.x, -55.0, 55.0), l.y - (-12.0 + 16.0 * t1 * (1.0 - t1))));
        float b2 = length(vec2(l.x - clamp(l.x, -50.0, 50.0), l.y - (22.0 + 16.0 * t2 * (1.0 - t2))));
        over(pl, uC[8].rgb, .2 * max(line(b1, 1.5, px), line(b2, 1.5, px)));
      }
      if (l.y > 0.0) over(pl, uC[16].rgb, ring);
      place(g, pl, uPlanetA);
    }
  }
  // The Googie skyline, the Baxter Building's emblem, the rail and its monorail.
  vec2 uv = (p - uLine.xy) / uLine.zw;
  if (uLineA > 0.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    vec3 m = texture(uLineT, uv).rgb; vec3 k = texture(uMarkT, uv).rgb; vec4 l = vec4(0);
    over(l, uC[17].rgb, uC[17].a * m.r); over(l, uC[18].rgb, m.g); over(l, uC[8].rgb, .26 * m.b);
    // The masks carry 25% headroom over the viewBox (antennas, the emblem); w is in viewBox units.
    vec2 w = uv * vec2(${SKY_W}.0, ${SKY_H * 1.25}) - vec2(0.0, ${SKY_H * .25}); vec2 fw = fwidth(w);
    for (int i = 0; i < uWinN; i++) {
      vec4 win = datum(i, 0);
      float cov = cover(w.x, win.x, win.x + 4.0, fw.x) * cover(w.y, win.y, win.y + 3.0, fw.y);
      if (cov > 0.0) over(l, uC[19].rgb, blink(win.z) * cov);
    }
    over(l, uC[20].rgb, k.g); over(l, uC[8].rgb, k.b);
    over(l, uC[8].rgb, .42 * k.r * uRailA);
    if (uTrain.w > 0.0) {
      vec2 q = rot(w - uTrain.xy, -uTrain.z);
      float body = disc(rbox(q - vec2(0.0, -.5), vec2(38.0, 5.5), 5.5), fw.x);
      if (body > 0.0) {
        over(l, uC[8].rgb, body * uTrain.w);
        float pane = abs(q.y + 1.0) < 1.5 && q.x > -26.0 && q.x < 29.0 && mod(q.x + 26.0, 12.0) < 7.0 ? 1.0 : 0.0;
        over(l, uC[15].rgb, pane * body * uTrain.w);
      }
    }
    place(g, l, uLineA);
  }
  // The bay: piping on the horizon, Ben-Day dots in the shallows and the planet's rippling reflection.
  float y = p.y - uBay.y; float x = p.x - uBay.x;
  if (uBayA > 0.0 && y >= 0.0 && x >= 0.0 && x <= uBay.z) {
    float f = y / uBay.w;
    vec4 b = vec4(f < .35 ? mix(uC[21].rgb, uC[22].rgb, f / .35) : mix(uC[22].rgb, uC[0].rgb, clamp((f - .35) / .5, 0.0, 1.0)), 1.0);
    vec2 cell = mod(vec2(x, y), 9.0) - 4.5;
    over(b, uC[8].rgb, .2 * clamp((1.8 - length(cell)) / .5, 0.0, 1.0) * (uPerf > 0.0 ? .5 : clamp(1.0 - f / .75, 0.0, 1.0)));
    if (uPerf <= 0.0) {
      float gw = uPlanet.z * 200.0 * .42; vec2 gq = vec2(p.x - planetX, y - 6.0);
      if (abs(gq.x) < gw * .5 && gq.y >= 0.0 && gq.y < uBay.w * .8) {
        float mask = clamp(1.0 - length(vec2(gq.x / (gw * .5), gq.y / (uBay.w * .8))), 0.0, 1.0);
        float stripe = cover(mod(gq.y + 8.0 - uShimmer, 8.0), 0.0, 2.0, 1.0 / uScale);
        over(b, uC[9].rgb, .55 * mask * stripe);
      }
    }
    if (y < 1.0) over(b, uC[8].rgb, .7); else if (y >= 3.0 && y < 4.0) over(b, uC[20].rgb, .62);
    place(g, b, uBayA);
  }
  col = col * (1.0 - g.a * uSceneA) + g.rgb * uSceneA;
}`;

// The monorail's place along the rail: arc length of its cubic, sampled once.
const railPoints = (() => {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = RAIL.match(/-?[\d.]+/g)!.map(Number);
  const at = (t: number) => { const u = 1 - t; return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]; };
  const samples = Array.from({ length: 241 }, (_, i) => at(i / 240));
  const lengths = samples.map((_, i) => i ? Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]) : 0);
  for (let i = 1; i < lengths.length; i++) lengths[i] += lengths[i - 1];
  return { samples, lengths, total: lengths.at(-1)! };
})();
function train(share: number) {
  const target = share * railPoints.total; let i = railPoints.lengths.findIndex(length => length >= target); i = Math.max(1, i < 0 ? railPoints.lengths.length - 1 : i);
  const [ax, ay] = railPoints.samples[i - 1]; const [bx, by] = railPoints.samples[i];
  const k = (target - railPoints.lengths[i - 1]) / Math.max(1e-6, railPoints.lengths[i] - railPoints.lengths[i - 1]);
  return [ax + (bx - ax) * k, ay + (by - ay) * k, Math.atan2(by - ay, bx - ax)];
}
const segment = (from: number, to: number, k: number) => from + (to - from) * ease(k);
function twinkle(clock: number, delay: number) {
  if (clock < delay) return [1, 0, .85];
  const t = ((clock - delay) / 6) % 1;
  if (t < .7) return [1, 0, .85];
  if (t < .8) { const k = (t - .7) / .1; return [segment(1, 1.5, k), segment(0, 22, k), segment(.85, 1, k)]; }
  if (t < .9) { const k = (t - .8) / .1; return [segment(1.5, .7, k), segment(22, 0, k), segment(1, .5, k)]; }
  const k = (t - .9) / .1; return [segment(.7, 1, k), 0, segment(.5, .85, k)];
}

export const fantastic: LookScene = {
  glsl, vignette: .45,
  matches: top => !!top.querySelector('.ff-scene'),
  colors: (accent, ground, glow) => {
    const base = mixOklab(navy, ground, .52);
    return [
      [base, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1],
      [accent, .24], [suit, .13], [flame, .22], [mustard, .34],
      [cream, 1], [mixOklab(accent, cream, .55), 1], [mixOklab(flame, accent, .55), 1], [mixOklab(base, '#000000', .4), 1],
      [mixOklab(accent, cream, .88), 1], [mixOklab(accent, mixOklab(mustard, flame, .5), .82), 1], [mixOklab(navy, mixOklab(accent, flame, .4), .45), 1],
      [navy, 1], [mixOklab(flame, cream, .8), 1],
      [mixOklab(base, suit, .3), .72], [mixOklab(base, '#04080f', .55), 1], [mustard, 1], [suit, 1],
      [mixOklab(base, flame, .22), 1], [mixOklab(base, suit, .14), 1],
    ];
  },
  create(gl) {
    const far = skyline(11, .7, false); const near = skyline(4, 1, true);
    const canvas = (width: number, height: number, frameW: number, frameH: number) => {
      const c = Object.assign(document.createElement('canvas'), { width, height });
      const x = c.getContext('2d')!; x.scale(width / frameW, height / frameH);
      return { c, x };
    };
    // Skyline masks: far, near and near edge (red, green, blue); then the rail, the emblem's suit
    // disc and its cream rim and 4. The top 20% of the frame is headroom for antennas over the box.
    const LINE_H = SKY_H * 1.25;
    const lines = canvas(2048, 288, SKY_W, LINE_H); const marks = canvas(2048, 288, SKY_W, LINE_H);
    for (const { x } of [lines, marks]) { x.translate(0, LINE_H - SKY_H); x.fillStyle = '#000'; x.fillRect(0, SKY_H - LINE_H, SKY_W, LINE_H); x.globalCompositeOperation = 'lighter'; }
    lines.x.fillStyle = '#f00'; lines.x.fill(new Path2D(far.path)); lines.x.fillStyle = '#0f0'; lines.x.fill(new Path2D(near.path));
    lines.x.strokeStyle = '#00f'; lines.x.lineWidth = 1.4; lines.x.stroke(new Path2D(near.path));
    marks.x.strokeStyle = '#f00'; marks.x.lineWidth = 2.5; marks.x.stroke(new Path2D(RAIL));
    const mid = BAXTER.x + BAXTER.width / 2; const emblem = new Path2D(); emblem.arc(mid, BAXTER.top - 20, 13, 0, Math.PI * 2);
    marks.x.fillStyle = '#0f0'; marks.x.fill(emblem);
    marks.x.fillStyle = '#00f'; marks.x.strokeStyle = '#00f'; marks.x.lineWidth = 2.2; marks.x.stroke(emblem);
    marks.x.save(); marks.x.translate(mid - 10.4, BAXTER.top - 30); marks.x.fill(new Path2D(FOUR), 'evenodd'); marks.x.restore();
    const lineT = texture(gl, 2, lines.c, { mipmap: true }); const markT = texture(gl, 4, marks.c, { mipmap: true });

    const sky = stars(828);
    const specks = canvas(2048, 768, 1600, 600); specks.x.fillStyle = '#fff';
    for (const { x, y, r } of sky.specks) { specks.x.beginPath(); specks.x.arc(x, y, r, 0, Math.PI * 2); specks.x.fill(); }
    const speckT = texture(gl, 6, specks.c, { mipmap: true });

    // Energy rims: inner color weight in red, outer in green, coverage in alpha (premultiplied, so
    // overlapping rims add up as the stacked gradients did).
    const storm = krackle(1961);
    const rims = canvas(1024, 512, 800, 400);
    for (const dot of storm.flatMap(cluster => cluster.voids)) {
      const r = dot.r * 3; const gradient = rims.x.createRadialGradient(dot.x, dot.y, 0, dot.x, dot.y, r);
      gradient.addColorStop(0, 'rgba(255,0,0,1)'); gradient.addColorStop(.55, 'rgba(0,255,0,.5)'); gradient.addColorStop(1, 'rgba(0,255,0,0)');
      rims.x.fillStyle = gradient; rims.x.fillRect(dot.x - r, dot.y - r, r * 2, r * 2);
    }
    const rimT = texture(gl, 5, rims.c, { premultiply: true });
    const voids: number[][] = []; const firsts: number[] = [];
    storm.forEach((cluster, index) => { firsts.push(voids.length); cluster.voids.forEach(dot => voids.push([dot.x, dot.y, dot.r, index])); });
    const boxes = new Float32Array(storm.flatMap(({ voids: [lead], box }) => {
      // The box a cluster can reach at its largest (1.12x about its lead void).
      const grow = 1.15; return [lead.x + (box.x - lead.x) * grow - 1, lead.y + (box.y - lead.y) * grow - 1, lead.x + (box.x + box.width - lead.x) * grow + 1, lead.y + (box.y + box.height - lead.y) * grow + 1];
    }));
    gl.activeTexture(gl.TEXTURE3);
    const data = dataTexture(gl, [near.windows.map(w => [w.x, w.y, w.delay, 0]), voids]);
    const units: [number, WebGLTexture][] = [[2, lineT], [3, data], [4, markT], [5, rimT], [6, speckT]];

    return {
      feed({ gl, u, top, clock, performance, width, height, opacity }) {
        for (const [unit, t] of units) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
        gl.uniform1i(u.uLineT, 2); gl.uniform1i(u.uData, 3); gl.uniform1i(u.uMarkT, 4); gl.uniform1i(u.uRimT, 5); gl.uniform1i(u.uSpeckT, 6);
        const root = top.querySelector('.ff-scene')!;
        const sceneA = opacity(root); gl.uniform1f(u.uSceneA, sceneA);
        const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
        const starsBox = box('.ff-stars'); const unit = Math.max(starsBox.width / 1600, starsBox.height / 600);
        gl.uniform4f(u.uStars, starsBox.left + starsBox.width / 2 - 800 * unit, starsBox.top, 1600 * unit, 600 * unit);
        const twinkles = sky.bursts.map(b => twinkle(clock, b.delay));
        gl.uniform4fv(u.uBurst, new Float32Array(sky.bursts.flatMap((b, i) => [b.x, b.y, b.R * twinkles[i][0], twinkles[i][1] * Math.PI / 180])));
        gl.uniform1fv(u.uBurstA, new Float32Array(twinkles.map(t => t[2])));

        const krackleEl = root.querySelector('.ff-krackle')!; const k = krackleEl.getBoundingClientRect();
        gl.uniform1f(u.uKrackleA, opacity(krackleEl)); gl.uniform4f(u.uKrackle, k.left, k.top, k.width, k.height);
        gl.uniform4fv(u.uCluster, new Float32Array(storm.flatMap((cluster, i) => [cluster.voids[0].x, cluster.voids[0].y, clock < cluster.delay ? 1 : .82 + .3 * alternate(clock - cluster.delay, 3.4), firsts[i]])));
        gl.uniform4fv(u.uClusterBox, boxes); gl.uniform1i(u.uVoidN, voids.length);

        // The herald crosses for 11% of a 23s cycle that starts 5s in; reduced effects omit him.
        let heraldA = 0; let travel = -.4 * width;
        if (!performance && clock >= 5) {
          const t = ((clock - 5) / 23) % 1; travel = t < .11 ? -.4 * width + 1.7 * width * t / .11 : 1.3 * width;
          heraldA = t < .01 ? t / .01 : t < .09 ? 1 : t < .11 ? 1 - (t - .09) / .02 : 0;
        }
        const heraldW = Math.min(260, Math.max(140, width * .16));
        gl.uniform4f(u.uHerald, heraldW / 2 + travel * Math.cos(herald), height * .3 + 1 + travel * Math.sin(herald), heraldW, heraldA);

        const planet = root.querySelector('.ff-planet')!; const pb = planet.getBoundingClientRect();
        gl.uniform4f(u.uPlanet, pb.left + pb.width / 2, pb.top + pb.height / 2, pb.width / 200, 0); gl.uniform1f(u.uPlanetA, opacity(planet));

        const line = root.querySelector('.ff-skyline')!; const [lx, ly, lw, lh] = slice(line.getBoundingClientRect(), SKY_W, SKY_H);
        // The masks carry 25% headroom above the viewBox for antennas and the emblem.
        gl.uniform4f(u.uLine, lx, ly - lh * .25, lw, lh * 1.25); gl.uniform1f(u.uLineA, opacity(line));
        gl.uniform1i(u.uWinN, near.windows.length);
        gl.uniform4f(u.uBlinkT, 11, .37, .44, .81); gl.uniform2f(u.uBlinkV, .2, .45);
        const railA = opacity(root.querySelector('.ff-rail')); gl.uniform1f(u.uRailA, railA);
        // ff-monorail: 34% to the end of the rail over 66% of 26s, then round from the start.
        const ride = (clock / 26) % 1; const [tx, ty, ta] = train(ride < .66 ? .34 + ride : (ride - .66) / .34 * .34);
        gl.uniform4f(u.uTrain, tx, ty, ta, opacity(root.querySelector('.ff-train')));

        const bay = root.querySelector('.ff-bay')!; const bb = bay.getBoundingClientRect();
        gl.uniform4f(u.uBay, bb.left, bb.top, bb.width, bb.height); gl.uniform1f(u.uBayA, opacity(bay));
        gl.uniform1f(u.uShimmer, (clock / 2.4 % 1) * 8); gl.uniform1f(u.uPerf, performance ? 1 : 0);
      },
    };
  },
};
