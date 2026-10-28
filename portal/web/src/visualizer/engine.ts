import { compile, hex, rgb, type Program } from '../scene/shared';
import { random } from '../random';
import { coveredByModal, onModal } from '../motion';
import type { Palette } from '../art';
import { signalFor, type Features, type Signal, type Source } from './signal';
import { analysisFor } from './analysis';
import { shaders } from './shaders';
import type { PresetId } from './presets';

// One visualizer on one canvas, in its own WebGL2 context. Like the room (scene/index.ts) it draws at
// 30fps, at a fraction of the canvas's CSS pixels, with no DOM reads between frames: the canvas size
// comes from a ResizeObserver, the position from the last snapshot and the clock. It stops drawing
// altogether when it can't be seen (offscreen, a hidden tab, under another modal) and once a paused
// or idle song has eased into standby; reduced motion and a stilled sleeve get one composed frame.
export type View = {
  preset: PresetId; seed: string; playing: boolean; positionMs: number; at: number; palette: Palette;
  // The song's energy map, when it has one: its server and YouTube video. lagMs: how far what is
  // heard trails the reported position; rate: how fast the song's own time runs (a speed preset).
  guildId: string | null; video: string | null; lagMs: number; rate: number;
  // animate: a loop at all; full: the full-screen takeover; lite: performance mode's lower resolution.
  animate: boolean; full: boolean; lite: boolean;
};
export type Visualizer = { update: (view: View) => void; stop: () => void };

const FRAME = 1000 / 31;
// Neon's trails need a few frames to build; a fresh buffer is run this many times before it shows.
const WARM = 24;

