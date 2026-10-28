import butterchurn from 'butterchurn';
import { random } from '../random';
import { waveform } from './waveform';
import { MILKDROP } from './milkdrop-presets';
import type { Painter } from './engine';

// MilkDrop, by way of Butterchurn (ADR-0014), in the engine's loop like the other presets.
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
// Presets take turns in an order shuffled for each song, one per DWELL_MS of its position, so the
// sleeve, the full screen and every other screen show the same one at the same moment. A turn
// changes on the next beat once it is due and HOLD seconds have passed since the last change (or
// LATE seconds after that without a beat), blending over BLEND seconds. Next skips ahead in every MilkDrop on
// the page at once.
const DWELL_MS = 24_000; const HOLD = 8; const LATE = 4; const BLEND = 2.7; const SKIP_BLEND = 1.2;
// A preset that starts cold (without a blend) for a frame that will stay on screen, a still or a
// paused song's, is run this many frames first, so its feedback has built before it shows. A
// playing one builds as it fades in.
const WARM = 24;
let skips = 0;

export function milkdropPainter(canvas: HTMLCanvasElement, lose: () => void, redraw: () => void, named: (name: string) => void): Painter | null {
  let visualizer: ReturnType<typeof butterchurn.createVisualizer>;
  // Without WebGL2 Butterchurn fails as it starts.
  try { visualizer = butterchurn.createVisualizer(null, canvas, { width: canvas.width, height: canvas.height, pixelRatio: 1, textureRatio: 1, meshWidth: 32, meshHeight: 24, onlyUseWASM: true }); } catch { return null; }
  const context = visualizer.gl.canvas;
  const contextLost = (event: Event) => { event.preventDefault(); lose(); };
  context.addEventListener('webglcontextlost', contextLost);
  const wave = waveform(); const frame = { audioLevels: wave, elapsedTime: 0 };
  // broken: presets whose equations failed to compile or trapped at run time, skipped from then on.
  const broken = new Uint8Array(MILKDROP.length);
  let order = new Uint8Array(0); let track: string | null = null; let playing = false; let stopped = false;
  let shown = -1; let loading = -1; let fresh = false; let held = 0; let late = 0; let beats = -1; let seen = skips;
  // The turn at ms: its place in the order, past any broken preset.
  const choose = (ms: number) => {
    const n = order.length; let at = Math.floor(ms / DWELL_MS) + skips;
    for (let k = 0; k < n; k++, at++) { const index = order[(at % n + n) % n]; if (!broken[index]) return index; }
    return -1;
  };
  const load = (index: number, blend: number) => {
    loading = index; held = 0; late = 0; seen = skips;
    visualizer.loadPreset(MILKDROP[index].preset, blend).then(() => {
      if (stopped) return;
      shown = index; fresh = !blend; named(MILKDROP[index].name);
    }, () => { broken[index] = 1; }).finally(() => { loading = -1; if (!stopped) redraw(); });
  };
  return {
    resize(width, height) {
      // A small buffer needs fewer of the mesh points whose equations run on the CPU every frame.
      const small = width * height < 200_000;
      visualizer.setRendererSize(width, height, { meshWidth: small ? 32 : 48, meshHeight: small ? 24 : 36 });
    },
    update(view) {
      playing = view.playing;
      if (view.seed === track) return;
      track = view.seed; const next = random(`milkdrop:${view.seed}`);
      order = Uint8Array.from(MILKDROP.keys());
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); const swap = order[i]; order[i] = order[j]; order[j] = swap; }
    },
    draw({ f, dt, ms, still }) {
      const want = choose(ms); const beat = f.beats !== beats; beats = f.beats;
      if (!still) { held += dt; late = want !== shown && held >= HOLD ? late + dt : 0; }
      // Nothing left that runs (WebAssembly refused, say): the visualizer gives way to its fallback.
      if (want < 0) { lose(); return false; }
      if (want === shown) seen = skips;
      else if (loading < 0 && (shown < 0 || still || seen !== skips || held >= HOLD && (beat || late >= LATE))) load(want, shown < 0 || still ? 0 : seen !== skips ? SKIP_BLEND : BLEND);
      if (shown < 0) return false;
      wave.write(f, dt); frame.elapsedTime = dt;
      try { for (let i = fresh && (still || !playing) ? WARM : 1; i > 0; i--) visualizer.render(frame); }
      catch { broken[shown] = 1; shown = -1; redraw(); }
      fresh = false;
      return true;
    },
    next() { skips++; redraw(); },
    stop() {
      stopped = true; context.removeEventListener('webglcontextlost', contextLost);
      // Released now rather than whenever it is collected (see the shader painter's stop).
      visualizer.loseGLContext();
    },
  };
}
