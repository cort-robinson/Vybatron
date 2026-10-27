import { random } from '../random';

// What the visualizers move to. The browser never receives the audio (Discord plays it), so for now
// the motion is generated, not measured: each song gets its own tempo, band shape and sections from
// its id, laid out along the song's position. A seek, a pause or a second screen land on the same
// moment, and nothing claims to follow the music. A live source (a per-track energy map of 16 bands
// at about 30fps plus beat markers, fetched once per track and looked up by position) can replace
// it behind the same interface: signalFor is the one place that chooses.
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
}

export const signalFor = (trackId: string): Signal => ambientSignal(trackId);

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

  const out: Features = { bands: new Float32Array(BANDS).fill(STANDBY), peaks: new Float32Array(BANDS).fill(STANDBY), bass: STANDBY, mid: STANDBY, treble: STANDBY, beat: 0, beats: 0, level: STANDBY, settled: true };
  const hold = new Float32Array(BANDS);
  const summarize = () => {
    const { bands } = out; let bass = 0; let mid = 0; let treble = 0;
    for (let i = 0; i < BANDS; i++) { if (i < 4) bass += bands[i]; else if (i < 10) mid += bands[i]; else treble += bands[i]; }
    out.bass = bass / 4; out.mid = mid / 6; out.treble = treble / 6; out.level = (bass + mid + treble) / BANDS;
    return out;
  };
  return {
    source: 'ambient',
    features(ms, dt, playing) {
      compose(ms, playing);
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
    still(ms, playing) {
      compose(ms, playing);
      // The song's own shape rather than a random instant of it, with a beat just landed.
      for (let i = 0; i < BANDS; i++) { out.bands[i] = playing ? Math.max(target[i], shape[i] * energyAt(ms) * .7) : STANDBY; out.peaks[i] = Math.min(1, out.bands[i] + (playing ? .06 : 0)); }
      out.beat = playing ? .6 : 0; out.beats = count; out.settled = !playing;
      return summarize();
    },
  };
}
