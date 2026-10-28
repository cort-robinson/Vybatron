import { random } from '../random';

// What the visualizers move to. The browser never receives the audio (Discord plays it, and routing
// this device's own player through Web Audio would stop it in the background on iOS), so motion
// comes from one of two sources behind the same interface. The live one is the song's energy map:
// 16 bands at 30fps plus beat markers, measured once by the bot from the song's audio and looked
// up here by playback position. Until a map arrives, or for songs without one (non-YouTube links,
// streams the bot can't analyse), the ambient one generates motion from the song's id instead: its
// own tempo, band shape and sections, laid out along the song's position. Either way a seek, a
// pause or a second screen land on the same moment. signalFor is the one place that chooses.
export const BANDS = 16;
export type Source = 'ambient' | 'live';
// One moment of the song: band levels low to high (0–1) and their held peaks, the bass/mid/treble
// split, a beat pulse (1 on a beat, decaying) and the beats so far, the overall level, and whether
// it has come to rest (paused or idle, eased all the way to standby).
export type Features = { bands: Float32Array; peaks: Float32Array; bass: number; mid: number; treble: number; beat: number; beats: number; level: number; settled: boolean };
export interface Signal {
  readonly source: Source;
  // The song at positionMs, eased from the previous call over dt seconds. The same object is
  // returned every time; nothing is allocated per frame.
  features(positionMs: number, dt: number, playing: boolean): Features;
  // That moment without easing, for a still frame.
  still(positionMs: number, playing: boolean): Features;
  // How many beats have landed by positionMs: a step that rises on each beat, from the position
  // alone, so any screen asking about any moment gets the same answer.
  beatsAt(positionMs: number): number;
}
// A song's measured energy (analysis.ts): frameCount frames of BANDS levels (0–255) at 30fps, frame
// i describing the song at i / 30 s, and the times of its bass-weighted beats in ms, ascending.
export type EnergyMap = { frameCount: number; levels: Uint8Array; beats: Float64Array };

// With a map the song's own energy; otherwise generated motion. `from` is the moment on screen when
// a map arrives, so the picture carries on from there instead of dropping to standby.
export const signalFor = (trackId: string, map?: EnergyMap | null, from?: Features): Signal => map ? liveSignal(map, from) : ambientSignal(trackId);

