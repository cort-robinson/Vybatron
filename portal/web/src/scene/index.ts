import { compile, flatten, hex, head, main, alternate, type Frame, type LookScene, type Program } from './shared';
import { overdrive } from './overdrive';

// The room behind the portal, drawn in one WebGL canvas. As CSS it was a dozen full-screen
// translucent layers (cover light, a blurred cover, the look's scenery) that the compositor
// re-blended at full resolution on every frame; phones ran out of fill rate. Here each pixel is
// shaded once, at CSS-pixel resolution on touch screens, and nothing is drawn while the room is
// still. The DOM scenery stays mounted but unpainted: its boxes, opacities and classes still come
// from the stylesheets and motion.ts, so the looks read them instead of duplicating every layout
// state (browse, sleeve, sign-in, phone, power-on, relight).
//
// Panels that only ever sit over the room (the sidebar, the open player's footer and queue, lyrics)
// get their frosted glass here too: with glass on screen the room renders to a texture, and a
// second pass blurs it behind them. Their CSS backdrop-filter is off meanwhile (styles.css).

const classic: LookScene = {
  glsl: 'void scenery(inout vec3 col, vec2 p) {}', vignette: .4, matches: () => true,
  colors: (_, ground, glow) => [[ground, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1]],
  create: () => ({ feed: () => undefined }),
};
// Fantastic ships in its own chunk with the look, so it loads only when someone picks it.
const lazy = { fantastic: () => import('./fantastic').then(module => module.fantastic) };
const drifts = [[-9, 7, 1.12, 46], [10, -6, .92, 58], [-12, -8, 1.2, 38]] as const;
const MAX_GLASS = 6;

const composite = `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform vec2 uCanvas;
uniform float uScale;
uniform vec4 uGlass[${MAX_GLASS}], uGlassP[${MAX_GLASS}];
uniform int uGlassN;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec3 col = texture(uRoom, uv).rgb;
  vec2 p = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) / uScale;
  for (int i = 0; i < uGlassN; i++) {
    vec4 r = uGlass[i]; vec4 props = uGlassP[i]; vec2 h = r.zw * .5;
    vec2 q = abs(p - r.xy - h) - h + props.x;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - props.x;
    float inside = clamp(.5 - d * uScale, 0.0, 1.0);
    if (inside <= 0.0) continue;
    // blur(Npx): a few taps of the room's mip chain at about the blur's scale.
    float s = props.y * uScale; float lod = log2(max(s * .5, 1.0)); vec2 o = vec2(s * .6) / uCanvas;
    vec3 b = textureLod(uRoom, uv, lod).rgb * .2
      + (textureLod(uRoom, uv + vec2(o.x, 0.0), lod).rgb + textureLod(uRoom, uv - vec2(o.x, 0.0), lod).rgb
      + textureLod(uRoom, uv + vec2(0.0, o.y), lod).rgb + textureLod(uRoom, uv - vec2(0.0, o.y), lod).rgb) * .2;
    float l = dot(b, vec3(.2126, .7152, .0722));
    col = mix(col, clamp(mix(vec3(l), b, props.z), 0.0, 1.0), inside);
  }
  outColor = vec4(col, 1.0);
}`;

type Art = { texture: WebGLTexture | null; failed?: boolean };
type Ready = { look: LookScene; program: Program; feed: (frame: Frame) => void };

