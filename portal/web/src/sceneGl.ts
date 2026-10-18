import { mixOklab } from './art';
import { neon } from './skin';
import { H as SKY_H, W as SKY_W, skyline } from './components/Overdrive';

// The Overdrive room drawn in one WebGL canvas. As CSS it was a dozen full-screen translucent
// layers (cover light, a blurred cover, sky, a blended sun, skyline, a masked perspective floor),
// which the compositor re-blended at full resolution on every frame; phones ran out of fill rate.
// Here each pixel is shaded once, at CSS-pixel resolution on touch screens, and nothing is drawn
// while the scene is still. The DOM scenery stays mounted but invisible: its boxes, opacities and
// classes still come from styles.css and motion.ts, so this file reads them instead of
// duplicating the layout of every state (browse, sleeve, sign-in, phone, power-on, relight).

const MAX_WINDOWS = 32;
const sunset = '#ff8a4c';
const vertex = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }`;
const fragment = `#version 300 es
precision highp float;
uniform float uDevH, uScale, uScan;
uniform vec2 uSize;
uniform vec4 uC[19];
uniform vec4 uLight[3];
uniform vec3 uLightA;
uniform vec4 uArt[2], uArtP[2];
uniform sampler2D uArtT0, uArtT1, uLineT;
uniform float uHA, uSkyA, uLineA, uFloorA;
uniform vec4 uSun, uLine, uFloor;
uniform vec2 uSunP, uGrid;
uniform vec4 uWin[${MAX_WINDOWS}];
uniform int uWinN;
out vec4 outColor;