const STANDBY = .035;
const hash = (a: number, b: number) => { let h = Math.imul(a ^ Math.imul(b, 2654435761), 1597334677); h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

export function ambientSignal(seed: string): Signal {
  const next = random(seed);
  const beatMs = 60_000 / (84 + Math.round(next() * 46)); const offset = next() * beatMs;
  const everyBeat = next() < .55; const hats = next() < .5 ? 2 : 4; const key = Math.floor(next() * 2 ** 31);
  const shape = new Float32Array(BANDS); const f1 = new Float32Array(BANDS); const f2 = new Float32Array(BANDS); const p1 = new Float32Array(BANDS); const p2 = new Float32Array(BANDS);
  for (let i = 0; i < BANDS; i++) {
    const x = i / (BANDS - 1);
    shape[i] = .34 + .5 * (1 - x) ** .8 + .14 * Math.exp(-(((x - .42) / .16) ** 2)) + (next() - .5) * .08;
    f1[i] = .5 + next() * 1.6; f2[i] = 1.8 + next() * 3.4; p1[i] = next() * 6.3; p2[i] = next() * 6.3;
  }
  // Each 8-bar phrase has its own energy: an intro, then verses, choruses and the odd breakdown,
  // easing into the next phrase over its last beat.
  const phrase = beatMs * 32; const levels = [.72, .82, 1, .94, .56, 1, .78, .9];
  const section = (n: number) => n <= 0 ? .6 : levels[Math.floor(hash(key, n) * levels.length)];
  const energyAt = (ms: number) => { const x = ms / phrase; const n = Math.floor(x); return section(n) + (section(n + 1) - section(n)) * smooth((x - n - 31 / 32) * 32); };

  const target = new Float32Array(BANDS); let pulse = 0; let count = 0;
  const compose = (ms: number, playing: boolean) => {
    if (!playing) { target.fill(STANDBY); pulse = 0; return; }
    const s = ms / 1000; const energy = energyAt(ms);
    const at = (ms - offset) / beatMs; const n = Math.floor(at); const since = (at - n) * beatMs; const odd = ((n % 2) + 2) % 2 === 1;
    const kick = everyBeat || !odd ? Math.exp(-since / 110) : 0; const snare = odd ? Math.exp(-since / 85) : 0;
    const tick = ((at * hats) % 1 + 1) % 1; const hat = Math.exp(-tick * beatMs / hats / 35) * (.55 + .45 * hash(key, Math.floor(at * hats)));
    for (let i = 0; i < BANDS; i++) {
      const x = i / (BANDS - 1);
      const motion = .7 + .18 * Math.sin(s * f1[i] + p1[i]) + .12 * Math.sin(s * f2[i] + p2[i]);
      target[i] = Math.min(1, energy * (shape[i] * motion * .78 + kick * .55 * Math.max(0, 1 - x * 3.2) + snare * .38 * Math.exp(-(((x - .45) / .18) ** 2)) + hat * .3 * Math.max(0, (x - .6) / .4)));
    }
    // The visual beat: the kick, held a little longer than the sound so a frame catches it.
    pulse = (everyBeat || !odd ? Math.exp(-since / 190) : 0) * energy; count = Math.max(0, n);
  };

  const motion = eased();
  return {
    source: 'ambient',
    features(ms, dt, playing) { compose(ms, playing); return motion.ease(target, dt, playing, pulse, count); },
    still(ms, playing) {
      compose(ms, playing);
      // The song's own shape rather than a random instant of it, with a beat just landed.
      for (let i = 0; i < BANDS; i++) target[i] = playing ? Math.max(target[i], shape[i] * energyAt(ms) * .7) : STANDBY;
      return motion.hold(target, playing, count);
    },
    // Every beat of the grid, the ones without a kick included.
    beatsAt: ms => Math.floor((ms - offset) / beatMs),
  };
}

// The easing both sources share, so every preset moves the same way whichever drives it: levels
// rise fast and fall slower, peaks hold a moment before dropping, and a paused song eases into
// standby and reports itself settled once there.
function eased(from?: Features) {
  const out: Features = { bands: new Float32Array(BANDS).fill(STANDBY), peaks: new Float32Array(BANDS).fill(STANDBY), bass: STANDBY, mid: STANDBY, treble: STANDBY, beat: 0, beats: 0, level: STANDBY, settled: true };
  if (from) { out.bands.set(from.bands); out.peaks.set(from.peaks); out.beat = from.beat; }
  const hold = new Float32Array(BANDS);
  const summarize = () => {
    const { bands } = out; let bass = 0; let mid = 0; let treble = 0;
    for (let i = 0; i < BANDS; i++) { if (i < 4) bass += bands[i]; else if (i < 10) mid += bands[i]; else treble += bands[i]; }
    out.bass = bass / 4; out.mid = mid / 6; out.treble = treble / 6; out.level = (bass + mid + treble) / BANDS;
    return out;
  };
  return {
    ease(target: Float32Array, dt: number, playing: boolean, pulse: number, count: number) {
      const rise = 1 - Math.exp(-dt * 28); const fall = 1 - Math.exp(-dt * 7);
      let rest = !playing;
      for (let i = 0; i < BANDS; i++) {
        const value = out.bands[i] += (target[i] - out.bands[i]) * (target[i] > out.bands[i] ? rise : fall);
        if (value >= out.peaks[i]) { out.peaks[i] = value; hold[i] = .45; } else if ((hold[i] -= dt) <= 0) out.peaks[i] = Math.max(value, out.peaks[i] - dt * .6);
        if (Math.abs(value - target[i]) > .004 || out.peaks[i] - value > .004) rest = false;
      }
      out.beat = playing ? pulse : out.beat * Math.exp(-dt * 6); out.beats = count;
      out.settled = rest && out.beat < .01;
      return summarize();
    },
    // A still frame of `target`, with a beat just landed while playing.
    hold(target: Float32Array, playing: boolean, count: number) {
      for (let i = 0; i < BANDS; i++) { out.bands[i] = target[i]; out.peaks[i] = Math.min(1, target[i] + (playing ? .06 : 0)); }
      out.beat = playing ? .6 : 0; out.beats = count; out.settled = !playing;
      return summarize();
    },
  };
}

// The measured song. Positions between frames are interpolated, so the 30fps map stays smooth at
// any frame rate; past either end of the map it rests at standby. The beat pulse is the
// ambient one's shape (held a little longer than the sound so a frame catches it), from the
// song's own beats and as strong as its bass is at that moment.
export function liveSignal(map: EnergyMap, from?: Features): Signal {
  const { frameCount, levels, beats } = map;
  const target = new Float32Array(BANDS); let pulse = 0; let count = 0;
  // How many beats have landed by ms.
  const landed = (ms: number) => { let low = 0; let high = beats.length; while (low < high) { const mid = (low + high) >> 1; if (beats[mid] <= ms) low = mid + 1; else high = mid; } return low; };
  const level = (frame: number, band: number) => levels[frame * BANDS + band] / 255;
  const compose = (ms: number, playing: boolean, spread = 0) => {
    count = landed(ms);
    const at = ms * 30 / 1000; const frame = Math.floor(at);
    if (!playing || frame < 0 || frame >= frameCount) { target.fill(STANDBY); pulse = 0; return; }
    const f = at - frame; const next = Math.min(frame + 1, frameCount - 1);
    let bass = 0;
    for (let b = 0; b < BANDS; b++) {
      if (spread) {
        // A still frame: the song around this moment rather than one instant of it.
        let sum = 0; let n = 0;
        for (let i = Math.max(0, frame - spread); i <= Math.min(frameCount - 1, frame + spread); i++) { sum += level(i, b); n++; }
        target[b] = Math.max(STANDBY, sum / n);
      } else target[b] = Math.max(STANDBY, level(frame, b) * (1 - f) + level(next, b) * f);
      if (b < 4) bass += target[b] / 4;
    }
    const since = count ? ms - beats[count - 1] : Infinity;
    pulse = Math.exp(-since / 190) * (.55 + .45 * Math.min(1, bass * 1.4));
  };
  const motion = eased(from);
  return {
    source: 'live',
    features(ms, dt, playing) { compose(ms, playing); return motion.ease(target, dt, playing, pulse, count); },
    still(ms, playing) { compose(ms, playing, 8); return motion.hold(target, playing, count); },
    beatsAt: landed,
  };
}
