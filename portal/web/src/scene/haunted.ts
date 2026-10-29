import { mixOklab } from '../art';
import { BATS, H as HILL_H, TREE_WIDTHS, W as HILL_W, hollow } from '../components/Haunted';
import { dataTexture, slice, texture, type LookScene } from './shared';

// Haunted: the hollow on All Hallows' Eve (haunted.css). The sky, the moon and its passing clouds,
// the bats and the fog are drawn analytically; the hills, trees, churchyard and house are rasterised
// once into a mask the shader tints, and the house's windows and the jack-o'-lanterns flicker from
// data rows. Boxes and fades come from the unpainted .hh-* elements.
const night = '#0b0812'; const violet = '#2a1742'; const plum = '#4a2660'; const pumpkin = '#ff7a1a';
const candle = '#ffd58a'; const witch = '#a6e86e'; const moon = '#f2ead6';
const BAT_N = BATS.length;
// The hill masks carry this much headroom over the viewBox, for the tallest trees and the spire.
const HEAD = .3;

const glsl = `
uniform float uSceneA, uLineA, uGroundA, uFogA, uLifeA, uPerf;
uniform vec4 uStars, uMoon, uLine, uGround, uFog;
uniform vec4 uBat[${BAT_N}];
uniform int uWinN, uLanN;
uniform sampler2D uLineT, uSpeckT;

float hh(vec2 p) { vec3 q = fract(p.xyx * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hh(i), hh(i + vec2(1, 0)), f.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p, int octaves) { float s = 0.0; float a = .5; float n = 0.0;
  for (int i = 0; i < 3; i++) { if (i >= octaves) break; s += a * noise(p); n += a; p = p * 2.03 + 17.1; a *= .5; }
  return s / n; }
// A bat about its centre, a unit of half its wingspan; flap -1 (down) to 1 (up). Coverage over a pixel w.
float bat(vec2 q, float flap, float w) {
  float x = abs(q.x);
  float top = .06 + x * (.05 + .3 * flap);
  float bottom = top - (.3 * (1.0 - x) + .05) + .1 * abs(sin(x * 9.42)) * (1.0 - .4 * x);
  float wing = max(max(bottom - q.y, q.y - top), x - 1.0);
  float body = length(q / vec2(.11, .2)) - 1.0;
  float head = length(q - vec2(0.0, .17)) - .085;
  float ears = max(abs(x - .05) - .03, abs(q.y - .27) - .05);
  float d = min(min(wing, body * .11), min(head, ears));
  return clamp(.5 - d / w, 0.0, 1.0);
}
// The moon's near side: its great seas as soft blobs, their shores roughened by noise, and a
// fine speckle of craters over the highlands. m is in moon radii, y up.
float maria(vec2 m, float rough) {
  float a = exp(-dot((m - vec2(-.3, .3)) / vec2(.34, .26), (m - vec2(-.3, .3)) / vec2(.34, .26)));
  a = max(a, exp(-dot((m - vec2(.16, .3)) / vec2(.2, .17), (m - vec2(.16, .3)) / vec2(.2, .17))));
  a = max(a, exp(-dot((m - vec2(.34, .04)) / vec2(.25, .19), (m - vec2(.34, .04)) / vec2(.25, .19))));
  a = max(a, exp(-dot((m - vec2(-.56, -.06)) / vec2(.24, .46), (m - vec2(-.56, -.06)) / vec2(.24, .46))));
  a = max(a, exp(-dot((m - vec2(-.2, -.4)) / vec2(.22, .15), (m - vec2(-.2, -.4)) / vec2(.22, .15))));
  a = max(a, exp(-dot((m - vec2(.6, .3)) / vec2(.11, .1), (m - vec2(.6, .3)) / vec2(.11, .1))));
  return smoothstep(.32, .72, a + (rough - .5) * .55);
}
float flicker(float delay) { return .8 + .12 * sin(uClock * 9.1 + delay * 3.0) + .08 * sin(uClock * 23.7 + delay * 7.0); }

void scenery(inout vec3 col, vec2 p) {
  if (uSceneA <= 0.0) return;
  vec4 g = vec4(0);
  float horizon = uGround.y;
  vec2 m = (p - uMoon.xy) / max(uMoon.z, 1.0); float mr = length(m);
  if (p.y < horizon) {
    // Night: the room's own light overhead, violet at altitude, plum toward the hills, an ember of dusk.
    float t = p.y / horizon;
    vec4 a = vec4(0); vec4 v = vec4(uC[5].rgb * uC[5].a, uC[5].a); vec4 pl = vec4(uC[6].rgb * uC[6].a, uC[6].a); vec4 e = vec4(uC[7].rgb * uC[7].a, uC[7].a);
    g = t < .12 ? a : t < .52 ? mix(a, v, (t - .12) / .4) : t < .86 ? mix(v, pl, (t - .52) / .34) : mix(pl, e, (t - .86) / .14);
    over(g, uC[4].rgb, uC[4].a * uMoon.w * clamp(1.0 - mr / 2.6, 0.0, 1.0) * clamp(1.0 - mr / 2.6, 0.0, 1.0));
    // Stars, in their slice-fitted 1600x600 frame, thinning toward the hills and the moon.
    vec2 fs = (p - uStars.xy) / uStars.zw;
    if (fs.x >= 0.0 && fs.x <= 1.0 && fs.y >= 0.0 && fs.y <= 1.0)
      over(g, uC[8].rgb, .5 * texture(uSpeckT, fs).r * (1.0 - smoothstep(.6, .95, t)) * smoothstep(1.2, 2.4, mr));
  }
  // The full moon: limb-darkened bone, its seas, a mist halo, and clouds drifting across it.
  if (uMoon.w > 0.0 && mr < 3.0) {
    float w = 1.0 / (uMoon.z * uScale);
    over(g, uC[9].rgb, uMoon.w * (.34 * exp(-max(mr - 1.0, 0.0) * 5.0) + .12 * exp(-max(mr - 1.0, 0.0) * 1.4)) * step(1.0, mr));
    float inside = clamp((1.0 - mr) / w + .5, 0.0, 1.0);
    if (inside > 0.0) {
      float limb = sqrt(max(0.0, 1.0 - mr * mr));
      vec2 mu = vec2(m.x, -m.y);
      vec3 c = mix(uC[9].rgb, uC[10].rgb, maria(mu, fbm(mu * 2.6 + 4.2, uPerf > 0.0 ? 2 : 3)) * .5 + (noise(mu * 22.0) - .5) * .06);
      c = mix(uC[10].rgb, c, .7 + .3 * limb);
      over(g, c, inside * uMoon.w);
    }
    if (uPerf <= 0.0 && mr < 2.2) {
      float bank = exp(-pow((m.y - .3 - .14 * sin(m.x * 1.4)) / .36, 2.0));
      float cloud = smoothstep(.44, .76, fbm(vec2(m.x * .85 + uClock * .012, m.y * 1.7 + 11.0), 3)) * bank;
      over(g, uC[11].rgb, .7 * cloud * uMoon.w * clamp(2.2 - mr, 0.0, 1.0));
    }
  }
  // Bats crossing the moon (the sleeve and sign-in only).
  if (uLifeA > 0.0) {
    for (int i = 0; i < ${BAT_N}; i++) {
      vec4 b = uBat[i]; vec2 q = (p - b.xy) / b.z;
      if (abs(q.x) > 1.2 || abs(q.y) > .8) continue;
      over(g, uC[20].rgb, uLifeA * bat(vec2(q.x, -q.y), sin(b.w), 1.0 / (b.z * uScale)));
    }
  }
  // The hollow: far hills and trees, the near ridge with its trees, churchyard, fence and house,
  // the moon's rim on the near ridge, the house's windows and the jack-o'-lanterns.
  vec2 uv = (p - uLine.xy) / uLine.zw;
  if (uLineA > 0.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
    vec3 k = texture(uLineT, uv).rgb; vec4 l = vec4(0);
    over(l, uC[12].rgb, k.r); over(l, uC[13].rgb, k.g); over(l, uC[14].rgb, uC[14].a * k.b);
    vec2 w = uv * vec2(${HILL_W}.0, ${(HILL_H * (1 + HEAD)).toFixed(1)}) - vec2(0.0, ${(HILL_H * HEAD).toFixed(1)}); vec2 fw = fwidth(w);
    for (int i = 0; i < uWinN; i++) {
      vec4 win = datum(i, 0);
      float cov = cover(w.x, win.x, win.x + 6.0, fw.x) * cover(w.y, win.y, win.y + 8.0, fw.y);
      over(l, uC[15].rgb, .55 * blink(win.z) * exp(-length(w - win.xy - vec2(3.0, 4.0)) / 9.0) * (1.0 - cov));
      if (cov > 0.0) over(l, uC[15].rgb, blink(win.z) * cov);
    }
    for (int i = 0; i < uLanN; i++) {
      vec4 lan = datum(i, 1); float fl = uPerf > 0.0 ? .9 : flicker(lan.w);
      float d = length(w - lan.xy + vec2(0.0, lan.z));
      over(l, uC[16].rgb, .5 * fl * exp(-max(d - lan.z, 0.0) / (lan.z * 2.4)));
      float body = disc(d - lan.z, fw.x);
      if (body > 0.0) over(l, mix(uC[16].rgb, uC[17].rgb, fl * (1.0 - d / lan.z) * .7), body);
    }
    place(g, l, uLineA);
  }
  // The low ground below the hills.
  float y = p.y - uGround.y;
  if (uGroundA > 0.0 && y >= 0.0) {
    float f = y / max(uGround.w, 1.0);
    place(g, vec4(f < .4 ? mix(uC[18].rgb, uC[19].rgb, f / .4) : mix(uC[19].rgb, uC[0].rgb, clamp((f - .4) / .45, 0.0, 1.0)), 1.0), uGroundA);
  }
  // Ground fog: two banks drifting at different speeds through the low ground.
  float fy = (p.y - uFog.y) / max(uFog.w, 1.0);
  if (uFogA > 0.0 && fy > 0.0 && fy < 1.0) {
    float profile = smoothstep(0.0, .4, fy) * (1.0 - smoothstep(.62, 1.0, fy));
    vec2 q = vec2(p.x / 260.0, p.y / 64.0);
    float bank = fbm(q + vec2(uClock * .016, 0.0), uPerf > 0.0 ? 1 : 3);
    if (uPerf <= 0.0) bank = max(bank, fbm(q * 1.6 + vec2(-uClock * .027, 5.3), 2) * .92);
    over(g, uC[21].rgb, uC[21].a * uFogA * profile * smoothstep(.38, .78, bank));
    // Will-o'-wisps drift in it, in the sleeve.
    if (uLifeA > 0.0) for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 at = vec2(uFog.x + uFog.z * fract(.21 + fi * .37 + uClock * (.006 + fi * .002)), uFog.y + uFog.w * (.52 + .1 * sin(uClock * .6 + fi * 2.3)));
      float d = length(p - at);
      over(g, uC[22].rgb, uLifeA * (.5 + .3 * sin(uClock * 2.1 + fi * 4.0)) * exp(-d / 7.0) * .7);
    }
  }
  col = col * (1.0 - g.a * uSceneA) + g.rgb * uSceneA;
}`;