void over(inout vec4 d, vec3 c, float a) { d = vec4(c * a, a) + d * (1.0 - a); }
// Share of a pixel footprint (centred at x, width w) covered by the interval [lo, hi].
float cover(float x, float lo, float hi, float w) { return clamp((min(hi, x + w * .5) - max(lo, x - w * .5)) / w, 0.0, 1.0); }
float line(float d, float halfWidth, float w) { return cover(d, -halfWidth, halfWidth, max(w, 1e-4)); }
float scan(float y) { return mod(y, 3.0) < 1.0 ? .09 * uScan : 0.0; }
vec4 art(sampler2D t, vec4 box, vec4 props, vec2 p) {
  if (props.x <= 0.0) return vec4(0);
  vec2 q = p - box.xy; vec2 r = box.zw * .6;
  vec2 k = abs(q) - box.zw + r;
  float d = (length(max(k, 0.0) / r) - 1.0) * min(r.x, r.y) + min(max(k.x, k.y), 0.0);
  float a = (1.0 - smoothstep(-1.6 * props.y, 1.6 * props.y, d)) * props.x;
  return vec4(texture(t, clamp(q / (2.0 * box.zw) + .5, 0.0, 1.0)).rgb, a);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uDevH - gl_FragCoord.y) / uScale;
  vec3 col = uC[0].rgb;
  for (int i = 0; i < 3; i++) col = mix(col, uC[1 + i].rgb, clamp(1.0 - length((p - uLight[i].xy) / uLight[i].zw), 0.0, 1.0) * uLightA[i]);
  vec4 a0 = art(uArtT0, uArt[0], uArtP[0], p); col = mix(col, a0.rgb, a0.a);
  vec4 a1 = art(uArtT1, uArt[1], uArtP[1], p); col = mix(col, a1.rgb, a1.a);

  if (uHA > 0.0) {
    vec4 g = vec4(0);
    float horizon = uFloor.y; float sunX = uSun.x;
    if (p.y < horizon) {
      vec4 s = vec4(0);
      over(s, uC[5].rgb, uC[5].a * clamp((p.y / horizon - .35) / .65, 0.0, 1.0));
      float e = length((p - vec2(sunX, horizon)) / vec2(.42 * uSize.x, .6 * horizon));
      over(s, uC[4].rgb, uC[4].a * clamp(1.0 - e / .72, 0.0, 1.0));
      over(s, vec3(0), scan(p.y));
      g = s * uSkyA + g * (1.0 - s.a * uSkyA);
    }
    if (uSunP.x > 0.0) {
      vec2 q = (p - uSun.xy) / uSun.zw; float r = length(q); float fr = fwidth(r);
      float inside = 1.0 - smoothstep(1.0 - fr, 1.0 + fr, r);
      if (inside > 0.0) {
        float v = (q.y + 1.0) * .5; float fv = fwidth(v);
        float cut = cover(v, .48, .505, fv) + cover(v, .58, .615, fv) + cover(v, .675, .72, fv) + cover(v, .77, .825, fv) + cover(v, .865, .93, fv);
        vec3 c = v < .5 ? mix(uC[6].rgb, uC[7].rgb, clamp((v - .06) / .44, 0.0, 1.0)) : mix(uC[7].rgb, uC[8].rgb, clamp((v - .5) / .36, 0.0, 1.0));
        c *= 1.0 - scan(p.y);
        if (uSunP.y > 0.0 && g.a > 0.0) { vec3 b = g.rgb / g.a; c = mix(c, 1.0 - (1.0 - c) * (1.0 - b), g.a); }
        over(g, c, inside * (1.0 - cut) * uSunP.x);
      }
    }
    vec2 uv = (p - uLine.xy) / uLine.zw;
    if (uLineA > 0.0 && uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
      vec3 m = texture(uLineT, uv).rgb; vec4 l = vec4(0);
      over(l, uC[9].rgb, uC[9].a * m.r); over(l, uC[10].rgb, m.g); over(l, uC[11].rgb, uC[11].a * m.b);
      vec2 w = uv * vec2(${SKY_W}.0, ${SKY_H}.0); vec2 fw = fwidth(w);
      for (int i = 0; i < ${MAX_WINDOWS}; i++) {
        if (i >= uWinN) break;
        vec4 win = uWin[i];
        float cov = cover(w.x, win.x, win.x + 5.0, fw.x) * cover(w.y, win.y, win.y + 2.0, fw.y);
        if (cov > 0.0) over(l, uC[12].rgb, win.z * cov);
      }
      g = l * uLineA + g * (1.0 - l.a * uLineA);
    }
    float y = p.y - uFloor.y; float x = p.x - uFloor.x;
    if (uFloorA > 0.0 && y >= 0.0 && x >= 0.0 && x <= uFloor.z) {
      float f = y / uFloor.w;
      vec4 fl = vec4(f < .4 ? mix(uC[13].rgb, uC[14].rgb, f / .4) : mix(uC[14].rgb, uC[0].rgb, clamp((f - .4) / .5, 0.0, 1.0)), 1.0);
      fl.rgb *= 1.0 - scan(p.y);
      // The rolling plane: 1000px of 72px cells tilted 80deg about the floor's bottom edge and seen
      // through a 300px perspective from the sun, as the CSS transform drew it.
      const float d = 300.0; const float cs = .173648; const float sn = .984808;
      float v = d * (uFloor.w - y) / (y * sn + d * cs);
      float u = uGrid.x + (x - uGrid.x) * (d + v * sn) / d;
      float vc = v + uGrid.y;
      if (vc < 1000.0 && u > -uFloor.z && u < 2.0 * uFloor.z) {
        float mask = clamp(((1000.0 - vc) / 1000.0 - .08) / .52, 0.0, 1.0);
        float fu = fwidth(u); float fvc = fwidth(vc);
        float du = abs(mod(u - (uFloor.z * .5 - 36.0) - 1.0 + 36.0, 72.0) - 36.0);
        float dv = abs(mod(vc + 1.0 + 36.0, 72.0) - 36.0);
        float cov = max(line(du, 1.0, fu), line(dv, 1.0, fvc)) * clamp(2.0 - max(fu, fvc) / 18.0, 0.0, 1.0);
        over(fl, uC[18].rgb, uC[18].a * mask * cov);
      }
      // The rail's box-shadow (22px blur, 3px spread): an 8px strip under a Gaussian of sigma 11.
      over(fl, uC[17].rgb, uC[17].a * .29 * exp(-(y - 1.0) * (y - 1.0) / 242.0));
      if (y < 2.0) {
        float fx = x / uFloor.z;
        vec4 rail = fx < .18 ? vec4(uC[15].rgb, uC[15].a * fx / .18) : fx < .5 ? mix(uC[15], uC[16], (fx - .18) / .32) : fx < .82 ? mix(uC[16], uC[15], (fx - .5) / .32) : vec4(uC[15].rgb, uC[15].a * (1.0 - fx) / .18);
        over(fl, rail.rgb, rail.a);
      }
      g = fl * uFloorA + g * (1.0 - uFloorA);
    }
    col = col * (1.0 - g.a * uHA) + g.rgb * uHA;
  }
  float e = length((p - vec2(.6, .35) * uSize) / (vec2(1.2, .9) * uSize));
  col = mix(col, uC[0].rgb, .7 * clamp((e - .4) / .6, 0.0, 1.0));
  outColor = vec4(col, 1.0);
}`;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
const hex = (value: string) => { value = value.trim(); return /^#[\da-f]{6}$/i.test(value) ? value : '#000000'; };

// Every color the scene mixes, resolved once per palette (the CSS color-mix() terms, in oklab).
function derive(accent: string, ground: string, glow: string[]) {
  const entries: [string, number][] = [
    [ground, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1],
    [neon, .34], [neon, .09],
    [mixOklab('#ffe58a', accent, .28), 1], [mixOklab(accent, sunset, .88), 1], [neon, 1],
    [mixOklab(ground, glow[1], .55), .85], [mixOklab(ground, '#000000', .3), 1], [accent, .55], [mixOklab('#ffffff', accent, .8), .85],
    [mixOklab(ground, neon, .2), 1], [mixOklab(ground, glow[1], .25), 1],
    [accent, .7], [neon, .75], [neon, .45],
    [mixOklab(accent, neon, .55), .72],
  ];
  return new Float32Array(entries.flatMap(([color, alpha]) => [...rgb(color), alpha]));
}

// CSS ease-in-out over an alternating animation, as the drifting light and breathing sky ran.
function alternate(clock: number, period: number) {
  const phase = clock / period; const step = Math.floor(phase); let t = phase - step;
  if (step % 2) t = 1 - t;
  return t * t * (3 - 2 * t);
}
// The window blink keyframes (steps(1)), offset by each window's delay.
function blink(clock: number, delay: number) {
  if (clock < delay) return .85;
  const t = ((clock - delay) / 9) % 1;
  return t < .41 ? .85 : t < .47 ? .15 : t < .78 ? .85 : .4;
}
const drifts = [[-9, 7, 1.12, 46], [10, -6, .92, 58], [-12, -8, 1.2, 38]] as const;

type Art = { texture: WebGLTexture | null; failed?: boolean };

export function startScene(canvas: HTMLCanvasElement, scene: HTMLElement, fail: () => void) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) { fail(); return () => undefined; }
  const shader = (type: number, source: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s); return s; };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(program, 0, 'a'); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { fail(); return () => undefined; }
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = new Proxy({} as Record<string, WebGLUniformLocation | null>, { get: (cache, name: string) => name in cache ? cache[name] : (cache[name] = gl.getUniformLocation(program, name)) });

  const texture = (source: TexImageSource, mipmap: boolean) => {
    const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    if (mipmap) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmap ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  // The skyline as a coverage mask: far towers in red, near towers in green, their edge in blue.
  const far = skyline(7, .72); const near = skyline(23, 1);
  const mask = document.createElement('canvas'); mask.width = 2048; mask.height = 192;
  const m = mask.getContext('2d')!; m.scale(mask.width / SKY_W, mask.height / SKY_H);
  m.fillStyle = '#000'; m.fillRect(0, 0, SKY_W, SKY_H); m.globalCompositeOperation = 'lighter';
  const polygon = (points: string) => { const path = new Path2D(); points.split(' ').forEach((point, i) => { const [x, y] = point.split(',').map(Number); if (i) path.lineTo(x, y); else path.moveTo(x, y); }); path.closePath(); return path; };
  m.fillStyle = '#f00'; m.fill(polygon(far.path)); m.fillStyle = '#0f0'; m.fill(polygon(near.path));
  m.strokeStyle = '#00f'; m.lineJoin = 'bevel'; m.lineWidth = 1.6; m.stroke(polygon(near.path));
  gl.activeTexture(gl.TEXTURE2); texture(mask, true);
  const windows = near.windows.slice(0, MAX_WINDOWS);

  // A cover is pre-blurred once into a small texture; the shader only stretches it.
  const blank = new Uint8Array([0, 0, 0, 255]);
  gl.activeTexture(gl.TEXTURE0);
  const empty = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, empty); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, blank);
  const arts = new Map<string, Art>();
  const artwork = (url: string) => {
    let entry = arts.get(url);
    if (entry) return entry;
    entry = { texture: null }; arts.set(url, entry);
    if (arts.size > 6) { const [oldest, value] = arts.entries().next().value!; if (value.texture) gl.deleteTexture(value.texture); arts.delete(oldest); }
    const image = new Image(); image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer';
    image.onload = () => {
      try {
        const size = 32; const small = Object.assign(document.createElement('canvas'), { width: size, height: size });
        const c = small.getContext('2d', { willReadFrequently: true })!; c.drawImage(image, 0, 0, size, size);
        const pixels = c.getImageData(0, 0, size, size); const d = pixels.data;
        for (let i = 0; i < d.length; i += 4) { const l = .2126 * d[i] + .7152 * d[i + 1] + .0722 * d[i + 2]; for (let k = 0; k < 3; k++) d[i + k] = l + (d[i + k] - l) * 1.25; }
        for (let pass = 0; pass < 3; pass++) for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const copy = d.slice();
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let k = 0; k < 3; k++) {
            let sum = 0; for (let o = -2; o <= 2; o++) { const sx = Math.min(size - 1, Math.max(0, x + o * dx)); const sy = Math.min(size - 1, Math.max(0, y + o * dy)); sum += copy[(sy * size + sx) * 4 + k]; }
            d[(y * size + x) * 4 + k] = sum / 5;
          }
        }
        c.putImageData(pixels, 0, 0);
        gl.activeTexture(gl.TEXTURE0); entry.texture = texture(small, false);
      } catch { entry.failed = true; }
      wake();
    };
    image.onerror = () => { entry.failed = true; };
    image.src = url;
    return entry;
  };

  const palettes = new Map<string, Float32Array>();
  const paletteOf = (room: HTMLElement) => {
    const style = room.style; const value = (name: string) => hex(style.getPropertyValue(name));
    const key = ['--accent', '--ground', '--glow-1', '--glow-2', '--glow-3'].map(value).join();
    let colors = palettes.get(key);
    if (!colors) { colors = derive(value('--accent'), value('--ground'), [value('--glow-1'), value('--glow-2'), value('--glow-3')]); palettes.set(key, colors); if (palettes.size > 12) palettes.delete(palettes.keys().next().value!); }
    return colors;
  };

  let width = 0; let height = 0; let scale = 1;
  const coarse = matchMedia('(pointer: coarse)');
  const resize = () => {
    width = scene.clientWidth; height = scene.clientHeight;
    scale = coarse.matches ? 1 : Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  let clock = 0; let last = 0; let drawn = 0; let frame = 0; let stopped = false;
  const opacity = (element: Element | null) => element ? parseFloat(getComputedStyle(element).opacity) || 0 : 0;
  const draw = (now: number) => {
    frame = 0;
    if (stopped) return;
    const moving = scene.classList.contains('moving');
    if (moving && last) clock += Math.min(now - last, 100) / 1000;
    last = moving ? now : 0;
    const busy = scene.getAnimations({ subtree: true }).some(animation => animation.playState === 'running');
    // Ambient motion is capped at 60fps; transitions (opening the player, a relight) draw every frame.
    if (!busy && drawn && now - drawn < 1000 / 62) { schedule(); return; }
    drawn = now;
    const rooms = [...scene.querySelectorAll<HTMLElement>(':scope > .room-colors')];
    const top = rooms.at(-1);
    if (!top) return;
    let colors = paletteOf(top);
    if (rooms.length > 1) {
      const from = paletteOf(rooms[0]); const t = opacity(top);
      colors = colors.map((value, i) => from[i] + (value - from[i]) * t);
    }
    gl.uniform4fv(u.uC, colors);
    gl.uniform1f(u.uDevH, canvas.height); gl.uniform1f(u.uScale, canvas.width / Math.max(1, width));
    gl.uniform2f(u.uSize, width, height);
    gl.uniform1f(u.uScan, document.documentElement.hasAttribute('data-performance') ? 0 : 1);

    const vmax = Math.max(width, height) / 100;
    const room = opacity(top.querySelector('.room-light'));
    const lights = [...top.querySelectorAll<HTMLElement>('.light')].slice(0, 3);
    const lightBoxes: number[] = []; const lightAlpha: number[] = [];
    drifts.forEach(([dx, dy, grow, period], i) => {
      const light = lights[i]; const e = alternate(clock, period); const s = 1 + (grow - 1) * e;
      if (!light) { lightBoxes.push(0, 0, 1, 1); lightAlpha.push(0); return; }
      lightBoxes.push(light.offsetLeft + light.offsetWidth / 2 + dx * vmax * e, light.offsetTop + light.offsetHeight / 2 + dy * vmax * e, light.offsetWidth / 2 * s, light.offsetHeight / 2 * s);
      lightAlpha.push(opacity(light) * room);
    });
    gl.uniform4fv(u.uLight, lightBoxes); gl.uniform3fv(u.uLightA, lightAlpha);

    const fields = [...top.querySelectorAll<HTMLImageElement>('img.artwork-field')].filter(image => image.offsetWidth).slice(-2);
    const artBoxes = new Float32Array(8); const artProps = new Float32Array(8);
    const drift = alternate(clock, 30); const grow = 1.12 + .06 * drift; const shift = -.01 + .02 * drift;
    for (let k = 0; k < 2; k++) {
      gl.activeTexture(k ? gl.TEXTURE1 : gl.TEXTURE0);
      const image = fields[k]; const entry = image?.currentSrc || image?.src ? artwork(image.currentSrc || image.src) : undefined;
      gl.bindTexture(gl.TEXTURE_2D, entry?.texture || empty);
      if (!image || !entry?.texture) continue;
      const style = getComputedStyle(image);
      const w = image.offsetWidth; const h = image.offsetHeight;
      artBoxes.set([image.offsetLeft + w / 2 + w * shift * grow, image.offsetTop + h / 2 + h * shift * grow, w / 2 * grow, h / 2 * grow], k * 4);
      artProps.set([parseFloat(style.opacity) || 0, parseFloat(/blur\(([\d.]+)px\)/.exec(style.filter)?.[1] || '48')], k * 4);
    }
    gl.uniform4fv(u.uArt, artBoxes); gl.uniform4fv(u.uArtP, artProps);

    const horizon = top.querySelector('.od-horizon');
    gl.uniform1f(u.uHA, opacity(horizon));
    if (horizon) {
      const sun = horizon.querySelector('.od-sun')!; const line = horizon.querySelector('.od-skyline')!; const floor = horizon.querySelector('.od-floor')!;
      const sunBox = sun.getBoundingClientRect(); const lineBox = line.getBoundingClientRect(); const floorBox = floor.getBoundingClientRect();
      const screen = !scene.classList.contains('immersive') && !scene.closest('.auth-page') && !document.documentElement.hasAttribute('data-performance');
      gl.uniform4f(u.uSun, sunBox.left + sunBox.width / 2, sunBox.top + sunBox.height / 2, sunBox.width / 2, sunBox.height / 2);
      gl.uniform2f(u.uSunP, opacity(sun), screen ? 1 : 0);
      // preserveAspectRatio="xMidYMax slice", with overflow visible.
      const s = Math.max(lineBox.width / SKY_W, lineBox.height / SKY_H);
      gl.uniform4f(u.uLine, lineBox.left + (lineBox.width - SKY_W * s) / 2, lineBox.bottom - SKY_H * s, SKY_W * s, SKY_H * s);
      gl.uniform1f(u.uLineA, opacity(line));
      gl.uniform4f(u.uFloor, floorBox.left, floorBox.top, floorBox.width, floorBox.height);
      gl.uniform1f(u.uFloorA, opacity(floor));
      const roll = scene.closest('.auth-page') ? 4 : 2.6;
      gl.uniform2f(u.uGrid, sunBox.left + sunBox.width / 2 - floorBox.left, (clock / roll % 1) * 72);
      gl.uniform1f(u.uSkyA, moving ? 1 - .28 * alternate(clock, 7) : 1);
      gl.uniform4fv(u.uWin, new Float32Array(MAX_WINDOWS * 4).map((_, i) => { const w = windows[i >> 2]; return !w ? 0 : [w.x, w.y, blink(clock, w.delay), 0][i & 3]; }));
      gl.uniform1i(u.uWinN, windows.length);
    }
    gl.uniform1i(u.uArtT0, 0); gl.uniform1i(u.uArtT1, 1); gl.uniform1i(u.uLineT, 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (moving || busy) schedule();
  };
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  const wake = () => { drawn = 0; schedule(); };

  resize();
  const resized = new ResizeObserver(() => { resize(); wake(); }); resized.observe(scene);
  const changed = new MutationObserver(wake);
  changed.observe(scene, { attributes: true, attributeFilter: ['class', 'style', 'src'], childList: true, subtree: true });
  changed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-performance'] });
  scene.addEventListener('transitionrun', wake, true); scene.addEventListener('animationstart', wake, true);
  coarse.addEventListener('change', resize);
  const lost = (event: Event) => { event.preventDefault(); stopped = true; fail(); };
  canvas.addEventListener('webglcontextlost', lost);
  wake();
  return () => {
    stopped = true; cancelAnimationFrame(frame); resized.disconnect(); changed.disconnect();
    scene.removeEventListener('transitionrun', wake, true); scene.removeEventListener('animationstart', wake, true);
    coarse.removeEventListener('change', resize); canvas.removeEventListener('webglcontextlost', lost);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}
