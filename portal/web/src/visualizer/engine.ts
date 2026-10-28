import { compile, hex, rgb, type Program } from '../scene/shared';
import { random } from '../random';
import { coveredByModal, onModal } from '../motion';
import type { Palette } from '../art';
import { signalFor, type Features, type Signal, type Source } from './signal';
import { analysisFor } from './analysis';
import { shaders, type ShaderId } from './shaders';
import type { PresetId } from './presets';
import { frameInterval } from './frameRate';

// One visualizer on one canvas. It draws at the frame rate chosen in Settings (frameRate.ts, 30fps
// unless changed), at a fraction of the canvas's CSS pixels, with no DOM reads between frames: the
// canvas size comes from a ResizeObserver, the position from the last snapshot and the clock. It
// stops drawing altogether when it can't be seen (offscreen, a hidden tab, under another modal) and
// once a paused or idle song has eased into standby; reduced motion and a stilled sleeve get one
// composed frame. What draws is a painter: the shader presets below, in a WebGL2 context of the
// canvas's own, or MilkDrop (milkdrop.ts), whose code loads only once someone chooses it.
export type View = {
  preset: PresetId; seed: string; playing: boolean; positionMs: number; at: number; palette: Palette;
  // The song's energy map, when it has one: its server and YouTube video. lagMs: how far what is
  // heard trails the reported position; rate: how fast the song's own time runs (a speed preset).
  guildId: string | null; video: string | null; lagMs: number; rate: number;
  // animate: a loop at all; full: the full-screen takeover; lite: performance mode's lower resolution.
  animate: boolean; full: boolean; lite: boolean;
};
// next: MilkDrop's next preset (the others have none).
export type Visualizer = { update: (view: View) => void; next: () => void; stop: () => void };
export type Events = { fail: () => void; sourced: (source: Source) => void; named?: (name: string) => void };

// What a frame is drawn from: the song's moment, the seconds since the last frame, a visual clock
// and a travelled distance that advance only while the song plays, the song's position, and
// whether this is a composed still rather than a frame of the loop. beatsAt: the song's beats by any
// position (signal.ts). One object, reused.
export type Moment = { f: Features; dt: number; time: number; drive: number; ms: number; still: boolean; beatsAt: (positionMs: number) => number };
// A painter learns the drawing buffer's size and each view, and draws moments (false while it has
// nothing to show yet); while busy, it needs frames even once a paused song has settled. redraw
// asks the engine for a frame when something it waited for arrives; lose gives up on the context.
export type Painter = { resize: (width: number, height: number) => void; update: (view: View) => void; draw: (moment: Moment) => boolean; busy: () => boolean; next: () => void; stop: () => void };

// A frame may land this early and still count: display refreshes jitter by a millisecond or two.
const EARLY = 2;

