import type { PresetId } from './presets';

// The fragment shaders of the visualizers drawn here (MilkDrop draws itself, milkdrop.ts), each one
// full-screen triangle (the vertex shader is scene/shared.ts compile's). Every one reads the same uniforms: the drawing buffer size, a visual
// clock and a travelled distance that advance only while the song plays, the song's bands and held
// peaks (signal.ts), bass/mid/treble/level, the beat pulse and count, the cover's palette, a per-song
// seed, and whether it fills the screen (1) or the sleeve (0). They are written for small buffers:
// the canvas is stretched up, so every edge is antialiased against its own pixel size.
const head = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime, uDrive, uSeed, uFull;
uniform float uB[16], uP[16];
uniform vec4 uF;
uniform vec2 uBeat;
uniform vec3 uC[5];
out vec4 outColor;
const float PI = 3.14159265;
float hash(vec2 p) { vec3 q = fract(p.xyx * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float band(float x) { float f = clamp(x, 0.0, 1.0) * 15.0; int i = int(f); return mix(uB[i], uB[min(i + 1, 15)], f - float(i)); }
float held(float x) { float f = clamp(x, 0.0, 1.0) * 15.0; int i = int(f); return mix(uP[i], uP[min(i + 1, 15)], f - float(i)); }
// A palette color brought to a given luminance, keeping its hue (cover glows are dark room light).
vec3 bright(vec3 c, float l) { return clamp(c * l / max(dot(c, vec3(.2126, .7152, .0722)), .04), 0.0, 1.0); }
// Centred coordinates, y up, one unit the buffer's height.
vec2 coord() { return (gl_FragCoord.xy - .5 * uRes) / uRes.y; }
// 1 inside [lo, hi] (in units of w, a pixel), with antialiased edges.
float span(float x, float lo, float hi, float w) { return smoothstep(lo - w, lo + w, x) - smoothstep(hi - w, hi + w, x); }
float vignette(vec2 p) { return 1.0 - .4 * pow(clamp(length(p * vec2(uRes.y / uRes.x, 1.0)) * 1.2, 0.0, 1.0), 2.5); }
`;

// Gridrunner, for Overdrive: the sliced synthwave sun on the horizon, a skyline whose towers are the
// equalizer (bass at the edges, so the sun stays in view), each with its peak floating above, and the
// neon floor racing toward the viewer, its lines flaring on the bass and a wave rolling in on each beat.
const gridrunner = head + `
const vec3 NEON = vec3(.878, .298, 1.0);
const vec3 SUNSET = vec3(1.0, .541, .298);
void main() {
  vec2 p = coord(); float px = 1.0 / uRes.y; float aspect = uRes.x / uRes.y;
  vec3 accent = uC[0]; vec3 ground = uC[1];
  float hy = mix(-.05, -.1, uFull);
  // Derivatives first: they are undefined inside the branches that split the frame.
  vec2 sc = vec2(0.0, hy + .16); float R = .24 * clamp(aspect * 1.3, .62, 1.0) * (1.0 + .04 * uF.x + .03 * uBeat.x);
  float v = (sc.y + R - p.y) / (2.0 * R); float k = v * 9.0 - uDrive * .25; float kw = fwidth(k);
  float n = floor(clamp(aspect * 30.0, 22.0, 64.0));
  float u = (p.x / aspect + .5) * n; float wu = fwidth(u);
  float dy = max(hy - p.y, 1e-3); vec2 g = vec2(p.x / dy, 1.0 / dy + uDrive) * 3.0; vec2 gw = fwidth(g);
  vec3 col;
  if (p.y >= hy) {
    float t = (p.y - hy) / (.5 - hy);
    col = mix(mix(NEON * .42, SUNSET * .5, .3), mix(ground * .5, vec3(.02, 0.0, .06), .5), pow(t, .5));
    vec2 sg = p * 80.0; vec2 id = floor(sg); float h = hash(id + uSeed * 31.0);
    if (h > .982) {
      vec2 o = fract(sg) - .5 - (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .5;
      col += vec3(.95, .9, 1.0) * (1.0 - smoothstep(.04, .14, length(o))) * t * (.35 + .4 * sin(uTime * (1.5 + 3.0 * h) + h * 40.0) + .4 * uF.z);
    }
    float d = length(p - sc);
    col += mix(SUNSET, NEON, .45) * .5 * exp(-max(d - R, 0.0) * 8.0) * (.55 + .5 * uF.x);
    if (d < R + 2.0 * px) {
      vec3 sun = v < .5 ? mix(mix(vec3(1.0, .9, .54), accent, .28), mix(accent, SUNSET, .88), v / .5) : mix(mix(accent, SUNSET, .88), NEON, (v - .5) / .5);
      // The slices widen toward the bottom and drift down as the song plays.
      float cut = (1.0 - smoothstep(-kw, kw, fract(k) - clamp((v - .45) * 1.25, 0.0, .55))) * step(.45, v);
      col = mix(col, sun * (1.0 + .2 * uBeat.x), (1.0 - smoothstep(R - px, R + px, d)) * (1.0 - cut));
    }
    float i = floor(u); float fu = fract(u);
    float side = abs((i + .5) / n * 2.0 - 1.0); float x = 1.0 - side; float tall = mix(.07, .25, pow(side, 1.3));
    float base = .008 + .03 * hash(vec2(i, 3.0)) * (.4 + side) + .05 * side;
    float H = base + band(x) * tall; float P = base + held(x) * tall + .014;
    float inset = .06 + .2 * hash(vec2(i, 9.0)); float inside = span(fu, inset, 1.0 - inset, wu);
    float y = p.y - hy;
    float body = (1.0 - smoothstep(H - px, H + px, y)) * inside;
    if (body > 0.0) {
      vec3 tower = mix(ground * .3, vec3(.03, 0.0, .07), .5);
      vec2 wg = vec2(fu * 4.0, y / .012); vec2 wid = floor(wg); vec2 wf = fract(wg);
      float lit = step(.66, hash(wid + vec2(i * 7.0, floor(uTime * .2 + hash(vec2(i, 5.0)) * 9.0))));
      tower += mix(accent, vec3(1.0, .85, .5), .4) * lit * span(wf.x, .28, .72, .05) * span(wf.y, .3, .7, .08) * step(y, H - .014) * (.45 + .5 * uF.z);
      col = mix(col, tower, body);
    }
    col += NEON * inside * exp(-abs(y - H) / (1.4 * px)) * (.6 + .7 * band(x)) * step(0.0, H - y + 2.0 * px);
    col += mix(NEON, accent, .5) * inside * exp(-abs(y - P) / (1.1 * px)) * step(H + .006, P) * .85;
  } else {
    vec2 w = gw; vec2 d = abs(fract(g + .5) - .5) / max(w, vec2(1e-4));
    float thick = .6 + 1.1 * uF.x + .9 * uBeat.x;
    vec2 core = 1.0 - smoothstep(vec2(thick), vec2(thick + 1.0), d); vec2 glow = exp(-d * .45) * .3;
    float fade = clamp(1.0 - max(w.x, w.y) * 1.5, 0.0, 1.0);
    vec3 grid = mix(NEON, accent, .3);
    col = mix(mix(vec3(.04, 0.0, .08), ground * .35, .5), mix(NEON, SUNSET, .4) * .3, exp(-dy * 9.0)) + grid * (max(core.x, core.y) + max(glow.x, glow.y)) * fade * (.5 + .6 * uF.x + .7 * uBeat.x);
    // A wave rolls in from the horizon on each beat.
    float wave = (1.0 - uBeat.x) * (.5 + hy);
    col += grid * .35 * exp(-abs(dy - wave) * 40.0) * uBeat.x;
    col += mix(SUNSET, NEON, .3) * .3 * exp(-abs(p.x) * 7.0) * exp(-dy * 5.0);
    col += mix(NEON, SUNSET, .5) * .45 * exp(-dy * 22.0);
  }
  col += NEON * .55 * exp(-abs(p.y - hy) / (2.5 * px));
  col *= 1.0 - .08 * step(mod(gl_FragCoord.y, 3.0), 1.0);
  outColor = vec4(col * vignette(p), 1.0);
}`;

// Cosmic Broadcast, for Fantastic: a ringed planet broadcasting into deep space. Its radiation is
// printed in Ben-Day dots, Kirby krackle (black dots in crackling energy) streams outward, Googie
// starbursts twinkle on the beat, and an oscilloscope trace circles it all, shaped by the bands.
const cosmic = head + `
const vec3 CREAM = vec3(.953, .898, .784);
const vec3 SUIT = vec3(.29, .561, .831);
const vec3 MUSTARD = vec3(.91, .71, .29);
const vec3 FLAME = vec3(1.0, .478, .22);
const vec3 NAVY = vec3(.043, .086, .157);
const vec2 STARS[6] = vec2[6](vec2(.66, .31), vec2(-.58, .36), vec2(.5, -.37), vec2(-.7, -.27), vec2(.22, .43), vec2(-.2, -.43));
float radiation(vec2 q) {
  float r = length(q); float a = atan(q.y, q.x);
  float rays = pow(.5 + .5 * sin(a * 9.0 + uTime * .15 + sin(r * 6.0 - uTime * .4) * .6), 6.0);
  return rays * smoothstep(.15, .5, r) * exp(-r * 1.1) * (.55 + .8 * uF.y) + .4 * exp(-r * 2.6) * (.4 + uF.x) + .2 * uBeat.x * exp(-r * 3.0);
}
float star(vec2 q) {
  vec2 d = abs(q); vec2 e = abs(rot(.785) * q);
  float s = max(1.0 - d.x * 9.0 - d.y * .95, 1.0 - d.y * 9.0 - d.x * .95);
  s = max(s, max(1.0 - e.x * 10.0 - e.y * 2.1, 1.0 - e.y * 10.0 - e.x * 2.1));
  return max(s, 1.0 - length(q) * 6.0);
}
void main() {
  vec2 p = coord(); float px = 1.0 / uRes.y; float aspect = uRes.x / uRes.y;
  // A tall screen shrinks the system to fit its width.
  float fit = min(1.0, aspect / .8) * mix(.9, 1.0, uFull);
  vec2 q = (p - vec2(0.0, mix(.0, -.02, uFull))) / fit;
  float r = length(q); float a = atan(q.y, q.x); float qx = px / fit;
  vec3 accent = uC[0];
  vec3 col = mix(NAVY, uC[1], .25) * .85;
  float cells = mix(64.0, 84.0, uFull);
  vec2 h = rot(.26) * p * cells; vec2 hc = floor(h) + .5;
  float field = radiation((rot(-.26) * hc / cells - vec2(0.0, mix(.0, -.02, uFull))) / fit);
  float dot1 = 1.0 - smoothstep(-.06, .06, length(h - hc) - sqrt(clamp(field, 0.0, 1.0)) * .6);
  col = mix(col, mix(SUIT, mix(CREAM, accent, .3), clamp(field * .6, 0.0, 1.0)), dot1 * .85);
  // Starbursts on a fixed chart, mirrored per song: hashing their places for every pixel cost a
  // third of the frame.
  vec2 flip = vec2(uSeed > .5 ? -1.0 : 1.0, fract(uSeed * 7.0) > .5 ? -1.0 : 1.0) * vec2(min(aspect, 1.6) / 1.6, 1.0);
  for (int k = 0; k < 6; k++) {
    float fk = float(k); vec2 at = STARS[k] * flip;
    float size = .05 + .02 * mod(fk * 1.7, 2.0) + .035 * uBeat.x * mod(fk, 2.0);
    if (length(p - at) > size * 1.15) continue;
    float tw = .55 + .45 * sin(uTime * (1.0 + fk * .3) + fk * 2.1);
    col = mix(col, k % 2 == 0 ? CREAM : MUSTARD, clamp(star((p - at) / size) * 3.0, 0.0, 1.0) * tw);
  }
  // Krackle: log-polar cells, square on screen, so clumps grow as they stream out. Each is a ragged
  // cloud of energy around a cluster of black dots. The pixel width is worked out rather than taken
  // from fwidth, which breaks where the angle wraps.
  if (r > .36) {
    vec2 kp = vec2(log(r) * 5.0 - uDrive * .3, a / (2.0 * PI) * 32.0);
    vec2 id = floor(kp); vec2 kf = fract(kp) - .5; float w = qx / r * 5.0;
    float on = step(.66 - .2 * uF.z, hash(id + 3.7)) * smoothstep(.36, .5, r);
    vec2 o = (vec2(hash(id + 1.1), hash(id + 2.2)) - .5) * .24; vec2 e = kf - o;
    float ragged = (.2 + .07 * hash(id + 5.5) + .08 * uBeat.x) * (1.0 + .12 * sin(atan(e.y, e.x) * 3.0 + hash(id + 6.6) * 6.3 + uTime * 2.0) + .08 * sin(atan(e.y, e.x) * 7.0 + hash(id + 4.4) * 6.3 - uTime * 3.0));
    float cloud = 1.0 - smoothstep(-w, w, length(e) - ragged);
    float black = 0.0;
    for (int k = 0; k < 4; k++) {
      float fk = float(k); vec2 dk = o + (vec2(hash(id + fk * 4.1), hash(id + fk * 7.3)) - .5) * .22;
      black = max(black, 1.0 - smoothstep(-w, w, length(kf - dk) - (.075 - fk * .012) * (.8 + .5 * uF.z)));
    }
    col = mix(col, mix(FLAME, MUSTARD, hash(id + 8.8)), cloud * on);
    col = mix(col, vec3(.02, .02, .04), black * on);
  }
  // The oscilloscope: harmonics weighted by the bands, whole multiples of the angle so it closes.
  float wave = 0.0;
  for (int k = 1; k <= 6; k++) { float fk = float(k); wave += band((fk - 1.0) / 5.0) / fk * sin(a * fk * 3.0 + uTime * (1.0 + fk * .6) * (k % 2 == 0 ? 1.0 : -1.0)); }
  float d = abs(r - (.34 + wave * .05 * (.45 + uF.w) + .012 * uBeat.x));
  col += mix(SUIT, accent, .35) * exp(-d / .014) * (.35 + .6 * uF.w);
  col = mix(col, CREAM, 1.0 - smoothstep(qx * .7, qx * 1.8, d));
  float tick = step(.5, fract(a / (2.0 * PI) * 48.0 + .25)) * span(r, .405, .415, qx);
  col = mix(col, CREAM, tick * .35);
  float Rp = .15 * (1.0 + .02 * uF.x);
  vec2 rq = rot(-.38) * q; float ell = length(vec2(rq.x, rq.y * 3.4)) / Rp;
  float ring = span(ell, 1.38, 1.96, fwidth(ell));
  vec3 ringC = mix(CREAM, MUSTARD, step(.5, fract(ell * 4.5))) * (.75 + .25 * uF.y);
  if (rq.y > 0.0) col = mix(col, ringC * .8, ring);
  if (r < Rp + 2.0 * qx) {
    vec2 s = q / Rp; vec3 n = vec3(s, sqrt(max(0.0, 1.0 - dot(s, s))));
    float lam = max(dot(n, normalize(vec3(-.5, .55, .65))), 0.0);
    float stripe = sin((rot(-.38) * s).y * 9.0 + sin(s.x * 3.0 + uTime * .2) * .6);
    vec3 planet = mix(mix(FLAME, MUSTARD, .5 + .5 * stripe), accent, .15) * (.3 + .8 * lam) + SUIT * .35 * pow(1.0 - n.z, 3.0);
    // The night side is printed as halftone too.
    vec2 g = rot(.26) * p * cells * 1.4; float shade = 1.0 - smoothstep(-.08, .08, length(fract(g) - .5) - (1.0 - lam) * .5);
    planet = mix(planet, planet * .25, shade * (1.0 - lam));
    col = mix(col, planet, 1.0 - smoothstep(Rp - qx, Rp + qx, r));
  }
  if (rq.y <= 0.0) col = mix(col, ringC, ring);
  col *= .96 + .04 * hash(floor(gl_FragCoord.xy));
  outColor = vec4(col * vignette(p), 1.0);
}`;

// Receiver, for Classic: the receiver's VFD spectrum (components/Spectrum.tsx) as a wall. Segments lit
// to each column's level, a held peak segment, unlit segments ghosted, the phosphor's glow, and the
// display mirrored in the glass beneath it.
const receiver = head + `
float level(float c, float n) { return clamp(band(c / (n - 1.0)) * (.9 + .18 * hash(vec2(c, 7.0))), 0.0, 1.0); }
void main() {
  vec2 px = gl_FragCoord.xy;
  float base = uRes.y * mix(.28, .3, uFull); float top = uRes.y * mix(.92, .8, uFull); float height = top - base;
  float cols = clamp(floor(uRes.x / uRes.y * 22.0), 18.0, 60.0);
  float margin = uRes.x * .05; float colW = (uRes.x - 2.0 * margin) / cols;
  float rows = clamp(floor(height / max(colW * .42, 3.0)), 12.0, 40.0); float segH = height / rows;
  bool mirror = px.y < base;
  float depth = mirror ? (base - px.y) / base : 0.0;
  float y = mirror ? (base - px.y) * 1.3 : px.y - base;
  float x = px.x - margin + (mirror ? sin(px.y * .4 + uTime * 3.0) * colW * .05 * depth : 0.0);
  float c = floor(x / colW);
  vec2 f = vec2(fract(x / colW), fract(y / segH)); vec2 w = vec2(fwidth(x / colW), fwidth(y / segH));
  vec3 tube = bright(uC[0], .6); vec3 hot = mix(tube, vec3(1), .45);
  vec3 bg = mix(uC[1], vec3(0), .6) * (.7 + .3 * px.y / uRes.y);
  vec3 lit = vec3(0);
  if (c >= 0.0 && c < cols) {
    float L = level(c, cols); float P = clamp(held(c / (cols - 1.0)) * (.9 + .18 * hash(vec2(c, 7.0))), 0.0, 1.0);
    float r = floor(y / segH); float on = max(1.0, floor(L * rows + .5)); float cap = min(rows - 1.0, floor(P * rows + .5));
    float seg = span(f.x, .12, .88, w.x) * span(f.y, .16, .84, w.y) * step(r, rows - 1.0);
    float state = r < on ? 1.0 + .25 * uBeat.x : r == cap && cap >= on ? .8 : .07;
    lit += mix(tube, hot, smoothstep(.55, 1.0, r / rows)) * seg * state;
  }
  // Phosphor glow from this column's lit stack and its neighbours'.
  float g = 0.0;
  for (int k = -1; k <= 1; k++) {
    float ck = c + float(k);
    if (ck < 0.0 || ck >= cols) continue;
    float dx = (x - (ck + .5) * colW) / colW; float dy = max(0.0, y - level(ck, cols) * height) / segH;
    g += exp(-dx * dx * 3.0 - dy * .5);
  }
  lit += tube * g * .16 * (.8 + .4 * uF.w) * step(0.0, y) * step(y, height + segH * 3.0);
  vec3 col = bg + (mirror ? lit * .3 * pow(1.0 - depth, 2.4) : lit);
  col += tube * .22 * exp(-abs(px.y - base) / (uRes.y * .004));
  col *= 1.0 - .07 * step(mod(px.y, 3.0), 1.0);
  outColor = vec4(col * vignette(coord()), 1.0);
}`;

// The night both Haunted visualizers share: its colors, value noise for fog, cloud and the moon's
// seas, the full moon itself, a bat on the wing and a bare tree, each antialiased to its pixel.
const night = head + `
const vec3 NIGHT = vec3(.043, .031, .071);
const vec3 VIOLET = vec3(.165, .09, .26);
const vec3 PLUM = vec3(.29, .149, .376);
const vec3 MOON = vec3(.97, .94, .86);
const vec3 SEA = vec3(.6, .56, .66);
const vec3 PUMPKIN = vec3(1.0, .478, .102);
const vec3 CANDLE = vec3(1.0, .835, .54);
const vec3 WITCH = vec3(.65, .91, .43);
const vec3 IRON = vec3(.018, .012, .03);
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { return (noise(p) * .5 + noise(p * 2.03 + 17.1) * .25 + noise(p * 4.1 + 31.7) * .125) / .875; }
// The sky from the hills up: plum and a last ember low down, violet, then night, tinted by the cover.
vec3 sky(vec2 p, float gy) {
  float t = clamp((p.y - gy) / (.5 - gy), 0.0, 1.0);
  vec3 c = mix(mix(PLUM, PUMPKIN, .16), VIOLET, smoothstep(0.0, .35, t));
  return mix(mix(c, NIGHT, smoothstep(.3, 1.0, t)), uC[1] * .35, .2);
}
void stars(inout vec3 col, vec2 p, float gy, float px) {
  vec2 g = p * 70.0; vec2 id = floor(g); float h = hash(id + uSeed * 17.0);
  if (h < .975 || p.y < gy + .08) return;
  vec2 o = fract(g) - .5 - (vec2(hash(id + 1.3), hash(id + 2.7)) - .5) * .5;
  col += MOON * (1.0 - smoothstep(.03, .03 + px * 70.0 * 1.5, length(o))) * (.35 + .35 * sin(uTime * (1.0 + 2.0 * h) + h * 50.0) + .3 * uF.z);
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
// The full moon of radius R at c: a soft halo that swells with glow, limb-darkened bone and grey seas.
void moon(inout vec3 col, vec2 p, vec2 c, float R, float px, float glow) {
  vec2 m = (p - c) / R; float r = length(m); vec3 tint = mix(MOON, bright(uC[0], .7), .28);
  col += tint * (.2 * exp(-max(r - 1.0, 0.0) * 5.0) + .09 * exp(-max(r - 1.0, 0.0) * 1.1)) * glow;
  float a = clamp((1.0 - r) * R / px + .5, 0.0, 1.0);
  if (a <= 0.0) return;
  float limb = sqrt(max(0.0, 1.0 - r * r));
  vec3 c2 = mix(MOON, SEA, maria(m, fbm(m * 2.6 + 4.2)) * .62 + (noise(m * 22.0) - .5) * .08);
  c2 = mix(c2 * (.72 + .28 * limb), tint, .1);
  col = mix(col, c2 * (.94 + .1 * glow), a);
}
// A bank of dark cloud drifting across the moon's lower half.
void clouds(inout vec3 col, vec2 p, vec2 c, float R) {
  vec2 m = (p - c) / R;
  if (abs(m.y + .3) > 1.4 || abs(m.x) > 2.8) return;
  float bank = exp(-pow((m.y + .32 + .16 * sin(m.x * 1.4 + uSeed * 6.0)) / .38, 2.0));
  float k = smoothstep(.42, .74, fbm(vec2(m.x * .85 - uTime * .025, m.y * 1.7 + 9.0))) * bank * (1.0 - smoothstep(1.6, 2.8, abs(m.x)));
  col = mix(col, mix(NIGHT, PLUM, .5), k * .78);
}
// A bat about its centre, a unit of half its wingspan; flap -1 (down) to 1 (up). Coverage over a pixel w.
float bat(vec2 q, float flap, float w) {
  float x = abs(q.x);
  float top = .06 + x * (.05 + .3 * flap);
  float bottom = top - (.3 * (1.0 - x) + .05) + .1 * abs(sin(x * 9.42)) * (1.0 - .4 * x);
  float wing = max(max(bottom - q.y, q.y - top), x - 1.0);
  float body = (length(q / vec2(.11, .2)) - 1.0) * .11;
  float head = length(q - vec2(0.0, .17)) - .085;
  float ears = max(abs(x - .05) - .03, abs(q.y - .27) - .05);
  return clamp(.5 - min(min(wing, body), min(head, ears)) / w, 0.0, 1.0);
}
// A bare, gnarled tree a unit tall, its foot at the origin: tapering limbs forking into twigs.
const vec4 LIMB[16] = vec4[16](vec4(0, -.04, .03, .3), vec4(.03, .3, -.01, .52), vec4(-.01, .52, -.05, .78), vec4(-.05, .78, -.15, .98), vec4(-.05, .78, .06, 1.02),
  vec4(.03, .3, .2, .46), vec4(.2, .46, .42, .5), vec4(.42, .5, .55, .6), vec4(.2, .46, .27, .66), vec4(-.01, .52, -.24, .66), vec4(-.24, .66, -.44, .64),
  vec4(-.44, .64, -.56, .72), vec4(-.24, .66, -.3, .86), vec4(.01, .12, -.14, .2), vec4(.06, 1.02, .14, 1.1), vec4(-.15, .98, -.23, 1.01));
const float GIRTH[16] = float[16](.046, .034, .024, .011, .01, .022, .012, .006, .01, .02, .01, .005, .009, .013, .005, .004);
float tree(vec2 q, float w) {
  if (q.x < -.65 || q.x > .65 || q.y < -.1 || q.y > 1.15) return 0.0;
  q.x -= sin(uTime * .6) * .012 * q.y * q.y;
  float d = 1e3;
  for (int i = 0; i < 16; i++) {
    vec2 a = LIMB[i].xy; vec2 ba = LIMB[i].zw - a; vec2 pa = q - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    d = min(d, length(pa - ba * h) - GIRTH[i] * (1.0 - .35 * h));
  }
  return clamp(.5 - d / w, 0.0, 1.0);
}
// Ground fog: a drifting bank, thickest at y = at and thinning over its depth.
float fog(vec2 p, float at, float depth) {
  float v = 1.0 - smoothstep(0.0, depth, abs(p.y - at));
  if (v <= 0.0) return 0.0;
  float bank = fbm(vec2(p.x * 2.6 + uDrive * .05, p.y * 8.0 - uTime * .05));
  return v * smoothstep(.3, .8, bank * (.85 + .3 * uF.x));
}
`;

// Pumpkin Patch, for Haunted: jack-o'-lanterns in a row on a foggy hill under the moon, the
// equalizer as a choir. Each one sings a part of the spectrum (the lead in the middle takes the
// bass): its jagged grin opens with its band, its eyes burn with the band's held peak, and every
// candle flickers on its own and flares with the bass and each beat, spilling light on the ground.
const pumpkins = night + `
const vec3 RIND = vec3(.8, .33, .07);
const vec3 FLESH = vec3(1.0, .74, .32);
const vec3 STEM = vec3(.26, .27, .12);
// An upward triangle, base half-width b at y = 0 and apex at height h (negative inside).
float tri(vec2 q, float b, float h) { return max(-q.y, (abs(q.x) * h + q.y * b - h * b) / length(vec2(h, b))); }
float eye(vec2 q, float style) {
  if (style < .34) return tri(q + vec2(0.0, .1), .15, .24);
  if (style < .67) return tri(rot(.38 * sign(q.x + 1e-3) * -1.0) * (q + vec2(0.0, .08)), .16, .21);
  return max(length(q - vec2(0.0, -.02)) - .12, -(length(q - vec2(0.0, -.1)) - .1));
}
// The grin, opening with its band: a smiling slot with square teeth cut from its top and bottom.
float grin(vec2 q, float open, float style) {
  float mw = .52; float t = clamp(q.x / mw, -1.0, 1.0);
  float top = -.2 + .13 * t * t; float tall = (.07 + .22 * open) * pow(max(0.0, 1.0 - t * t), .6);
  float bottom = top - tall - .03;
  float d = max(max(q.y - top, bottom - q.y), abs(q.x) - mw);
  float x1 = style < .5 ? .2 : .14;
  d = max(d, -max(abs(abs(q.x) - x1) - .05, top - .075 - q.y));
  if (style >= .5) d = max(d, -max(abs(q.x) - .045, top - .065 - q.y));
  d = max(d, -max(abs(abs(q.x) - (style < .5 ? 0.0 : .3)) - .05, q.y - bottom - .06 - .04 * open));
  return d;
}
// One lantern of radius R centred at c: its lobed rind, stem and carved face lit from within.
void lantern(inout vec3 col, vec2 p, vec2 c, float R, float open, float eyes, float candle, float style, float px) {
  vec2 q = (p - c) / R; float w = px / R;
  float face = min(min(eye(q - vec2(-.31, .16), style), eye(q - vec2(.31, .16), style)), tri(q - vec2(0.0, -.06), .06, .1));
  float mouth = grin(q, open, fract(style * 7.3));
  float carved = min(face, mouth);
  // Light through the carving blooms into the night around it.
  col += PUMPKIN * candle * .2 * exp(-max(carved, 0.0) * 3.0);
  if (abs(q.x) > 1.12 || q.y > 1.05 || q.y < -.95) return;
  vec3 body = col; float covered = 0.0;
  for (int k = 0; k < 5; k++) {
    float ox = k == 0 ? -.52 : k == 1 ? .52 : k == 2 ? -.28 : k == 3 ? .28 : 0.0;
    vec2 r = k < 2 ? vec2(.48, .74) : k < 4 ? vec2(.55, .8) : vec2(.58, .83);
    vec2 s = (q - vec2(ox, 0.0)) / r; float e = length(s) - 1.0;
    float a = clamp(.5 - e * min(r.x, r.y) / w, 0.0, 1.0);
    if (a <= 0.0) continue;
    vec3 n = vec3(s, sqrt(max(0.0, 1.0 - dot(s, s))));
    float moonlit = max(dot(n, normalize(vec3(.5, .62, .6))), 0.0);
    vec3 rind = RIND * (.07 + .42 * moonlit) * mix(.45, 1.0, smoothstep(-.95, -.1, q.y)) + MOON * .12 * pow(1.0 - n.z, 3.0) * step(0.0, n.y + n.x * .5);
    // Creases where the lobes meet, and the candle glowing through the rind around the face.
    rind *= mix(.25, 1.0, smoothstep(0.0, .2, -e));
    rind += PUMPKIN * candle * .32 * exp(-max(carved, 0.0) * 5.0);
    body = mix(body, rind, a); covered = max(covered, a);
  }
  // The stem, bent toward the moon.
  vec2 sa = vec2(-.02, .7); vec2 sb = vec2(.12, 1.0); vec2 pa = q - sa; vec2 ba = sb - sa; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float stem = clamp(.5 - (length(pa - ba * h) - mix(.085, .05, h)) / w, 0.0, 1.0);
  body = mix(body, STEM * (.5 + .7 * smoothstep(-.05, .1, q.x - sa.x - ba.x * h)), stem);
  covered = max(covered, stem);
  // The carving: hot candlelight at its heart, the cut flesh bright along its edges.
  float hole = clamp(.5 - carved / w, 0.0, 1.0) * covered;
  if (hole > 0.0) {
    float heat = face < mouth ? eyes : candle;
    vec3 inner = mix(vec3(1.0, .97, .86), CANDLE, smoothstep(-.16, -.07, carved));
    inner = mix(inner, mix(PUMPKIN, FLESH, .35), smoothstep(-.07, 0.0, carved));
    body = mix(body, inner * (.45 + .7 * heat), hole);
  }
  col = body;
}
void main() {
  vec2 p = coord(); float px = 1.0 / uRes.y; float aspect = uRes.x / uRes.y;
  float gy = mix(-.26, -.22, uFull);
  vec3 col = sky(p, gy);
  stars(col, p, gy, px);
  float fit = min(1.0, aspect);
  vec2 mc = vec2(min(aspect * .5 - .2, .62), mix(.27, .3, uFull)); float mR = mix(.085, .1, uFull) * fit;
  moon(col, p, mc, mR, px, .8 + .5 * uF.w);
  clouds(col, p, mc, mR);
  // Two bats cross the moon now and then.
  for (int k = 0; k < 2; k++) {
    float fk = float(k); float t = fract(uTime * (.05 + .02 * fk) + fk * .5);
    vec2 at = vec2(mix(-aspect * .6, aspect * .6, t), mc.y + .06 * sin(t * 12.0 + fk) - .1 * fk); float size = (.028 - .008 * fk) * fit;
    if (abs(p.x - at.x) < size * 1.3 && abs(p.y - at.y) < size) col = mix(col, IRON, bat((p - at) / size, sin(uTime * 13.0 + fk * 2.0), px / size));
  }
  // Rolling hills behind the patch, and a bare tree leaning in from the left.
  float far = gy + .1 + .035 * sin(p.x * 2.3 + uSeed * 6.0) + .02 * sin(p.x * 6.1 + 1.0);
  col = mix(col, mix(PLUM * .5, NIGHT, .4), clamp((far - p.y) / px + .5, 0.0, 1.0));
  float near = gy + .03 + .02 * sin(p.x * 3.7 + 2.0);
  // The patch: dark grass, catching a little moonlight toward the hills.
  vec3 earth = mix(IRON * 1.6, mix(PLUM, NIGHT, .55) * .55, smoothstep(near - .3, near, p.y));
  col = mix(col, earth, clamp((near - p.y) / px + .5, 0.0, 1.0));
  float th = mix(.62, .7, uFull) * fit; vec2 tb = vec2(-aspect * .5 + .12 * fit, near - .01);
  col = mix(col, IRON, tree((p - tb) / th * vec2(-1.0, 1.0), px / th));
  // The patch: three lanterns, or five on a wide screen, the outer ones further back.
  bool wide = aspect > 1.25;
  float n = wide ? 5.0 : 3.0; float mid = (n - 1.0) * .5;
  float spread = wide ? min(aspect * .5 - .2, .75) / mid : .3 * fit;
  float pool = 0.0;
  for (int j = 0; j < 5; j++) {
    float fj = float(j); if (fj >= n) break;
    // Draw from the outside in, so the nearer lanterns overlap the farther ones.
    float order = fj < 1.0 ? 0.0 : fj < 2.0 ? n - 1.0 : fj < 3.0 ? 1.0 : fj < 4.0 ? n - 2.0 : mid;
    if (!wide) order = fj < 1.0 ? 0.0 : fj < 2.0 ? 2.0 : 1.0;
    float rank = abs(order - mid) / max(mid, 1.0);
    float R = mix(.2, .13, rank) * fit * mix(1.0, 1.05, uFull);
    vec2 c = vec2((order - mid) * spread, gy + R * .68 + rank * .045);
    float bx = wide ? (order == 0.0 ? .62 : order == 1.0 ? .32 : order == 2.0 ? .05 : order == 3.0 ? .48 : .86) : (order == 0.0 ? .45 : order == 1.0 ? .06 : .75);
    float flick = .8 + .13 * sin(uTime * 9.3 + fj * 2.1) + .07 * sin(uTime * 23.1 + fj * 5.3);
    float candle = clamp(flick * (.5 + .45 * uF.x + .45 * uBeat.x), 0.0, 1.5);
    float eyes = clamp(candle * (.5 + .75 * held(bx + .08)), 0.0, 1.6);
    float open = smoothstep(.08, .85, band(bx));
    float lit = candle * exp(-pow(length((p - vec2(c.x, gy + .004)) / vec2(R * 1.3, R * .22)), 2.0));
    pool += lit; col += PUMPKIN * .3 * lit;
    lantern(col, p, c, R, open, eyes, candle, hash(vec2(fj + floor(uSeed * 5.0), 4.0)), px);
  }
  // Fog laps at the lanterns' feet, warmed where they light it, and will-o'-wisps drift through it.
  float mist = fog(p, gy - .01, mix(.09, .12, uFull));
  col = mix(col, mix(mix(MOON, PLUM, .6) * .8, PUMPKIN, clamp(pool * .6, 0.0, .6)), mist * (.26 + .16 * uF.x));
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    vec2 at = vec2((fract(hash(vec2(fk, 1.0)) + uTime * (.012 + .006 * fk)) - .5) * aspect * 1.1, gy + .04 + .14 * hash(vec2(fk, 2.0)) + .03 * sin(uTime * .8 + fk * 2.0));
    col += WITCH * exp(-length(p - at) / (.006 + .002 * uF.z)) * (.25 + .35 * uF.z) * (.5 + .5 * sin(uTime * 2.0 + fk * 3.0));
  }
  col *= .97 + .03 * hash(floor(gl_FragCoord.xy));
  outColor = vec4(col * vignette(p), 1.0);
}`;

// Witching Hour, for Haunted: a churchyard under a great full moon behind an iron gate. Its graves
// stand in spectrum order, and from each a ghost rises as high as its band has lately reached,
// burning brighter as the band plays; bats wheel round the moon, faster with the mids; fog rolls
// in with the bass; and strong beats split the sky with lightning.
const witching = night + `
// A gravestone, foot at the origin: a rounded headstone, a cross or an obelisk.
float stone(vec2 q, float w, float h, float kind) {
  if (kind < .5) { vec2 r = vec2(w, h - w); return min(max(abs(q.x) - w, max(-q.y, q.y - r.y)), length(q - vec2(0.0, r.y)) - w); }
  if (kind < .8) return min(max(abs(q.x) - w * .32, max(-q.y, q.y - h)), max(abs(q.x) - w * 1.05, abs(q.y - h * .7) - w * .3));
  return max(max(abs(q.x) - w * .7 * (1.0 - q.y / (h * 1.35)), -q.y), q.y - h);
}
void main() {
  vec2 p = coord(); float px = 1.0 / uRes.y; float aspect = uRes.x / uRes.y;
  float fit = min(1.0, aspect / .9);
  float gy = mix(-.14, -.2, uFull);
  // Lightning: some beats, more of them as the bass grows, strike somewhere new.
  float beat = floor(uBeat.y); float strike = step(hash(vec2(beat, 3.1)), .22 + .3 * uF.x);
  float flash = uBeat.x * uBeat.x * strike;
  vec3 col = sky(p, gy) + vec3(.42, .38, .62) * flash * .35 * smoothstep(gy, .5, p.y);
  stars(col, p, gy, px);
  vec2 mc = vec2(0.0, mix(.13, .1, uFull)); float mR = mix(.25, .27, uFull) * fit;
  moon(col, p, mc, mR, px, .7 + .7 * uF.w + .4 * flash);
  clouds(col, p, mc, mR);
  // The bolt: a jagged line from the top of the sky to the hills, with one fork.
  if (flash > .01) {
    float x0 = (hash(vec2(beat, 1.7)) - .5) * aspect * .8; float dir = hash(vec2(beat, 5.9)) > .5 ? 1.0 : -1.0;
    float s = (.5 - p.y) / .055; float k = floor(s); float fk = fract(s);
    float xa = x0 + (hash(vec2(beat, k)) - .5) * .07 + dir * k * .012; float xb = x0 + (hash(vec2(beat, k + 1.0)) - .5) * .07 + dir * (k + 1.0) * .012;
    float d = abs(p.x - mix(xa, xb, fk));
    float fork = s > 3.0 ? abs(p.x - (x0 + (hash(vec2(beat, 3.0)) - .5) * .07 + dir * .036 - dir * (s - 3.0) * .05 + (hash(vec2(beat, k + 40.0)) - .5) * .03)) + (s - 3.0) * .002 : 1.0;
    float reach = step(gy + .03, p.y) * step(p.y, .52); float forkReach = step(s, 7.0);
    float bolt = (exp(-d / (1.3 * px)) + .35 * exp(-d / .025)) * reach + (exp(-fork / (1.0 * px)) * .7 + .2 * exp(-fork / .02)) * reach * forkReach;
    col += vec3(.86, .84, 1.0) * bolt * flash;
  }
  // Bats wheel round the moon, nearer ones larger, flapping faster with the mids.
  for (int k = 0; k < 6; k++) {
    float fk = float(k); float a = uTime * (.22 + .05 * fk) + fk * 1.05;
    float depth = .5 + .5 * sin(a); vec2 at = mc + vec2(cos(a) * mR * (1.35 + .25 * sin(fk * 2.1)), sin(a) * mR * .38 + mR * (.25 * sin(fk * 1.7)));
    float size = (.014 + .012 * depth) * fit * mix(1.0, 1.15, uFull);
    if (abs(p.x - at.x) < size * 1.3 && abs(p.y - at.y) < size) col = mix(col, IRON, bat((p - at) / size, sin(uTime * (10.0 + 8.0 * uF.y) + fk * 1.9), px / size));
  }
  // The hill, a bare tree on its shoulder, and the graves along it with their ghosts.
  float hill = gy + .02 * sin(p.x * 3.1 + 1.0) + .012 * sin(p.x * 7.3 + uSeed * 6.0);
  float th = mix(.55, .62, uFull) * fit; vec2 tb = vec2(min(aspect * .5 - .16 * fit, mR * 1.5), gy);
  col = mix(col, IRON, tree((p - tb) / th, px / th));
  float cols = clamp(floor(aspect * 6.0), 5.0, 11.0); float span = min(aspect, 2.0) * .84;
  float cell = span / cols; float i = floor((p.x + span * .5) / cell);
  float stones = 0.0;
  for (int o = -1; o <= 1; o++) {
    float g = i + float(o);
    if (g < 0.0 || g >= cols) continue;
    float x = -span * .5 + (g + .5) * cell + (hash(vec2(g, 8.0)) - .5) * cell * .25;
    float foot = gy + .02 * sin(x * 3.1 + 1.0) + .012 * sin(x * 7.3 + uSeed * 6.0) - .006;
    float sw = cell * (.2 + .08 * hash(vec2(g, 2.0))); float sh = cell * (.6 + .35 * hash(vec2(g, 3.0))) * min(1.0, .09 / cell + .4);
    float bx = (g + .5) / cols; float lift = held(bx) * mix(.34, .4, uFull) + .02; float glow = .35 + .75 * band(bx);
    // The ghost: a head at the band's held peak, its wavering tail trailing down into the grave.
    vec2 head = vec2(x + .012 * sin(uTime * 1.3 + g * 2.0), foot + sh * .6 + lift);
    float r = cell * (.17 + .06 * band(bx));
    float y = (head.y - p.y) / max(head.y - foot - sh * .5, 1e-3);
    float waver = sin(p.y * 46.0 - uTime * 4.0 + g * 3.0) * .25 * r * clamp(y, 0.0, 1.0);
    float body = abs(p.x - head.x - waver) - r * mix(1.0, .25, clamp(y, 0.0, 1.0));
    float shape = y < 0.0 ? length(p - head) - r : body;
    float alpha = clamp(.5 - shape / px, 0.0, 1.0) * (y < 0.0 ? 1.0 : pow(clamp(1.0 - y, 0.0, 1.0), 1.4));
    vec3 tint = mix(mix(MOON, WITCH, .42), bright(uC[0], .8), .12);
    col = mix(col, tint * (.55 + .45 * min(glow, 1.0)), alpha * .5) + tint * .13 * exp(-max(length(p - head) - r, 0.0) / (r * 1.4)) * glow;
    // Hollow eyes once it has risen.
    float eyes = min(length((p - head - vec2(-r * .36, r * .05)) / vec2(.6, 1.0)), length((p - head - vec2(r * .36, r * .05)) / vec2(.6, 1.0))) - r * .16;
    col = mix(col, NIGHT, clamp(.5 - eyes / px, 0.0, 1.0) * .6 * smoothstep(.08, .2, lift));
    stones = max(stones, clamp(.5 - stone((p - vec2(x, foot)) * vec2(1.0, 1.0), sw, sh, hash(vec2(g, 5.0))) / px, 0.0, 1.0));
  }
  // The ground before the graves, then the stones, rimmed by the moon (and the lightning).
  col = mix(col, mix(IRON * 2.2, PLUM * .25, .3), clamp((hill - p.y) / px + .5, 0.0, 1.0));
  col = mix(col, IRON * (1.6 + 6.0 * flash), stones);
  // Fog rolls in with the bass, lit by the moon and the ghosts above it.
  float mist = fog(p, gy - .01, mix(.12, .15, uFull));
  col = mix(col, mix(MOON, PLUM, .5) * (1.0 + flash), mist * (.28 + .3 * uF.x));
  // The iron gate across the foreground: spear-topped bars and two rails.
  float fy = gy - mix(.11, .13, uFull);
  float bars = abs(fract(p.x / .045) - .5) * .045;
  float tip = fy + .025 - (bars / .0075) * .025;
  float gate = min(max(bars - .0035, p.y - fy), max(bars - .0075, max(p.y - tip, fy - .002 - p.y)));
  gate = min(gate, max(abs(p.y - fy + .025) - .004, -1.0)); gate = min(gate, abs(p.y - fy + .11) - .004);
  col = mix(col, IRON * (.6 + 2.0 * flash), clamp(.5 - gate / px, 0.0, 1.0) * step(p.y, fy + .03));
  col *= .97 + .03 * hash(floor(gl_FragCoord.xy));
  outColor = vec4(col * vignette(p), 1.0);
}`;

export type ShaderId = Exclude<PresetId, 'milkdrop'>;
export const shaders: Record<ShaderId, string> = { gridrunner, cosmic, receiver, pumpkins, witching };