export const haunted: LookScene = {
  glsl, vignette: .42,
  matches: top => !!top.querySelector('.hh-scene'),
  colors: (accent, ground, glow) => {
    const base = mixOklab(night, ground, .36); const face = mixOklab(moon, accent, .14); const iron = mixOklab(base, '#040208', .62);
    return [
      [base, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1],
      [mixOklab(face, accent, .3), .22], [violet, .42], [plum, .48], [pumpkin, .24],
      [moon, 1], [mixOklab(face, '#fffbf2', .3), 1], [mixOklab(mixOklab(face, plum, .3), '#7a6a80', .45), 1], [mixOklab(night, plum, .35), 1],
      [mixOklab(base, plum, .34), 1], [iron, 1], [moon, .2],
      [candle, 1], [pumpkin, 1], [candle, 1],
      [mixOklab(iron, pumpkin, .07), 1], [mixOklab(base, plum, .1), 1],
      [mixOklab(night, '#000000', .3), 1], [mixOklab(mixOklab(moon, plum, .4), accent, .1), .36], [witch, 1],
    ];
  },
  create(gl) {
    const scene = hollow(1031);
    const LINE_H = HILL_H * (1 + HEAD);
    const canvas = (width: number, height: number, frameW: number, frameH: number) => {
      const c = Object.assign(document.createElement('canvas'), { width, height });
      const x = c.getContext('2d')!; x.scale(width / frameW, height / frameH);
      return { c, x };
    };
    // Far hills and trees in red, the near ridge and everything on it in green, its moonlit edge in blue.
    const lines = canvas(2048, 364, HILL_W, LINE_H); const x = lines.x;
    x.translate(0, LINE_H - HILL_H); x.fillStyle = '#000'; x.fillRect(0, HILL_H - LINE_H, HILL_W, LINE_H); x.globalCompositeOperation = 'lighter';
    x.lineCap = 'round'; x.lineJoin = 'round';
    x.fillStyle = '#f00'; x.fill(new Path2D(scene.far)); x.strokeStyle = '#f00';
    scene.farTrees.forEach((d, depth) => { x.lineWidth = TREE_WIDTHS[depth] * .7; x.stroke(new Path2D(d)); });
    // The near ridge and everything on it fill one channel together on a canvas of their own, so
    // their overlapping edges don't add up; then it joins the far hills.
    const near = document.createElement('canvas'); near.width = lines.c.width; near.height = lines.c.height;
    const n = near.getContext('2d')!; n.scale(lines.c.width / HILL_W, lines.c.height / LINE_H); n.translate(0, LINE_H - HILL_H); n.lineCap = 'round'; n.lineJoin = 'round';
    n.fillStyle = '#0f0'; n.strokeStyle = '#0f0';
    n.fill(new Path2D(scene.near)); n.fill(new Path2D(`${scene.house} ${scene.stones} ${scene.fence}`));
    scene.trees.forEach((d, depth) => { n.lineWidth = TREE_WIDTHS[depth]; n.stroke(new Path2D(d)); });
    n.globalCompositeOperation = 'lighter'; n.strokeStyle = '#00f'; n.lineWidth = 1.2; n.stroke(new Path2D(scene.rim));
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalCompositeOperation = 'lighter'; x.drawImage(near, 0, 0);
    const lineT = texture(gl, 2, lines.c, { mipmap: true });

    const specks = canvas(2048, 768, 1600, 600); specks.x.fillStyle = '#fff';
    for (const { x: sx, y, r } of scene.stars) { specks.x.beginPath(); specks.x.arc(sx, y, r, 0, Math.PI * 2); specks.x.fill(); }
    const speckT = texture(gl, 6, specks.c, { mipmap: true });
    gl.activeTexture(gl.TEXTURE3);
    const data = dataTexture(gl, [scene.windows.map(w => [w.x, w.y, w.delay, 0]), scene.lanterns.map(l => [l.x, l.y, l.r, l.delay])]);
    const units: [number, WebGLTexture][] = [[2, lineT], [3, data], [6, speckT]];

    // The last measurement (boxes and fades of the unpainted .hh-* elements), and per-frame buffers.
    const starsBox = new Float32Array(4); const moonBox = new Float32Array(4); const lineBox = new Float32Array(4);
    const groundBox = new Float32Array(4); const fogBox = new Float32Array(4); const bats = new Float32Array(BAT_N * 4);
    let sceneA = 0; let lineA = 0; let groundA = 0; let fogA = 0; let lifeA = 0;
    return {
      measure({ top, opacity }) {
        const root = top.querySelector('.hh-scene')!;
        sceneA = opacity(root);
        const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
        const s = box('.hh-stars'); const unit = Math.max(s.width / 1600, s.height / 600);
        starsBox.set([s.left + s.width / 2 - 800 * unit, s.top, 1600 * unit, 600 * unit]);
        const moonEl = root.querySelector('.hh-moon')!; const mb = moonEl.getBoundingClientRect();
        moonBox.set([mb.left + mb.width / 2, mb.top + mb.height / 2, mb.width / 2, opacity(moonEl)]);
        const line = root.querySelector('.hh-hills')!; const [lx, ly, lw, lh] = slice(line.getBoundingClientRect(), HILL_W, HILL_H);
        lineBox.set([lx, ly - lh * HEAD, lw, lh * (1 + HEAD)]); lineA = opacity(line);
        const ground = root.querySelector('.hh-ground')!; const gb = ground.getBoundingClientRect();
        groundBox.set([gb.left, gb.top, gb.width, gb.height]); groundA = opacity(ground);
        const fog = root.querySelector('.hh-fog')!; const fb = fog.getBoundingClientRect();
        fogBox.set([fb.left, fb.top, fb.width, fb.height]); fogA = opacity(fog);
        lifeA = opacity(root.querySelector('.hh-bats'));
      },
      feed({ gl, u, clock, performance, width }) {
        for (const [unit, t] of units) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
        gl.uniform1i(u.uLineT, 2); gl.uniform1i(u.uData, 3); gl.uniform1i(u.uSpeckT, 6);
        gl.uniform1f(u.uSceneA, sceneA); gl.uniform1f(u.uPerf, performance ? 1 : 0);
        gl.uniform4fv(u.uStars, starsBox); gl.uniform4fv(u.uMoon, moonBox);
        gl.uniform4fv(u.uLine, lineBox); gl.uniform1f(u.uLineA, lineA);
        gl.uniform1i(u.uWinN, scene.windows.length); gl.uniform1i(u.uLanN, scene.lanterns.length);
        gl.uniform4f(u.uBlinkT, 13, .41, .47, .83); gl.uniform2f(u.uBlinkV, .35, .55);
        gl.uniform4fv(u.uGround, groundBox); gl.uniform1f(u.uGroundA, groundA);
        gl.uniform4fv(u.uFog, fogBox); gl.uniform1f(u.uFogA, fogA);
        // hh-fly: each bat crosses the sky over its period, rising and dipping, flapping as it goes.
        const sky = groundBox[1]; const size = Math.min(40, Math.max(26, width * .03)) * .5;
        BATS.forEach((b, i) => {
          const t = clock < b.delay ? 0 : ((clock - b.delay) / b.period) % 1;
          bats[i * 4] = width * (-.12 + 1.24 * t); bats[i * 4 + 1] = sky * b.y + sky * b.wobble * Math.sin(t * Math.PI * 4 + i);
          bats[i * 4 + 2] = size * b.size; bats[i * 4 + 3] = clock * 11 + i * 1.7;
        });
        gl.uniform4fv(u.uBat, bats); gl.uniform1f(u.uLifeA, performance ? 0 : lifeA);
      },
    };
  },
};
