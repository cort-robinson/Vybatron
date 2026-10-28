import { BANDS, type Features } from './signal';

// MilkDrop listens to audio: every frame Butterchurn takes the last 1024 samples of each channel
// (bytes, 128 silent) and finds the bass, mid and treble its presets move to with its own FFT,
// assuming 44.1 kHz. The page has no audio (signal.ts), so this writes those samples from the
// song's moment instead. Each band is a pair of tones inside it, as loud as its level: the bot
// measures levels in decibels over about 30 dB (src/portal/analysis.js), so a level becomes an
// amplitude on that scale, which keeps a kick's jump over the moments around it as sharp as it sounds.
// The beat pulse lifts the bass on top. Butterchurn judges each range against its own few seconds
// of history, so only these contrasts matter, not the overall gain. The tones keep their phase
// from frame to frame and drift slowly (the treble a little faster), so a preset's waveform is a
// living shape rather than noise. Nothing is allocated per frame.
export const SAMPLES = 1024;
const RATE = 44_100; const TONES = BANDS * 2;
// A tone's amplitude at a full band, in steps of the 127 a byte holds either side of silence: a
// loud song swings most of the way, as mastered music does, and an ambient one about half.
const GAIN = 48;

export type Waveform = { timeByteArray: Uint8Array; timeByteArrayL: Uint8Array; timeByteArrayR: Uint8Array; write: (f: Features, dt: number) => void };
export function waveform(): Waveform {
  const step = new Float64Array(TONES * 2); const stereo = new Float64Array(TONES * 2); const drift = new Float64Array(TONES); const phase = new Float64Array(TONES);
  const weight = new Float32Array(BANDS);
  for (let t = 0; t < TONES; t++) {
    const band = t >> 1; const x = band / (BANDS - 1);
    // A third and two thirds of the way across the band, on the bands' log scale (40 Hz to 16 kHz).
    const w = 2 * Math.PI * 40 * 400 ** ((band + (t & 1 ? .67 : .33)) / BANDS) / RATE;
    step[t * 2] = Math.cos(w); step[t * 2 + 1] = Math.sin(w);
    // The right channel a little ahead of the left, more so up high, as a stereo mix spreads.
    const lead = .2 + 1.2 * x + .3 * (t & 1); stereo[t * 2] = Math.cos(lead); stereo[t * 2 + 1] = Math.sin(lead);
    drift[t] = 2 * Math.PI * (.15 + 2.4 * x * x) * (t & 1 ? -1.3 : 1); phase[t] = t * 2.39996;
  }
  // Like music, the bass carries most of the waveform's swing.
  for (let b = 0; b < BANDS; b++) weight[b] = .35 + .65 * (1 - b / (BANDS - 1)) ** 2;
  const left = new Float32Array(SAMPLES); const right = new Float32Array(SAMPLES);
  const out: Waveform = { timeByteArray: new Uint8Array(SAMPLES), timeByteArrayL: new Uint8Array(SAMPLES), timeByteArrayR: new Uint8Array(SAMPLES), write };
  function write(f: Features, dt: number) {
    left.fill(0); right.fill(0);
    for (let t = 0; t < TONES; t++) {
      const band = t >> 1;
      const amplitude = GAIN * weight[band] * 10 ** (1.5 * (f.bands[band] - 1)) * (band < 4 ? 1 + .8 * f.beat : 1);
      phase[t] = (phase[t] + dt * drift[t]) % (2 * Math.PI);
      // The tone sample by sample by rotation, rather than a sine for each.
      let s = Math.sin(phase[t]); let c = Math.cos(phase[t]);
      const wc = step[t * 2]; const ws = step[t * 2 + 1]; const lc = stereo[t * 2]; const ls = stereo[t * 2 + 1];
      for (let n = 0; n < SAMPLES; n++) {
        left[n] += amplitude * s; right[n] += amplitude * (s * lc + c * ls);
        const next = s * wc + c * ws; c = c * wc - s * ws; s = next;
      }
    }
    // Loud moments round off rather than wrap around a byte.
    const { timeByteArray: mono, timeByteArrayL: l, timeByteArrayR: r } = out;
    for (let n = 0; n < SAMPLES; n++) {
      const a = 127 * Math.tanh(left[n] / 127); const b = 127 * Math.tanh(right[n] / 127);
      l[n] = 128 + Math.round(a); r[n] = 128 + Math.round(b); mono[n] = 128 + Math.round((a + b) / 2);
    }
  }
  return out;
}
