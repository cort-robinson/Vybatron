import type { PresetId } from './presets';

// The visualizers' fragment shaders, each drawn as one full-screen triangle (the vertex shader is
// scene/shared.ts compile's). Every one reads the same uniforms: the drawing buffer size, a visual
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

// Neon, after Jeff Minter's Xbox 360 visualizer: light folded into mirrored wedges, then the whole
// previous frame pulled toward the centre and turned, so everything drawn streams out and spins in a
// tunnel of trails. It runs at half resolution into a ping-pong pair of buffers; a second pass
// stretches the result to the canvas with a little bloom.
const neonFlow = head + `
uniform sampler2D uPrev;
uniform vec4 uFlow;
uniform float uFold;
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
vec3 tone(int i) { return bright(uC[i == 0 ? 0 : i + 1], .5); }
// The cover's accent and glows in turn, pushed toward a turning rainbow.
vec3 paint(float t) { float k = fract(t) * 4.0; int i = int(k); return mix(mix(tone(i), tone((i + 1) % 4), smoothstep(0.0, 1.0, fract(k))), hue(t * .7), .42); }
void main() {
  vec2 p = coord(); float px = 1.0 / uRes.y;
  // The mirrored wedge lies along the frame's longer axis, so a tall phone screen samples inside it.
  float seg = 2.0 * PI / uFold; float r = length(p); float axis = uRes.x < uRes.y ? PI * .5 : 0.0;
  float a = abs(mod(atan(p.y, p.x) - axis + seg * .5, seg) - seg * .5);
  vec2 s = vec2(cos(a + axis + uFlow.y), sin(a + axis + uFlow.y)) * r * (1.0 - uFlow.x);
  vec2 uv = s * vec2(uRes.y / uRes.x, 1.0) + .5;
  vec3 prev = texture(uPrev, uv).rgb * step(abs(uv.x - .5), .5) * step(abs(uv.y - .5), .5);
  // Old light drifts around the color wheel as it fades; the floor stops 8-bit trails sticking.
  prev = mix(prev, prev.gbr, uFlow.w);
  prev = max(prev * uFlow.z - 1.5 / 255.0, 0.0);
  vec2 f = vec2(cos(a), sin(a)) * r; float t = uTime * .05 + uSeed;
  vec3 add = vec3(0);
  float r1 = .07 + .2 * uF.x + .12 * uBeat.x;
  add += paint(t) * span(r, r1 - px * (1.0 + 2.0 * uBeat.x), r1 + px * (1.0 + 2.0 * uBeat.x), px) * (.3 + .9 * uBeat.x);
  // Each wedge spans the bands from its centre line to its edge.
  float r2 = .1 + .32 * band(a / (seg * .5)) * (.55 + .6 * uF.w);
  add += paint(t + .33) * span(r, r2 - px, r2 + px, px) * .5;
  for (int k = 0; k < 3; k++) {
    float fk = float(k); float angle = mod(uTime * (.5 + fk * .3) + fk * 2.1, seg * .5);
    float radius = .14 + .3 * fract(fk * .37 + uTime * .09) + .08 * uF.y;
    vec2 d = f - vec2(cos(angle), sin(angle)) * radius;
    add += paint(t + .66 + fk * .1) * exp(-dot(d, d) / (.0003 + .0016 * uF.z)) * .75;
  }
  add += paint(t + .5) * exp(-r * 18.0) * smoothstep(.7, 1.0, uBeat.x) * .5;
  outColor = vec4(min(prev + add * .6, 1.0), 1.0);
}`;
const neonShow = head + `
uniform sampler2D uFeed;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes; vec2 o = 2.5 / vec2(textureSize(uFeed, 0));
  vec3 c = texture(uFeed, uv).rgb;
  vec3 b = texture(uFeed, uv + o).rgb + texture(uFeed, uv - o).rgb + texture(uFeed, uv + vec2(o.x, -o.y)).rgb + texture(uFeed, uv + vec2(-o.x, o.y)).rgb;
  vec3 col = 1.0 - exp(-(c * 1.7 + b * .2 * (.6 + uF.x)));
  outColor = vec4(col * vignette(coord()), 1.0);
}`;

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

export const shaders: Record<PresetId, string[]> = { neon: [neonFlow, neonShow], gridrunner: [gridrunner], cosmic: [cosmic], receiver: [receiver] };