export function startVisualizer(canvas: HTMLCanvasElement, fail: () => void, sourced: (source: Source) => void): Visualizer | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) { fail(); return null; }
  const triangle = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, triangle); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Only the presets actually shown are compiled.
  const programs = new Map<PresetId, Program[] | null>();
  const programsFor = (preset: PresetId) => {
    if (!programs.has(preset)) {
      const compiled = shaders[preset].map(source => compile(gl, source));
      programs.set(preset, compiled.every(Boolean) ? compiled as Program[] : null);
    }
    return programs.get(preset);
  };

  // Neon's ping-pong pair, at half the canvas's resolution.
  let feed: { texture: WebGLTexture; buffer: WebGLFramebuffer }[] = []; let feedWidth = 0; let feedHeight = 0; let fresh = true;
  const dropFeed = () => { for (const t of feed) { gl.deleteFramebuffer(t.buffer); gl.deleteTexture(t.texture); } feed = []; fresh = true; };
  const feedFor = () => {
    const width = Math.max(1, canvas.width >> 1); const height = Math.max(1, canvas.height >> 1);
    if (feed.length && width === feedWidth && height === feedHeight) return feed;
    dropFeed(); feedWidth = width; feedHeight = height;
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0); const texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const buffer = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, buffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      feed.push({ texture, buffer });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return feed;
  };

  let view: View | null = null; let signal: Signal | null = null; let seed = 0;
  // The map being fetched for this song (its key, and how to stop asking), and the last moment drawn.
  let mapKey: string | null = null; let loading: AbortController | null = null; let shown: Features | undefined;
  const colors = new Float32Array(15); let palette: Palette | null = null;
  let time = 0; let drive = 0; let speed = 0;
  const common = ({ u }: Program, width: number, height: number, f: Features) => {
    gl.uniform2f(u.uRes, width, height); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uDrive, drive); gl.uniform1f(u.uSeed, seed); gl.uniform1f(u.uFull, view!.full ? 1 : 0);
    gl.uniform1fv(u.uB, f.bands); gl.uniform1fv(u.uP, f.peaks); gl.uniform4f(u.uF, f.bass, f.mid, f.treble, f.level); gl.uniform2f(u.uBeat, f.beat, f.beats);
    gl.uniform3fv(u.uC, colors);
  };
  // pace: how much the frame moves on (0 when still). warm: run Neon's feedback that many times first.
  const render = (f: Features, dt: number, pace: number, warm = 0) => {
    const compiled = programsFor(view!.preset);
    if (!compiled) { lose(); return; }
    if (view!.preset === 'neon') {
      const [flow, show] = compiled; const targets = feedFor();
      gl.useProgram(flow.program); common(flow, feedWidth, feedHeight, f);
      gl.uniform1f(flow.u.uFold, 5 + Math.floor(seed * 4)); gl.uniform1i(flow.u.uPrev, 0);
      // Zoom and turn per frame; the turn reverses with each 8-bar phrase.
      const turn = Math.floor(f.beats / 32) % 2 ? -1 : 1;
      // A fresh buffer builds its trails as if the song were already moving.
      if (fresh) pace = Math.max(pace, .7);
      gl.uniform4f(flow.u.uFlow, dt * pace * (.16 + .5 * f.bass + .8 * f.beat), dt * pace * (.1 + .3 * f.mid) * turn, Math.exp(-dt * (2 + 1.6 * (1 - f.level))), dt * pace * .5);
      gl.viewport(0, 0, feedWidth, feedHeight); gl.activeTexture(gl.TEXTURE0);
      for (let i = fresh ? Math.max(warm, WARM) : 1; i > 0; i--) {
        gl.bindTexture(gl.TEXTURE_2D, targets[0].texture); gl.bindFramebuffer(gl.FRAMEBUFFER, targets[1].buffer);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const read = targets[0]; targets[0] = targets[1]; targets[1] = read;
      }
      fresh = false;
      gl.useProgram(show.program); common(show, canvas.width, canvas.height, f); gl.uniform1i(show.u.uFeed, 0);
      gl.bindTexture(gl.TEXTURE_2D, targets[0].texture);
    } else {
      gl.useProgram(compiled[0].program); common(compiled[0], canvas.width, canvas.height, f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!drawn) { drawn = true; canvas.dataset.drawn = ''; }
  };

  let width = 0; let height = 0; let intersecting = true; let covered = false; let lost = false; let drawn = false;
  let frame = 0; let last = 0; let dirty = true;
  const visible = () => !!view && width > 0 && height > 0 && intersecting && !covered && !lost && !document.hidden;
  const position = () => (view!.playing ? view!.positionMs + Math.max(0, Date.now() - view!.at) * view!.rate : view!.positionMs) - view!.lagMs;
  const halt = () => { cancelAnimationFrame(frame); frame = 0; last = 0; };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(tick); };
  const tick = (now: number) => {
    frame = 0;
    if (!visible()) { last = 0; return; }
    if (last && now - last < FRAME) { schedule(); return; }
    const dt = last ? Math.min(.1, (now - last) / 1000) : 1 / 30; last = now;
    const f = shown = signal!.features(position(), dt, view!.playing);
    // The scene slows to a stop as playback pauses, and picks up again as it resumes.
    speed += ((view!.playing ? 1 : 0) - speed) * (1 - Math.exp(-dt * 2.2));
    time += dt * speed; drive += dt * speed * (.6 + 1.4 * f.bass + .8 * f.beat);
    render(f, dt, speed);
    if (view!.playing || !f.settled || speed > .005) schedule(); else last = 0;
  };
  // A composed still: the song's shape at its position, and a scene placed by that position.
  const still = () => {
    const ms = position(); const f = shown = signal!.still(ms, view!.playing);
    time = ms / 1000; drive = time * 1.1; speed = 0;
    render(f, 1 / 30, view!.playing ? 1 : .3, WARM);
  };
  const wake = () => {
    if (!visible()) { halt(); return; }
    if (!view!.animate) { halt(); if (dirty) { dirty = false; still(); } return; }
    dirty = false; schedule();
  };

  // The drawing buffer: on the full screen three quarters of its CSS pixels (half in performance
  // mode), capped in total so a large display doesn't cost more; in the sleeve about its CSS pixels.
  const coarse = matchMedia('(pointer: coarse)');
  const fit = () => {
    if (!view || !width || !height) return;
    const ratio = Math.min(devicePixelRatio || 1, view.full ? 1 : 1.5);
    const scale = view.full ? (view.lite ? .5 : .75) * (coarse.matches ? 1 : ratio) : coarse.matches ? 1 : ratio;
    const cap = view.full ? view.lite ? 300_000 : coarse.matches ? 420_000 : 900_000 : 360_000;
    const k = Math.min(1, Math.sqrt(cap / (width * scale * height * scale)));
    const w = Math.max(1, Math.round(width * scale * k)); const h = Math.max(1, Math.round(height * scale * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dirty = true; fresh = true; }
  };
  const resized = new ResizeObserver(([entry]) => { width = entry.contentRect.width; height = entry.contentRect.height; fit(); dirty = true; wake(); });
  resized.observe(canvas);
  const intersection = new IntersectionObserver(entries => { intersecting = entries[entries.length - 1].isIntersecting; wake(); }); intersection.observe(canvas);
  // Its own full-screen dialog doesn't cover it; anything else modal does, and then it holds still.
  const modal = () => { covered = coveredByModal(canvas); wake(); };
  const unmodal = onModal(modal); covered = coveredByModal(canvas);
  document.addEventListener('visibilitychange', wake);
  const refit = () => { fit(); wake(); }; coarse.addEventListener('change', refit);
  const lose = () => { lost = true; halt(); fail(); };
  const contextLost = (event: Event) => { event.preventDefault(); lose(); };
  canvas.addEventListener('webglcontextlost', contextLost);

  return {
    update(next) {
      const key = next.guildId && next.video ? `${next.guildId}/${next.video}` : null;
      if (next.seed !== view?.seed || key !== mapKey) {
        // Each song starts on its generated motion and moves to its measured energy once that arrives.
        signal = signalFor(next.seed); seed = random(next.seed)(); sourced(signal.source);
        loading?.abort(); loading = null; mapKey = key;
        if (key) {
          const request = loading = new AbortController(); const trackSeed = next.seed;
          analysisFor(next.guildId!, next.video!, request.signal).then(map => {
            if (loading !== request || !map) return;
            signal = signalFor(trackSeed, map, shown); sourced(signal.source);
            dirty = true; wake();
          }, () => {});
        }
      }
      if (next.preset !== view?.preset) { fresh = true; if (next.preset !== 'neon') dropFeed(); }
      if (next.palette !== palette) {
        palette = next.palette;
        [next.palette.accent, next.palette.ground, ...next.palette.glow].forEach((color, i) => colors.set(rgb(hex(color)), i * 3));
      }
      const refitted = next.full !== view?.full || next.lite !== view?.lite;
      view = next; if (refitted) fit();
      dirty = true; wake();
    },
    stop() {
      loading?.abort(); loading = null;
      halt(); resized.disconnect(); intersection.disconnect(); unmodal(); document.removeEventListener('visibilitychange', wake);
      coarse.removeEventListener('change', refit); canvas.removeEventListener('webglcontextlost', contextLost);
      dropFeed(); for (const compiled of programs.values()) for (const { program } of compiled || []) gl.deleteProgram(program);
      gl.deleteBuffer(triangle);
      // The canvas goes with its component (Visualizer.tsx makes a new one per mount), so its context
      // is released now rather than whenever it is collected: opening and closing the full screen
      // repeatedly must never push the room's own context past the browser's limit.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
