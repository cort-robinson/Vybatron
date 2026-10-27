// Shared pieces of the WebGL room (scene/index.ts): the GLSL every look builds on, color helpers,
// and what a look measures its DOM probes with and draws each frame from.

export const MAX_ROWS = 256;
export type Program = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };
// Measuring reads styles and boxes, so it runs only when the scene may have changed (scene/index.ts).
export type Probe = {
  top: HTMLElement; scene: HTMLElement; auth: boolean; performance: boolean;
  width: number; height: number; opacity: (element: Element | null) => number;
};
// Each drawn frame: no DOM reads here, only the last measurement and the clock.
export type Frame = {
  gl: WebGL2RenderingContext; u: Program['u'];
  scene: HTMLElement; clock: number; moving: boolean; auth: boolean; performance: boolean;
  width: number; height: number;
};
export type LookScene = {
  // GLSL defining `void scenery(inout vec3 col, vec2 p)`; it may use the shared uniforms below.
  glsl: string;
  // The room's base, its three lights, then the look's own colors (uC[4] on), as rgba.
  colors: (accent: string, ground: string, glow: string[]) => [string, number][];
  vignette: number;
  matches: (top: HTMLElement) => boolean;
  create: (gl: WebGL2RenderingContext) => { measure: (probe: Probe) => void; feed: (frame: Frame) => void };
};

export const head = (colors: number) => `#version 300 es
precision highp float;
precision highp sampler2D;
uniform float uDevH, uScale, uScan, uClock, uVig;
uniform vec2 uSize;
uniform vec4 uC[${colors}];
uniform vec4 uLight[3];
uniform vec3 uLightA;
uniform vec4 uArt[2], uArtP[2];
uniform sampler2D uArtT0, uArtT1;
uniform highp sampler2D uData;
uniform vec4 uBlinkT;
uniform vec2 uBlinkV;
out vec4 outColor;

void over(inout vec4 d, vec3 c, float a) { d = vec4(c * a, a) + d * (1.0 - a); }
void place(inout vec4 d, vec4 s, float a) { d = s * a + d * (1.0 - s.a * a); }
// Share of a pixel footprint (centred at x, width w) covered by the interval [lo, hi].
float cover(float x, float lo, float hi, float w) { w = max(w, 1e-4); return clamp((min(hi, x + w * .5) - max(lo, x - w * .5)) / w, 0.0, 1.0); }
float line(float d, float halfWidth, float w) { return cover(d, -halfWidth, halfWidth, w); }
float disc(float d, float w) { return clamp(.5 - d / max(w, 1e-4), 0.0, 1.0); }
float scan(float y) { return mod(y, 3.0) < 1.0 ? .09 * uScan : 0.0; }
vec4 datum(int x, int row) { return texelFetch(uData, ivec2(x, row), 0); }
// A lit window's blink keyframes (steps(1)), offset by its delay; it holds its base level until then.
float blink(float delay) {
  if (uClock < delay) return .85;
  float t = fract((uClock - delay) / uBlinkT.x);
  return t < uBlinkT.y ? .85 : t < uBlinkT.z ? uBlinkV.x : t < uBlinkT.w ? .85 : uBlinkV.y;
}
vec4 art(sampler2D t, vec4 box, vec4 props, vec2 p) {
  if (props.x <= 0.0) return vec4(0);
  vec2 q = p - box.xy; vec2 r = box.zw * .6;
  vec2 k = abs(q) - box.zw + r;
  float d = (length(max(k, 0.0) / r) - 1.0) * min(r.x, r.y) + min(max(k.x, k.y), 0.0);
  float a = (1.0 - smoothstep(-1.6 * props.y, 1.6 * props.y, d)) * props.x;
  return vec4(texture(t, clamp(q / (2.0 * box.zw) + .5, 0.0, 1.0)).rgb, a);
}
`;

export const main = `
void main() {
  vec2 p = vec2(gl_FragCoord.x, uDevH - gl_FragCoord.y) / uScale;
  vec3 col = uC[0].rgb;
  for (int i = 0; i < 3; i++) col = mix(col, uC[1 + i].rgb, clamp(1.0 - length((p - uLight[i].xy) / uLight[i].zw), 0.0, 1.0) * uLightA[i]);
  vec4 a0 = art(uArtT0, uArt[0], uArtP[0], p); col = mix(col, a0.rgb, a0.a);
  vec4 a1 = art(uArtT1, uArt[1], uArtP[1], p); col = mix(col, a1.rgb, a1.a);
  scenery(col, p);
  float e = length((p - vec2(.6, .35) * uSize) / (vec2(1.2, .9) * uSize));
  col = mix(col, uC[0].rgb, .7 * clamp((e - uVig) / (1.0 - uVig), 0.0, 1.0));
  outColor = vec4(col, 1.0);
}`;

export const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
export const hex = (value: string) => { value = value.trim(); return /^#[\da-f]{6}$/i.test(value) ? value : '#000000'; };
export const flatten = (entries: [string, number][]) => new Float32Array(entries.flatMap(([color, alpha]) => [...rgb(color), alpha]));

// CSS ease-in-out over an alternating animation (drifting lights, breathing sky, crackle).
export function alternate(clock: number, period: number) {
  const phase = clock / period; const step = Math.floor(phase); let t = phase - step;
  if (step % 2) t = 1 - t;
  return ease(t);
}
export const ease = (t: number) => t * t * (3 - 2 * t);

export function compile(gl: WebGL2RenderingContext, fragment: string): Program | null {
  const shader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); return s; };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, '#version 300 es\nin vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }'));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, 'a'); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (import.meta.env.DEV) console.error(gl.getProgramInfoLog(program), ...(gl.getAttachedShaders(program) || []).map(s => gl.getShaderInfoLog(s)));
    return null;
  }
  const cache: Record<string, WebGLUniformLocation | null> = {};
  const u = new Proxy(cache, { get: (store, name: string) => name in store ? store[name] : (store[name] = gl.getUniformLocation(program, name)) });
  return { program, u };
}

export function texture(gl: WebGL2RenderingContext, unit: number, source: TexImageSource, { mipmap = false, premultiply = false } = {}) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// Rows of vec4s a shader reads with texelFetch (lit windows, krackle voids).
export function dataTexture(gl: WebGL2RenderingContext, rows: number[][][]) {
  const data = new Float32Array(MAX_ROWS * rows.length * 4);
  rows.forEach((row, y) => row.slice(0, MAX_ROWS).forEach((value, x) => data.set(value.slice(0, 4), (y * MAX_ROWS + x) * 4)));
  const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MAX_ROWS, rows.length, 0, gl.RGBA, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}

// An SVG viewBox placed with preserveAspectRatio="xMidYMax slice" (or YMin) in a box, overflow visible.
export function slice(box: DOMRect, width: number, height: number, top = false) {
  const s = Math.max(box.width / width, box.height / height);
  return [box.left + (box.width - width * s) / 2, top ? box.top : box.bottom - height * s, width * s, height * s] as const;
}

export function polygonPath(points: string) {
  const path = new Path2D();
  points.split(' ').forEach((point, i) => { const [x, y] = point.split(',').map(Number); if (i) path.lineTo(x, y); else path.moveTo(x, y); });
  path.closePath();
  return path;
}
