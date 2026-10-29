import { compile, flatten, hex, head, main, alternate, type Frame, type LookScene, type Probe, type Program } from './shared';
import { overdrive } from './overdrive';
import { onModal, underModal } from '../motion';

// The room behind the portal, drawn in one WebGL canvas. As CSS it was a dozen full-screen
// translucent layers (cover light, a blurred cover, the look's scenery) that the compositor
// re-blended at full resolution on every frame; phones ran out of fill rate. Here each pixel is
// shaded once, at CSS-pixel resolution on touch screens, and nothing is drawn while the room is
// still. The DOM scenery stays mounted but unpainted: its boxes, opacities and classes still come
// from the stylesheets and motion.ts, so the looks read them instead of duplicating every layout
// state (browse, sleeve, sign-in, phone, power-on, relight).
//
// Reading that scenery forces style and layout, so it is measured once and kept: only a change in
// the scene (a mutation, a resize, an animation or transition starting or ending) measures it again,
// and only while one of its animations runs is it measured on every frame. Ambient motion between
// those moments is the canvas clock alone, at 30fps; transitions draw at up to 60fps.
//
// Panels that only ever sit over the room (the sidebar, the open player's footer and queue, lyrics)
// get their frosted glass here too: the drawn room is copied down to a quarter-size texture whose
// mip chain a final pass samples behind them. Their CSS backdrop-filter is off meanwhile (styles.css).

const classic: LookScene = {
  glsl: 'void scenery(inout vec3 col, vec2 p) {}', vignette: .4, matches: () => true,
  colors: (_, ground, glow) => [[ground, 1], [glow[0], 1], [glow[1], 1], [glow[2], 1]],
  create: () => ({ measure: () => undefined, feed: () => undefined }),
};
// The opt-in looks ship in their own chunks with the look, so each loads only when someone picks it.
// Each is found by the root of its DOM scenery.
const lazy: [string, () => Promise<LookScene>][] = [
  ['.ff-scene', () => import('./fantastic').then(module => module.fantastic)],
  ['.hh-scene', () => import('./haunted').then(module => module.haunted)],
];
const drifts = [[-9, 7, 1.12, 46], [10, -6, .92, 58], [-12, -8, 1.2, 38]] as const;
const MAX_GLASS = 6;
// Ambient drift and the rolling floor read as smooth at 30fps and cost half the GPU time; a
// transition (opening the player, the scenery travelling) gets up to 60fps, never the display's
// full rate. The small margin keeps a 60Hz display on every second frame despite timer jitter.
const AMBIENT = 1000 / 31; const TRANSITION = 1000 / 63;

const composite = `#version 300 es
precision highp float;
uniform sampler2D uRoom;
uniform vec2 uCanvas;
uniform float uScale, uLodShift;
uniform vec4 uGlass[${MAX_GLASS}], uGlassP[${MAX_GLASS}];
uniform int uGlassN;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uCanvas;
  vec2 p = vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) / uScale;
  vec4 acc = vec4(0);
  for (int i = 0; i < uGlassN; i++) {
    vec4 r = uGlass[i]; vec4 props = uGlassP[i]; vec2 h = r.zw * .5;
    vec2 q = abs(p - r.xy - h) - h + props.x;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - props.x;
    float inside = clamp(.5 - d * uScale, 0.0, 1.0);
    if (inside <= 0.0) continue;
    // blur(Npx): a few taps of the room's mip chain at about the blur's scale. The texture starts
    // a few mip levels down (uLodShift), so the same footprint is a lower level of it.
    float s = props.y * uScale; float lod = max(log2(max(s * .5, 1.0)) - uLodShift, 0.0); vec2 o = vec2(s * .6) / uCanvas;
    vec3 b = textureLod(uRoom, uv, lod).rgb * .2
      + (textureLod(uRoom, uv + vec2(o.x, 0.0), lod).rgb + textureLod(uRoom, uv - vec2(o.x, 0.0), lod).rgb
      + textureLod(uRoom, uv + vec2(0.0, o.y), lod).rgb + textureLod(uRoom, uv - vec2(0.0, o.y), lod).rgb) * .2;
    float l = dot(b, vec3(.2126, .7152, .0722));
    // Premultiplied, later panes over earlier ones; blended over the sharp room already drawn.
    acc = vec4(clamp(mix(vec3(l), b, props.z), 0.0, 1.0) * inside, inside) + acc * (1.0 - inside);
  }
  if (acc.a <= 0.0) discard;
  outColor = acc;
}`;