export function startVisualizer(canvas: HTMLCanvasElement, milkdrop: boolean, { fail, sourced, named }: Events): Visualizer | null {
  let painter: Painter | null = null; let stopped = false;
  const lose = () => { lost = true; halt(); fail(); };
  const redraw = () => { dirty = true; wake(); };
  if (!milkdrop) { painter = shaderPainter(canvas, lose); if (!painter) { fail(); return null; } }
  else {
    void import('./milkdrop').then(({ milkdropPainter }) => {
      if (stopped) return;
      // Its mesh is chosen once, for the screen it is on: the full screen on a desktop gets the finer one.
      painter = milkdropPainter(canvas, !!view?.full && !view.lite && !coarse.matches, lose, redraw, name => named?.(name));
      if (!painter) { lose(); return; }
      if (view) painter.update(view);
      if (sized) painter.resize(canvas.width, canvas.height);
      redraw();
    }, () => { if (!stopped) lose(); });
  }

  let view: View | null = null; let signal: Signal | null = null;
  // The map being fetched for this song (its key, and how to stop asking), and the last moment drawn.
  let mapKey: string | null = null; let loading: AbortController | null = null; let shown: Features | undefined;
  let time = 0; let drive = 0; let speed = 0;
  const moment = { dt: 0, time: 0, drive: 0, ms: 0, still: false, beatsAt: ms => signal!.beatsAt(ms) } as Moment;
  const paint = (f: Features, dt: number, ms: number, still: boolean) => {
    moment.f = f; moment.dt = dt; moment.time = time; moment.drive = drive; moment.ms = ms; moment.still = still;
    if (painter!.draw(moment) && !drawn) { drawn = true; canvas.dataset.drawn = ''; }
  };

  let width = 0; let height = 0; let intersecting = true; let covered = false; let lost = false; let drawn = false; let sized = false;
  // due: when the next frame is wanted. It steps by the chosen interval rather than from each frame
  // drawn, so a rate between the display's whole divisions (45 on a 60Hz screen) alternates frames
  // and still averages out.
  let frame = 0; let last = 0; let due = 0; let dirty = true;
  const visible = () => !!view && !!painter && width > 0 && height > 0 && intersecting && !covered && !lost && !document.hidden;
  const position = () => (view!.playing ? view!.positionMs + Math.max(0, Date.now() - view!.at) * view!.rate : view!.positionMs) - view!.lagMs;
  const halt = () => { cancelAnimationFrame(frame); frame = 0; last = 0; };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(tick); };
  const tick = (now: number) => {
    frame = 0;
    if (!visible()) { last = 0; return; }
    const interval = frameInterval();
    if (last && interval && now < due - EARLY) { schedule(); return; }
    // Fallen a whole frame behind (a slow frame, a busy main thread): start the count again from now.
    due = interval && last && now - due < interval ? due + interval : now + interval;
    const dt = last ? Math.min(.1, (now - last) / 1000) : 1 / 30; last = now;
    const ms = position(); const f = shown = signal!.features(ms, dt, view!.playing);
    // The scene slows to a stop as playback pauses, and picks up again as it resumes.
    speed += ((view!.playing ? 1 : 0) - speed) * (1 - Math.exp(-dt * 2.2));
    time += dt * speed; drive += dt * speed * (.6 + 1.4 * f.bass + .8 * f.beat);
    paint(f, dt, ms, false);
    if (view!.playing || !f.settled || speed > .005 || painter!.busy()) schedule(); else last = 0;
  };
  // A composed still: the song's shape at its position, and a scene placed by that position.
  const still = () => {
    const ms = position(); const f = shown = signal!.still(ms, view!.playing);
    time = ms / 1000; drive = time * 1.1; speed = 0;
    paint(f, 1 / 30, ms, true);
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
    if (!sized || canvas.width !== w || canvas.height !== h) { sized = true; canvas.width = w; canvas.height = h; painter?.resize(w, h); dirty = true; }
  };
  const resized = new ResizeObserver(([entry]) => { width = entry.contentRect.width; height = entry.contentRect.height; fit(); dirty = true; wake(); });
  resized.observe(canvas);
  const intersection = new IntersectionObserver(entries => { intersecting = entries[entries.length - 1].isIntersecting; wake(); }); intersection.observe(canvas);
  // Its own full-screen dialog doesn't cover it; anything else modal does, and then it holds still.
  const modal = () => { covered = coveredByModal(canvas); wake(); };
  const unmodal = onModal(modal); covered = coveredByModal(canvas);
  document.addEventListener('visibilitychange', wake);
  const refit = () => { fit(); wake(); }; coarse.addEventListener('change', refit);

  return {
    update(next) {
      const key = next.guildId && next.video ? `${next.guildId}/${next.video}` : null;
      if (next.seed !== view?.seed || key !== mapKey) {
        // Each song starts on its generated motion and moves to its measured energy once that arrives.
        signal = signalFor(next.seed); sourced(signal.source);
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
      painter?.update(next);
      const refitted = next.full !== view?.full || next.lite !== view?.lite;
      view = next; if (refitted) fit();
      dirty = true; wake();
    },
    next() { painter?.next(); },
    stop() {
      stopped = true; loading?.abort(); loading = null;
      halt(); resized.disconnect(); intersection.disconnect(); unmodal(); document.removeEventListener('visibilitychange', wake);
      coarse.removeEventListener('change', refit);
      painter?.stop(); painter = null;
    },
  };
}

// The shader presets (shaders.ts), each one full-screen triangle drawn straight to the canvas.
function shaderPainter(canvas: HTMLCanvasElement, lose: () => void): Painter | null {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  if (!gl) return null;
  const triangle = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, triangle); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // Only the presets actually shown are compiled.
  const programs = new Map<ShaderId, Program | null>();
  const programFor = (preset: ShaderId) => { if (!programs.has(preset)) programs.set(preset, compile(gl, shaders[preset])); return programs.get(preset); };
  let preset: ShaderId = 'gridrunner'; let seed = 0; let track: string | null = null; let full = false;
  const colors = new Float32Array(15); let palette: Palette | null = null;
  const contextLost = (event: Event) => { event.preventDefault(); lose(); };
  canvas.addEventListener('webglcontextlost', contextLost);
  return {
    resize() {},
    update(view) {
      if (view.preset !== 'milkdrop') preset = view.preset;
      if (view.seed !== track) { track = view.seed; seed = random(view.seed)(); }
      full = view.full;
      if (view.palette !== palette) {
        palette = view.palette;
        [palette.accent, palette.ground, ...palette.glow].forEach((color, i) => colors.set(rgb(hex(color)), i * 3));
      }
    },
    draw({ f, time, drive }) {
      const compiled = programFor(preset);
      if (!compiled) { lose(); return false; }
      const { program, u } = compiled; gl.useProgram(program);
      gl.uniform2f(u.uRes, canvas.width, canvas.height); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uDrive, drive); gl.uniform1f(u.uSeed, seed); gl.uniform1f(u.uFull, full ? 1 : 0);
      gl.uniform1fv(u.uB, f.bands); gl.uniform1fv(u.uP, f.peaks); gl.uniform4f(u.uF, f.bass, f.mid, f.treble, f.level); gl.uniform2f(u.uBeat, f.beat, f.beats);
      gl.uniform3fv(u.uC, colors);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    },
    busy: () => false,
    next() {},
    stop() {
      canvas.removeEventListener('webglcontextlost', contextLost);
      for (const compiled of programs.values()) if (compiled) gl.deleteProgram(compiled.program);
      gl.deleteBuffer(triangle);
      // The canvas goes with its component (Visualizer.tsx makes a new one per mount), so its context
      // is released now rather than whenever it is collected: opening and closing the full screen
      // repeatedly must never push the room's own context past the browser's limit.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
