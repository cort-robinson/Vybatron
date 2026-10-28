import butterchurn from 'butterchurn';
import { random } from '../random';
import { waveform } from './waveform';
import { MILKDROP } from './milkdrop-presets';
import type { Painter } from './engine';

// MilkDrop, by way of Butterchurn (ADR-0015), in the engine's loop like the other presets.
// - No AudioContext. Butterchurn uses one only to build its analyser nodes and to read the sample
//   rate; given none it builds no nodes and assumes 44.1 kHz. The page never makes one: on iOS an
//   AudioContext joins the page to the audio session, which can cut this device's player off in the
//   background. Each frame's samples are written from the song's moment instead (waveform.ts).
// - Equations as WebAssembly only. Each preset's equations compile to WebAssembly, which the CSP
//   allows ('wasm-unsafe-eval'). Butterchurn's JavaScript fallback would need new Function, which
//   the CSP refuses; onlyUseWASM turns it off, and the converted presets carry only the original
//   equations, none of the JavaScript it would run.
// - Butterchurn draws in a WebGL2 context of its own, on an OffscreenCanvas, and copies each frame
//   to this canvas's 2D context.
// Presets take turns in an order shuffled for each song. A turn starts at each DWELL_MS of the
// song's position, on the first beat at or after it (or LATE_MS after it without one), so which
// preset shows depends only on the song, its position and its beats: the sleeve, the full screen,
// a screen opened later or after a seek and every other device all agree. A playing song blends
// into the next over BLEND seconds. Next skips ahead in every MilkDrop on the page at once.
const DWELL_MS = 24_000; const LATE_MS = 4000; const BLEND = 2.7; const SKIP_BLEND = 1.2;
// A preset that starts cold for a frame that will stay on screen (a still, or a paused song's, whose
// loop stops once it settles) cuts in rather than blending, run this many frames first so its
// feedback has built. A playing one builds as it fades in.
const WARM = 24;
let skips = 0;
const turn = (ms: number, beatsAt: (ms: number) => number) => {
  const k = Math.floor(ms / DWELL_MS); const boundary = k * DWELL_MS;
  return k <= 0 ? 0 : ms >= boundary + LATE_MS || beatsAt(ms) > beatsAt(boundary - 1) ? k : k - 1;
};

// dense: the finer mesh of points whose equations run on the CPU every frame. It stays as created:
// Butterchurn resizes only the current preset's mesh, so changing it mid-blend would leave the
// outgoing preset's coordinates the wrong size.
export function milkdropPainter(canvas: HTMLCanvasElement, dense: boolean, lose: () => void, redraw: () => void, named: (name: string) => void): Painter | null {
  let visualizer: ReturnType<typeof butterchurn.createVisualizer>;
  // Without WebGL2 Butterchurn fails as it starts.
  try { visualizer = butterchurn.createVisualizer(null, canvas, { width: canvas.width, height: canvas.height, pixelRatio: 1, textureRatio: 1, meshWidth: dense ? 48 : 32, meshHeight: dense ? 36 : 24, onlyUseWASM: true }); } catch { return null; }
  const context = visualizer.gl.canvas;
  const contextLost = (event: Event) => { event.preventDefault(); lose(); };
  context.addEventListener('webglcontextlost', contextLost);
  const wave = waveform(); const frame = { audioLevels: wave, elapsedTime: 0 };
  // broken: presets whose equations failed to compile or trapped at run time, skipped from then on.
  const broken = new Uint8Array(MILKDROP.length);
  let order = new Uint8Array(0); let track: string | null = null; let playing = false; let stopped = false;
  let shown = -1; let loading = -1; let fresh = false; let seen = skips;
  // The preset whose turn it is at ms: its place in the order, past any broken preset.
  const choose = (ms: number, beatsAt: (ms: number) => number) => {
    const n = order.length; let at = turn(ms, beatsAt) + skips;
    for (let k = 0; k < n; k++, at++) { const index = order[(at % n + n) % n]; if (!broken[index]) return index; }
    return -1;
  };
  const load = (index: number, blend: number) => {
    loading = index; seen = skips;
    visualizer.loadPreset(MILKDROP[index].preset, blend).then(() => {
      if (stopped) return;
      shown = index; fresh = !blend; named(MILKDROP[index].name);
    }, () => { broken[index] = 1; }).finally(() => { loading = -1; if (!stopped) redraw(); });
  };
  return {
    resize(width, height) { visualizer.setRendererSize(width, height); },
    update(view) {
      playing = view.playing;
      if (view.seed === track) return;
      track = view.seed; const next = random(`milkdrop:${view.seed}`);
      order = Uint8Array.from(MILKDROP.keys());
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); const swap = order[i]; order[i] = order[j]; order[j] = swap; }
    },
    draw({ f, dt, ms, still, beatsAt }) {
      const want = choose(ms, beatsAt);
      // Nothing left that runs (WebAssembly refused, say): the visualizer gives way to its fallback.
      if (want < 0) { lose(); return false; }
      if (want === shown) seen = skips;
      else if (loading < 0) load(want, shown < 0 || still || !playing ? 0 : seen !== skips ? SKIP_BLEND : BLEND);
      if (shown < 0) return false;
      wave.write(f, dt); frame.elapsedTime = dt;
      try { for (let i = fresh && (still || !playing) ? WARM : 1; i > 0; i--) visualizer.render(frame); }
      catch { broken[shown] = 1; shown = -1; redraw(); }
      fresh = false;
      return true;
    },
    // A preset still compiling or a blend under way keeps the loop drawing after the song pauses, so
    // the change is seen through rather than frozen part way. The blend's end is Butterchurn's own:
    // its clock runs on its estimate of the frame rate, which a timer here would drift from.
    busy: () => loading >= 0 || visualizer.renderer.blending,
    next() { skips++; redraw(); },
    stop() {
      stopped = true; context.removeEventListener('webglcontextlost', contextLost);
      // Released now rather than whenever it is collected (see the shader painter's stop).
      visualizer.loseGLContext();
    },
  };
}