export function startScene(canvas: HTMLCanvasElement, scene: HTMLElement, fail: () => void) {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  const glass = gl && compile(gl, composite);
  if (!gl || !glass) { fail(); return () => undefined; }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const prepared = new Map<LookScene, Ready | null>();
  const prepare = (look: LookScene) => {
    if (!prepared.has(look)) {
      const program = compile(gl, head(look.colors('#000000', '#000000', ['#000000', '#000000', '#000000']).length) + look.glsl + main);
      prepared.set(look, program && { look, program, feed: look.create(gl).feed });
      if (!program) fail();
    }
    return prepared.get(look);
  };
  const loaded = new Map<string, LookScene>();
  const lookOf = (top: HTMLElement): LookScene | undefined => {
    if (overdrive.matches(top)) return overdrive;
    if (top.querySelector('.ff-scene')) {
      const look = loaded.get('fantastic');
      if (!look && !loaded.has('loading')) { loaded.set('loading', classic); void lazy.fantastic().then(value => { loaded.set('fantastic', value); wake(); }, () => loaded.delete('loading')); }
      return look;
    }
    return top.querySelector('.od-horizon, .ff-scene') ? undefined : classic;
  };

  // A cover is pre-blurred once into a small texture; the shader only stretches it.
  gl.activeTexture(gl.TEXTURE0);
  const empty = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, empty); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
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
        gl.activeTexture(gl.TEXTURE0); const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, small);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        entry.texture = t;
      } catch { entry.failed = true; }
      wake();
    };
    image.onerror = () => { entry.failed = true; };
    image.src = url;
    return entry;
  };

  const palettes = new Map<string, Float32Array>();
  const paletteOf = (look: LookScene, room: HTMLElement) => {
    const value = (name: string) => hex(room.style.getPropertyValue(name));
    const names = ['--accent', '--ground', '--glow-1', '--glow-2', '--glow-3'];
    const key = look.vignette + names.map(value).join() + (look === classic ? 'c' : look === overdrive ? 'o' : 'f');
    let colors = palettes.get(key);
    if (!colors) { colors = flatten(look.colors(value('--accent'), value('--ground'), [value('--glow-1'), value('--glow-2'), value('--glow-3')])); palettes.set(key, colors); if (palettes.size > 16) palettes.delete(palettes.keys().next().value!); }
    return colors;
  };

  // The room renders to this texture (with mips for the blur) while glass is on screen.
  let roomTexture: WebGLTexture | null = null; let roomBuffer: WebGLFramebuffer | null = null;
  const roomTarget = () => {
    if (roomBuffer) return roomBuffer;
    gl.activeTexture(gl.TEXTURE7); roomTexture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, roomTexture);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(canvas.width, canvas.height))) + 1, gl.RGBA8, canvas.width, canvas.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    roomBuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, roomBuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, roomTexture, 0);
    return roomBuffer;
  };
  const dropTarget = () => { if (roomBuffer) gl.deleteFramebuffer(roomBuffer); if (roomTexture) gl.deleteTexture(roomTexture); roomBuffer = null; roomTexture = null; };

  let width = 0; let height = 0;
  const coarse = matchMedia('(pointer: coarse)');
  const resize = () => {
    width = scene.clientWidth; height = scene.clientHeight;
    const scale = coarse.matches ? 1 : Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    dropTarget();
  };

  let clock = 0; let last = 0; let drawn = 0; let frame = 0; let stopped = false;
  const opacity = (element: Element | null) => element ? parseFloat(getComputedStyle(element).opacity) || 0 : 0;
  const panes = () => [...document.querySelectorAll<HTMLElement>('[data-glass]')].flatMap(element => {
    const style = getComputedStyle(element); const blur = /blur\(([\d.]+)px\)/.exec(style.getPropertyValue('--glass'));
    const box = element.getBoundingClientRect();
    if (!blur || !box.width || !box.height || style.visibility === 'hidden' || box.bottom < 0 || box.top > height) return [];
    return [{ box, radius: Math.min(parseFloat(style.borderTopLeftRadius) || 0, box.width / 2, box.height / 2), blur: parseFloat(blur[1]), saturate: parseFloat(/saturate\(([\d.]+)\)/.exec(style.getPropertyValue('--glass'))?.[1] || '1') }];
  }).slice(0, MAX_GLASS);

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
    const look = top && lookOf(top); const ready = look && prepare(look);
    if (!top || !ready) { if (moving || busy) schedule(); return; }
    const { program: { program, u } } = ready;
    gl.useProgram(program);
    let colors = paletteOf(look, top);
    if (rooms.length > 1) {
      const from = paletteOf(look, rooms[0]); const t = opacity(top);
      colors = colors.map((value, i) => from[i] + (value - from[i]) * t);
    }
    const performance = document.documentElement.hasAttribute('data-performance');
    gl.uniform4fv(u.uC, colors);
    gl.uniform1f(u.uDevH, canvas.height); gl.uniform1f(u.uScale, canvas.width / Math.max(1, width));
    gl.uniform2f(u.uSize, width, height); gl.uniform1f(u.uClock, clock); gl.uniform1f(u.uVig, look.vignette);
    gl.uniform1f(u.uScan, performance ? 0 : 1);

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
      const image = fields[k]; const source = image?.currentSrc || image?.src; const entry = source ? artwork(source) : undefined;
      gl.bindTexture(gl.TEXTURE_2D, entry?.texture || empty);
      if (!image || !entry?.texture) continue;
      const style = getComputedStyle(image); const w = image.offsetWidth; const h = image.offsetHeight;
      artBoxes.set([image.offsetLeft + w / 2 + w * shift * grow, image.offsetTop + h / 2 + h * shift * grow, w / 2 * grow, h / 2 * grow], k * 4);
      artProps.set([parseFloat(style.opacity) || 0, parseFloat(/blur\(([\d.]+)px\)/.exec(style.filter)?.[1] || '48')], k * 4);
    }
    gl.uniform4fv(u.uArt, artBoxes); gl.uniform4fv(u.uArtP, artProps);
    gl.uniform1i(u.uArtT0, 0); gl.uniform1i(u.uArtT1, 1);
    ready.feed({ gl, u, top, scene, clock, moving, auth: !!scene.closest('.auth-page'), performance, width, height, opacity });

    const glassPanes = performance ? [] : panes();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, glassPanes.length ? roomTarget() : null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (glassPanes.length) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, roomTexture); gl.generateMipmap(gl.TEXTURE_2D);
      gl.useProgram(glass.program);
      gl.uniform1i(glass.u.uRoom, 7); gl.uniform2f(glass.u.uCanvas, canvas.width, canvas.height); gl.uniform1f(glass.u.uScale, canvas.width / Math.max(1, width));
      gl.uniform4fv(glass.u.uGlass, new Float32Array(MAX_GLASS * 4).fill(0).map((_, i) => { const pane = glassPanes[i >> 2]; return pane ? [pane.box.left, pane.box.top, pane.box.width, pane.box.height][i & 3] : 0; }));
      gl.uniform4fv(glass.u.uGlassP, new Float32Array(MAX_GLASS * 4).fill(0).map((_, i) => { const pane = glassPanes[i >> 2]; return pane ? [pane.radius, pane.blur, pane.saturate, 0][i & 3] : 0; }));
      gl.uniform1i(glass.u.uGlassN, glassPanes.length);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    if (moving || busy) schedule();
  };
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  const wake = () => { drawn = 0; schedule(); };

  resize();
  document.documentElement.dataset.glRoom = '';
  const resized = new ResizeObserver(() => { resize(); wake(); }); resized.observe(scene);
  const changed = new MutationObserver(wake);
  changed.observe(scene, { attributes: true, attributeFilter: ['class', 'style', 'src'], childList: true, subtree: true });
  changed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-performance', 'data-skin'] });
  // Glass panes come and go with the page (opening the player, lyrics); their boxes follow resizes.
  const page = new MutationObserver(wake); page.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  const events = ['transitionrun', 'animationstart', 'transitionend', 'animationend'] as const;
  for (const name of events) document.addEventListener(name, wake, true);
  window.addEventListener('resize', wake);
  coarse.addEventListener('change', resize);
  const lost = (event: Event) => { event.preventDefault(); stopped = true; fail(); };
  canvas.addEventListener('webglcontextlost', lost);
  wake();
  return () => {
    stopped = true; cancelAnimationFrame(frame); resized.disconnect(); changed.disconnect(); page.disconnect();
    delete document.documentElement.dataset.glRoom;
    for (const name of events) document.removeEventListener(name, wake, true);
    window.removeEventListener('resize', wake); coarse.removeEventListener('change', resize); canvas.removeEventListener('webglcontextlost', lost);
    // The context stays alive: a remount of the same canvas (React's development double mount) gets
    // it back from getContext, and an unmounted canvas releases it when collected.
    dropTarget();
  };
}