type Art = { texture: WebGLTexture | null; failed?: boolean };
type Ready = { look: LookScene; program: Program; measure: (probe: Probe) => void; feed: (frame: Frame) => void };
type Pane = { element: HTMLElement; radius: number; blur: number; saturate: number };
// Everything a frame needs from the DOM, measured only when the scene may have changed.
type Measured = {
  ready: Ready; colors: Float32Array; auth: boolean; performance: boolean;
  lights: Float32Array; lightAlpha: Float32Array;
  art: { entry: Art | undefined; x: number; y: number; w: number; h: number; opacity: number; blur: number }[];
};

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
      prepared.set(look, program && { look, program, ...look.create(gl) });
      if (!program) fail();
    }
    return prepared.get(look);
  };
  const loaded = new Map<string, LookScene>(); const loading = new Set<string>();
  const lookOf = (top: HTMLElement): LookScene | undefined => {
    if (overdrive.matches(top)) return overdrive;
    for (const [root, load] of lazy) {
      if (!top.querySelector(root)) continue;
      const look = loaded.get(root);
      if (!look && !loading.has(root)) { loading.add(root); void load().then(value => { loaded.set(root, value); loading.delete(root); wake(); }, () => loading.delete(root)); }
      return look;
    }
    return top.querySelector('.od-horizon') ? undefined : classic;
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
    const key = look.vignette + names.map(value).join() + (look === classic ? 'c' : look === overdrive ? 'o' : lazy.findIndex(([root]) => loaded.get(root) === look));
    let colors = palettes.get(key);
    if (!colors) { colors = flatten(look.colors(value('--accent'), value('--ground'), [value('--glow-1'), value('--glow-2'), value('--glow-3')])); palettes.set(key, colors); if (palettes.size > 16) palettes.delete(palettes.keys().next().value!); }
    return colors;
  };

  // Glass samples the drawn room copied down twice (each a 2x2 box average) into a quarter-size
  // texture, plus that texture's own mips: the blur's footprint at a fraction of the bandwidth of
  // rendering the room to a full-size texture and building its whole mip chain every frame.
  const targets: { texture: WebGLTexture; buffer: WebGLFramebuffer; width: number; height: number }[] = [];
  const target = (level: number) => {
    if (targets[level]) return targets[level];
    const width = Math.max(1, canvas.width >> level); const height = Math.max(1, canvas.height >> level);
    gl.activeTexture(gl.TEXTURE7); const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, level === 2 ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1, gl.RGBA8, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, level === 2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const buffer = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return targets[level] = { texture, buffer, width, height };
  };
  const dropTargets = () => { for (const t of targets) if (t) { gl.deleteFramebuffer(t.buffer); gl.deleteTexture(t.texture); } targets.length = 0; };

  let width = 0; let height = 0;
  const coarse = matchMedia('(pointer: coarse)');
  const resize = () => {
    width = scene.clientWidth; height = scene.clientHeight;
    const scale = coarse.matches ? 1 : Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    dropTargets();
  };

  const opacity = (element: Element | null) => element ? parseFloat(getComputedStyle(element).opacity) || 0 : 0;
  const blending = new Float32Array(4 * 32);
  const measure = (): Measured | null => {
    const rooms = scene.querySelectorAll<HTMLElement>(':scope > .room-colors');
    const top = rooms[rooms.length - 1];
    const look = top && lookOf(top); const ready = look && prepare(look);
    if (!top || !ready) return null;
    let colors = paletteOf(look, top);
    if (rooms.length > 1) {
      const from = paletteOf(look, rooms[0]); const t = opacity(top);
      const mixed = blending.length >= colors.length ? blending.subarray(0, colors.length) : new Float32Array(colors.length);
      for (let i = 0; i < colors.length; i++) mixed[i] = from[i] + (colors[i] - from[i]) * t;
      colors = mixed;
    }
    const performance = document.documentElement.hasAttribute('data-performance');
    const auth = !!scene.closest('.auth-page');
    const room = opacity(top.querySelector('.room-light'));
    const elements = top.querySelectorAll<HTMLElement>('.light');
    const lights = new Float32Array(12); const lightAlpha = new Float32Array(3);
    for (let i = 0; i < 3; i++) {
      const light = elements[i];
      if (!light) { lights.set([0, 0, 1, 1], i * 4); continue; }
      lights.set([light.offsetLeft + light.offsetWidth / 2, light.offsetTop + light.offsetHeight / 2, light.offsetWidth / 2, light.offsetHeight / 2], i * 4);
      lightAlpha[i] = opacity(light) * room;
    }
    const fields = [...top.querySelectorAll<HTMLImageElement>('img.artwork-field')].filter(image => image.offsetWidth).slice(-2);
    const art = fields.map(image => {
      const source = image.currentSrc || image.src; const style = getComputedStyle(image);
      return { entry: source ? artwork(source) : undefined, x: image.offsetLeft, y: image.offsetTop, w: image.offsetWidth, h: image.offsetHeight,
        opacity: parseFloat(style.opacity) || 0, blur: parseFloat(/blur\(([\d.]+)px\)/.exec(style.filter)?.[1] || '48') };
    });
    ready.measure({ top, scene, auth, performance, width, height, opacity });
    return { ready, colors, auth, performance, lights, lightAlpha, art };
  };

  // Glass panes: which elements, and their radius and blur, change with the page (lyrics, the queue
  // sheet, the open player); their boxes are read on each drawn frame, which needs no style work.
  let panes: Pane[] | null = null;
  const findPanes = () => [...document.querySelectorAll<HTMLElement>('[data-glass]')].flatMap(element => {
    const style = getComputedStyle(element); const glassy = style.getPropertyValue('--glass'); const blur = /blur\(([\d.]+)px\)/.exec(glassy);
    if (!blur || style.visibility === 'hidden' || style.display === 'none') return [];
    return [{ element, radius: parseFloat(style.borderTopLeftRadius) || 0, blur: parseFloat(blur[1]), saturate: parseFloat(/saturate\(([\d.]+)\)/.exec(glassy)?.[1] || '1') }];
  });
  const paneBoxes = new Float32Array(MAX_GLASS * 4); const paneProps = new Float32Array(MAX_GLASS * 4);
  const drawnBoxes = new Float32Array(MAX_GLASS * 4); const drawnProps = new Float32Array(MAX_GLASS * 4);
  let paneCount = 0; let drawnCount = 0;
  // Places the visible panes and reports whether that differs from the glass last drawn.
  const placePanes = (performance: boolean) => {
    paneCount = 0;
    if (!performance) {
      panes ||= findPanes();
      for (const { element, radius, blur, saturate } of panes) {
        if (paneCount === MAX_GLASS) break;
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || box.bottom < 0 || box.top > height) continue;
        const k = paneCount++ * 4;
        paneBoxes[k] = box.left; paneBoxes[k + 1] = box.top; paneBoxes[k + 2] = box.width; paneBoxes[k + 3] = box.height;
        paneProps[k] = Math.min(radius, box.width / 2, box.height / 2); paneProps[k + 1] = blur; paneProps[k + 2] = saturate;
      }
    }
    if (paneCount !== drawnCount) return true;
    for (let i = 0; i < paneCount * 4; i++) if (Math.abs(paneBoxes[i] - drawnBoxes[i]) > .25 || paneProps[i] !== drawnProps[i]) return true;
    return false;
  };

  let clock = 0; let last = 0; let drawn = 0; let frame = 0; let stopped = false;
  // measured: null after any change to the scene. watching: one of its animations may be running.
  // Under a modal dialog's backdrop the room holds still (motion.ts onModal).
  let measured: Measured | null = null; let watching = true; let fast = false; let changed = true;
  const artBoxes = new Float32Array(8); const artProps = new Float32Array(8); const lightBoxes = new Float32Array(12);

  const draw = (now: number) => {
    frame = 0;
    if (stopped) return;
    // Under a modal's backdrop the room draws once per change (a resize clears the canvas), never
    // per frame; closing the modal wakes it to measure and animate again.
    if (underModal()) {
      last = 0;
      if (!changed) return;
      measured = measure(); watching = false;
      if (measured) { placePanes(measured.performance); render(now, measured, false, false); }
      return;
    }
    const moving = scene.classList.contains('moving');
    if (moving && last) clock += Math.min(now - last, 100) / 1000;
    last = moving ? now : 0;
    const since = drawn ? now - drawn : Infinity;
    if (since < TRANSITION) { schedule(); return; }
    if (since < (watching && fast ? TRANSITION : AMBIENT)) {
      // Between ambient frames, draw early only when the glass moved (a swipe, a pane rising in), so
      // its blur keeps up with its pane.
      if (measured && !changed && placePanes(measured.performance)) render(now, measured, moving, true);
      else schedule();
      return;
    }
    if (!measured || watching) measured = measure();
    if (watching) {
      // Opening the player glides scenery with Web Animations (motion.ts), which fire no events;
      // they start in the same task as the class change that brought us here.
      const running = scene.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending);
      watching = running.length > 0;
      fast = running.some(animation => !(animation instanceof CSSAnimation && animation.animationName === 'room-relight'));
    }
    if (!measured) { if (moving || watching) schedule(); return; }
    const moved = placePanes(measured.performance);
    // A still room redraws only when something in it or the glass over it changed.
    if (moving || watching || changed || moved) render(now, measured, moving, moved);
  };
  const render = (now: number, measured: Measured, moving: boolean, moved: boolean) => {
    changed = false; drawn = now; drawnCount = paneCount; drawnBoxes.set(paneBoxes); drawnProps.set(paneProps);
    const { ready, colors, lights, lightAlpha, art, auth, performance } = measured;
    const { program: { program, u } } = ready;
    gl.useProgram(program);
    gl.uniform4fv(u.uC, colors);
    gl.uniform1f(u.uDevH, canvas.height); gl.uniform1f(u.uScale, canvas.width / Math.max(1, width));
    gl.uniform2f(u.uSize, width, height); gl.uniform1f(u.uClock, clock); gl.uniform1f(u.uVig, ready.look.vignette);
    gl.uniform1f(u.uScan, performance ? 0 : 1);

    const vmax = Math.max(width, height) / 100;
    for (let i = 0; i < 3; i++) {
      const [dx, dy, grow, period] = drifts[i]; const e = alternate(clock, period); const s = 1 + (grow - 1) * e; const k = i * 4;
      lightBoxes[k] = lights[k] + dx * vmax * e; lightBoxes[k + 1] = lights[k + 1] + dy * vmax * e;
      lightBoxes[k + 2] = lights[k + 2] * s; lightBoxes[k + 3] = lights[k + 3] * s;
    }
    gl.uniform4fv(u.uLight, lightBoxes); gl.uniform3fv(u.uLightA, lightAlpha);

    artBoxes.fill(0); artProps.fill(0);
    const drift = alternate(clock, 30); const grow = 1.12 + .06 * drift; const shift = -.01 + .02 * drift;
    for (let k = 0; k < 2; k++) {
      gl.activeTexture(k ? gl.TEXTURE1 : gl.TEXTURE0);
      const field = art[k]; const texture = field?.entry?.texture;
      gl.bindTexture(gl.TEXTURE_2D, texture || empty);
      if (!field || !texture) continue;
      const { x, y, w, h } = field; const j = k * 4;
      artBoxes[j] = x + w / 2 + w * shift * grow; artBoxes[j + 1] = y + h / 2 + h * shift * grow; artBoxes[j + 2] = w / 2 * grow; artBoxes[j + 3] = h / 2 * grow;
      artProps[j] = field.opacity; artProps[j + 1] = field.blur;
    }
    gl.uniform4fv(u.uArt, artBoxes); gl.uniform4fv(u.uArtP, artProps);
    gl.uniform1i(u.uArtT0, 0); gl.uniform1i(u.uArtT1, 1);
    ready.feed({ gl, u, scene, clock, moving, auth, performance, width, height });

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (paneCount) {
      const half = target(1); const quarter = target(2);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, half.buffer);
      gl.blitFramebuffer(0, 0, canvas.width, canvas.height, 0, 0, half.width, half.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, half.buffer); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, quarter.buffer);
      gl.blitFramebuffer(0, 0, half.width, half.height, 0, 0, quarter.width, quarter.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, quarter.texture); gl.generateMipmap(gl.TEXTURE_2D);
      gl.useProgram(glass.program);
      const scale = canvas.width / Math.max(1, width);
      gl.uniform1i(glass.u.uRoom, 7); gl.uniform2f(glass.u.uCanvas, canvas.width, canvas.height); gl.uniform1f(glass.u.uScale, scale);
      gl.uniform1f(glass.u.uLodShift, Math.log2(canvas.width / quarter.width));
      gl.uniform4fv(glass.u.uGlass, paneBoxes); gl.uniform4fv(glass.u.uGlassP, paneProps); gl.uniform1i(glass.u.uGlassN, paneCount);
      // Only the panes' bounds are shaded, over the room drawn above.
      let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
      for (let i = 0; i < paneCount; i++) { const k = i * 4; left = Math.min(left, paneBoxes[k]); top = Math.min(top, paneBoxes[k + 1]); right = Math.max(right, paneBoxes[k] + paneBoxes[k + 2]); bottom = Math.max(bottom, paneBoxes[k + 1] + paneBoxes[k + 3]); }
      const x = Math.max(0, Math.floor(left * scale)); const y = Math.max(0, Math.floor(canvas.height - bottom * scale));
      gl.enable(gl.SCISSOR_TEST); gl.scissor(x, y, Math.max(0, Math.min(canvas.width, Math.ceil(right * scale)) - x), Math.max(0, Math.min(canvas.height, Math.ceil(canvas.height - top * scale)) - y));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    }
    // Glass that just moved is followed until it settles (its pane may be animating).
    if (moving || watching || moved) schedule();
  };
  const schedule = () => { if (!frame && !stopped) frame = requestAnimationFrame(draw); };
  // Something in the scene changed: measure it again and watch for animations it started.
  const wake = () => { measured = null; watching = true; changed = true; drawn = 0; schedule(); };
  // The page around the glass changed: find the panes again on the next frame (one check however
  // many mutations arrive), without forcing style or layout in the middle of the page's update.
  const repane = () => { panes = null; schedule(); };

  resize();
  document.documentElement.dataset.glRoom = '';
  const resized = new ResizeObserver(() => { resize(); repane(); wake(); }); resized.observe(scene);
  const sceneChanges = new MutationObserver(wake);
  sceneChanges.observe(scene, { attributes: true, attributeFilter: ['class', 'style', 'src'], childList: true, subtree: true });
  sceneChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['data-performance', 'data-skin'] });
  const unmodal = onModal(wake);
  const page = new MutationObserver(records => { if (records.some(record => !scene.contains(record.target))) repane(); });
  page.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  const events = ['transitionrun', 'animationstart', 'transitionend', 'animationend', 'transitioncancel', 'animationcancel'] as const;
  for (const name of events) scene.addEventListener(name, wake, true);
  // A pane can move without a mutation: a scroll, or fonts settling the text around it.
  document.addEventListener('scroll', repane, { capture: true, passive: true });
  document.fonts?.addEventListener('loadingdone', repane);
  window.addEventListener('resize', wake);
  coarse.addEventListener('change', resize);
  const lost = (event: Event) => { event.preventDefault(); stopped = true; fail(); };
  canvas.addEventListener('webglcontextlost', lost);
  wake();
  return () => {
    stopped = true; cancelAnimationFrame(frame); resized.disconnect(); sceneChanges.disconnect(); page.disconnect(); unmodal();
    delete document.documentElement.dataset.glRoom;
    for (const name of events) scene.removeEventListener(name, wake, true);
    document.removeEventListener('scroll', repane, { capture: true }); document.fonts?.removeEventListener('loadingdone', repane);
    window.removeEventListener('resize', wake); coarse.removeEventListener('change', resize); canvas.removeEventListener('webglcontextlost', lost);
    // The context stays alive: a remount of the same canvas (React's development double mount) gets
    // it back from getContext, and an unmounted canvas releases it when collected.
    dropTargets();
  };
}
