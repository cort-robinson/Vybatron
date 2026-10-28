import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { fail, PortalError } from './errors.js';
import { validVideoId } from './audio.js';

// What the portal's visualizers move to: a per-song energy map, measured once
// from the same Ogg Opus the portal plays on a listener's own device and then
// looked up by playback position in the browser (which never receives the
// Discord audio). 16 log-spaced bands at 30 frames a second, normalized per
// song to 0–255, plus onsets and bass-weighted beats. Only the vybatron-audio
// plugin's Ogg Opus is analysed; the YouTube plugin's mp4/webm fallbacks are
// "unavailable" and the visualizer stays on its generated motion.
export const ANALYSIS_VERSION = 1;
// One analysis at a time: each takes about 1.5 s of CPU and 45 MB at its peak
// (its worker thread included) for a four-minute song, inside the bot's 256 MB.
// Results are about 200 KB each as served, so 24 of them stay under 5 MB.
export const ANALYSIS_LIMITS = Object.freeze({ analyses: 1, results: 24, waitMs: 5000, maxFrames: 20 * 60 * 30, unavailableMs: 10 * 60_000 });
const RATE = 48_000; const FPS = 30; const HOP = RATE / FPS; const SIZE = 2048; const HALF = SIZE / 2;
export const BANDS = 16; const LOW_HZ = 40; const HIGH_HZ = 16_000;
export const BAND_EDGES = Object.freeze(Array.from({ length: BANDS + 1 }, (_, i) => Math.round(LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS))));
// Bins below this carry the kick and the bass line, which the beat flag listens to.
const BASS_HZ = 180;
// Packets decoded between yields: half a second of audio, a few milliseconds of work.
const SLICE_PACKETS = 25;

// The packets of the first logical stream of an Ogg file (RFC 3533), in order.
// Packets may span pages; the plugin's writer never does that, but ffmpeg's can.
export function oggPackets(data) {
  const packets = []; let serial = null; let partial = null; let offset = 0;
  while (offset + 27 <= data.length) {
    if (data.readUInt32BE(offset) !== 0x4f676753) fail(422, 'invalid_audio', 'This song isn’t Ogg audio.');
    const segments = data[offset + 26]; const bodyStart = offset + 27 + segments;
    if (data[offset + 4] !== 0 || bodyStart > data.length) fail(422, 'invalid_audio', 'This song’s audio is incomplete.');
    let size = 0; for (let i = 0; i < segments; i++) size += data[offset + 27 + i];
    if (bodyStart + size > data.length) fail(422, 'invalid_audio', 'This song’s audio is incomplete.');
    const pageSerial = data.readUInt32LE(offset + 14);
    serial ??= pageSerial;
    if (pageSerial === serial) {
      // A page that doesn't continue a packet drops any unfinished one before it.
      if (!(data[offset + 5] & 1)) partial = null;
      let at = bodyStart; let start = at;
      for (let i = 0; i < segments; i++) {
        const lace = data[offset + 27 + i]; at += lace;
        if (lace < 255) {
          const piece = data.subarray(start, at);
          packets.push(partial ? Buffer.concat([...partial, piece]) : piece); partial = null; start = at;
        }
      }
      if (start < at) (partial ||= []).push(data.subarray(start, at));
    }
    offset = bodyStart + size;
  }
  return packets;
}

// RFC 7845 identification header: channel count and pre-skip. Only mapping
// family 0 (mono or stereo) is ever produced for Discord.
export function opusHead(packet) {
  if (!packet || packet.length < 19 || packet.toString('latin1', 0, 8) !== 'OpusHead' || packet[18] !== 0 || ![1, 2].includes(packet[9])) fail(422, 'invalid_audio', 'This song’s audio format isn’t supported.');
  return { channels: packet[9], preSkip: packet.readUInt16LE(10) };
}

// An in-place radix-2 FFT of SIZE real samples, as HALF complex points.
function realFft() {
  const bits = Math.log2(HALF); const reverse = new Uint16Array(HALF);
  for (let i = 0; i < HALF; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); reverse[i] = r; }
  const cosH = new Float64Array(HALF / 2); const sinH = new Float64Array(HALF / 2);
  for (let i = 0; i < HALF / 2; i++) { cosH[i] = Math.cos(2 * Math.PI * i / HALF); sinH[i] = Math.sin(2 * Math.PI * i / HALF); }
  const cosN = new Float64Array(HALF + 1); const sinN = new Float64Array(HALF + 1);
  for (let k = 0; k <= HALF; k++) { cosN[k] = Math.cos(2 * Math.PI * k / SIZE); sinN[k] = Math.sin(2 * Math.PI * k / SIZE); }
  const re = new Float64Array(HALF); const im = new Float64Array(HALF);
  // input: SIZE windowed samples; power: HALF + 1 bins of |X[k]|².
  return (input, power) => {
    for (let i = 0; i < HALF; i++) { const j = reverse[i]; re[j] = input[2 * i]; im[j] = input[2 * i + 1]; }
    for (let size = 2; size <= HALF; size <<= 1) {
      const half = size >> 1; const step = HALF / size;
      for (let start = 0; start < HALF; start += size) {
        for (let j = 0; j < half; j++) {
          const c = cosH[j * step]; const s = sinH[j * step]; const a = start + j; const b = a + half;
          const tr = re[b] * c + im[b] * s; const ti = im[b] * c - re[b] * s;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    // Split the packed transform into the real signal's spectrum.
    for (let k = 0; k <= HALF; k++) {
      const m = (HALF - k) % HALF; const n = k % HALF;
      const ar = re[n]; const ai = im[n]; const br = re[m]; const bi = -im[m];
      const er = (ar + br) / 2; const ei = (ai + bi) / 2; const or = (ai - bi) / 2; const oi = -(ar - br) / 2;
      const xr = er + cosN[k] * or + sinN[k] * oi; const xi = ei + cosN[k] * oi - sinN[k] * or;
      power[k] = xr * xr + xi * xi;
    }
  };
}

// Frame i is a Hann window centred on sample i * HOP, so it describes the
// song at i / 30 seconds. Mono samples are pushed as they're decoded.
export function createAnalyser({ expectedFrames = 0, maxFrames = ANALYSIS_LIMITS.maxFrames } = {}) {
  const fft = realFft(); const window = new Float64Array(SIZE); const frame = new Float64Array(SIZE); const power = new Float64Array(HALF + 1);
  for (let i = 0; i < SIZE; i++) window[i] = .5 - .5 * Math.cos(2 * Math.PI * i / SIZE);
  const bandOf = new Int8Array(HALF + 1).fill(-1);
  for (let k = 1; k <= HALF; k++) { const hz = k * RATE / SIZE; for (let b = 0; b < BANDS; b++) if (hz >= BAND_EDGES[b] && hz < BAND_EDGES[b + 1]) bandOf[k] = b; }
  const bassBins = Math.floor(BASS_HZ * SIZE / RATE); const topBin = Math.ceil(HIGH_HZ * SIZE / RATE);
  let capacity = Math.max(64, Math.min(maxFrames, expectedFrames + 2));
  let db = new Float32Array(capacity * BANDS); let flux = new Float32Array(capacity); let bassFlux = new Float32Array(capacity);
  const previous = new Float64Array(topBin + 1); const logs = new Float64Array(topBin + 1); const energy = new Float64Array(BANDS);
  // buffer[0] is sample `base`; the window of frame `next` starts at sample next * HOP - HALF.
  const buffer = new Float32Array(RATE * 2 + SIZE); let base = 0; let filled = 0; let next = 0; let total = 0;
  const grow = () => {
    capacity = Math.min(maxFrames, capacity * 2);
    const grown = (array, width) => { const copy = new Float32Array(capacity * width); copy.set(array); return copy; };
    db = grown(db, BANDS); flux = grown(flux, 1); bassFlux = grown(bassFlux, 1);
  };
  const analyse = () => {
    if (next >= capacity) { if (capacity >= maxFrames) fail(413, 'analysis_too_long', 'This song is too long to analyse.'); grow(); }
    const start = next * HOP - HALF - base;
    for (let i = 0; i < SIZE; i++) { const at = start + i; frame[i] = at >= 0 && at < filled ? buffer[at] * window[i] : 0; }
    fft(frame, power);
    const row = next * BANDS; energy.fill(0);
    for (let k = 1; k <= HALF; k++) if (bandOf[k] >= 0) energy[bandOf[k]] += power[k];
    for (let b = 0; b < BANDS; b++) db[row + b] = 10 * Math.log10(energy[b] + 1e-10);
    // Spectral flux on log-compressed magnitudes: how much louder each bin got.
    let rise = 0; let bassRise = 0;
    for (let k = 1; k <= topBin; k++) {
      logs[k] = Math.log1p(100 * Math.sqrt(power[k]));
      const up = logs[k] - previous[k];
      if (up > 0) { rise += up; if (k <= bassBins) bassRise += up; }
      previous[k] = logs[k];
    }
    flux[next] = next ? rise : 0; bassFlux[next] = next ? bassRise : 0;
    next++;
  };
  const drain = final => {
    while (next * HOP + HALF <= base + filled || (final && next * HOP < total)) analyse();
    // Keep only what the next window still needs.
    const keep = next * HOP - HALF - base;
    if (keep > 0) { buffer.copyWithin(0, keep, filled); filled -= keep; base += keep; }
  };
  return {
    push(samples) {
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(samples.length - offset, buffer.length - filled);
        buffer.set(samples.subarray(offset, offset + count), filled); filled += count; offset += count; total += count;
        drain(false);
      }
    },
    finish() { drain(true); return summarize(db.subarray(0, next * BANDS), flux.subarray(0, next), bassFlux.subarray(0, next), next); },
  };
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort(); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};

// Peaks of an onset envelope above a local mean, at least `gap` frames apart,
// with sub-frame times from a parabola through each peak.
function peaks(envelope, { delta, gap }) {
  const found = []; let last = -Infinity;
  for (let i = 1; i < envelope.length - 1; i++) {
    const value = envelope[i]; let max = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(envelope.length - 1, i + 3); j++) if (envelope[j] > value || (envelope[j] === value && j < i)) { max = false; break; }
    if (!max) continue;
    let sum = 0; let count = 0;
    for (let j = Math.max(0, i - 10); j <= Math.min(envelope.length - 1, i + 3); j++) { sum += envelope[j]; count++; }
    if (value < sum / count + delta || i - last < gap) continue;
    const a = envelope[i - 1]; const c = envelope[i + 1]; const bend = a - 2 * value + c;
    found.push(Math.round((i + (bend < 0 ? .5 * (a - c) / bend : 0)) * 1000 / FPS)); last = i;
  }
  return found;
}

// The beat period that best explains the bass-weighted envelope's repetition,
// as beats per minute between 60 and 200 (preferring about 120), or null.
function tempo(envelope) {
  const n = envelope.length; const maxLag = 4 * 31; if (n < maxLag * 2) return null;
  let mean = 0; for (const value of envelope) mean += value; mean /= n;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag + 1; lag++) { let sum = 0; for (let i = lag; i < n; i++) sum += (envelope[i] - mean) * (envelope[i - lag] - mean); ac[lag] = sum; }
  if (ac[0] <= 0) return null;
  const at = lag => { const i = Math.floor(lag); const f = lag - i; return ac[i] * (1 - f) + ac[i + 1] * f; };
  let best = 0; let bestLag = 0;
  for (let lag = FPS * 60 / 200; lag <= FPS * 60 / 60; lag += .01) {
    let score = 0; for (let k = 1; k <= 4; k++) score += at(k * lag) / k;
    score *= Math.exp(-.5 * (Math.log2(FPS * 60 / lag / 120) / 1.2) ** 2);
    if (score > best) { best = score; bestLag = lag; }
  }
  return bestLag && best / ac[0] > .05 ? Math.round(FPS * 600 / bestLag) / 10 : null;
}

function summarize(db, flux, bassFlux, frames) {
  // Levels: decibels, with half of each band's typical tilt removed so treble
  // still moves beside the bass, mapped from about the song's quiet floor to
  // its loudest moments. A quiet song gets the same range as a loud one, and
  // only the loudest 0.5% of moments clip.
  const audible = []; let loudest = -Infinity;
  for (const value of db) if (value > loudest) loudest = value;
  const floor = loudest - 80;
  const medians = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) {
    const column = []; for (let i = 0; i < frames; i++) if (db[i * BANDS + b] > floor) column.push(db[i * BANDS + b]);
    medians[b] = column.length ? percentile(column, .5) : floor;
  }
  const overall = percentile(medians, .5);
  const tilt = medians.map(median => .5 * (median - overall));
  for (let i = 0; i < frames; i++) for (let b = 0; b < BANDS; b++) { const value = db[i * BANDS + b]; if (value > floor) audible.push(value - tilt[b]); }
  const high = percentile(audible, .995); const low = Math.min(high - 18, Math.max(high - 48, percentile(audible, .1) - 3));
  const levels = new Uint8Array(frames * BANDS);
  for (let i = 0; i < frames; i++) for (let b = 0; b < BANDS; b++) {
    const x = (db[i * BANDS + b] - tilt[b] - low) / (high - low);
    levels[i * BANDS + b] = Math.round(255 * Math.min(1, Math.max(0, x)) ** 1.15);
  }
  // Onsets from the whole spectrum; beats from an envelope weighted to the bass.
  const scale = values => { const top = percentile([...values].filter(value => value > 0), .99) || 1; return Float32Array.from(values, value => Math.min(1.5, value / top)); };
  const full = scale(flux); const bass = scale(bassFlux);
  const weighted = Float32Array.from(bass, (value, i) => .75 * value + .25 * full[i]);
  return { frames, levels, onsets: peaks(full, { delta: .1, gap: 3 }), beats: peaks(weighted, { delta: .18, gap: 6 }), tempo: tempo(weighted) };
}

let decoderModule;
const loadDecoder = () => decoderModule ||= import('opus-decoder').then(module => module.OpusDecoder);

// Decodes one packet into a reused buffer and returns its samples, downmixed to mono.
// opus-decoder 0.7.12 (pinned) copies every frame out of its WebAssembly heap
// twice, which for a song is about 180 MB of short-lived arrays. Its own
// decode call is used here instead and the samples read where it leaves them,
// deinterleaved in its output buffer. Another version falls back to decodeFrame.
export function packetDecoder(decoder, channels) {
  const mono = new Float32Array(120 * 48);
  const fast = typeof decoder._common?.wasm?.opus_frame_decode_float_deinterleaved === 'function' && decoder._input?.buf instanceof Uint8Array && decoder._output?.buf instanceof Float32Array;
  return {
    fast,
    decode(packet) {
      if (!fast) {
        const { channelData: [left, right], samplesDecoded } = decoder.decodeFrame(packet);
        for (let i = 0; i < samplesDecoded; i++) mono[i] = right ? (left[i] + right[i]) / 2 : left[i];
        return mono.subarray(0, samplesDecoded);
      }
      if (packet.length > decoder._input.buf.length) return mono.subarray(0, 0);
      decoder._input.buf.set(packet);
      const count = Math.max(0, decoder._common.wasm.opus_frame_decode_float_deinterleaved(decoder._decoder, decoder._input.ptr, packet.length, decoder._output.ptr));
      const out = decoder._output.buf;
      if (channels === 2) for (let i = 0; i < count; i++) mono[i] = (out[i] + out[count + i]) / 2; else mono.set(out.subarray(0, count));
      return mono.subarray(0, count);
    },
  };
}

// Decodes one Ogg Opus song and measures it, yielding to the event loop every
// half second of audio so other work on the thread never waits long behind it.
export async function analyseOgg(data, { maxFrames = ANALYSIS_LIMITS.maxFrames, signal } = {}) {
  const packets = oggPackets(data);
  const { channels, preSkip } = opusHead(packets[0]);
  // The last page's granule position is the song's length in 48 kHz samples.
  const last = data.lastIndexOf('OggS');
  const granule = last >= 0 && last + 14 <= data.length ? Number(data.readBigUInt64LE(last + 6)) : 0;
  const expectedFrames = Math.ceil(Math.max(0, granule - preSkip) / HOP);
  if (expectedFrames > maxFrames) fail(413, 'analysis_too_long', 'This song is too long to analyse.');
  const OpusDecoder = await loadDecoder();
  const decoder = new OpusDecoder({ channels, preSkip, streamCount: 1, coupledStreamCount: channels - 1, channelMappingTable: channels === 2 ? [0, 1] : [0] });
  await decoder.ready;
  const analyser = createAnalyser({ expectedFrames, maxFrames }); const packet = packetDecoder(decoder, channels);
  try {
    for (let at = 2; at < packets.length; at++) {
      analyser.push(packet.decode(packets[at]));
      if ((at - 1) % SLICE_PACKETS === 0) {
        await yieldToLoop();
        if (signal?.aborted) fail(503, 'analysis_cancelled', 'The analysis was cancelled.');
      }
    }
  } finally { decoder.free(); }
  const result = analyser.finish();
  if (!result.frames) fail(422, 'invalid_audio', 'This song has no audio.');
  return result;
}

// The same analysis in a worker thread of its own, ended when it finishes (or
// when `signal` aborts). Decoding takes about a second and a half of CPU for a
// four-minute song; here none of it runs on the bot's event loop, and the
// decoder's WebAssembly memory (about 30 MB reserved per decoder, released by
// the library only at garbage collection) goes with the worker.
export function analyseInWorker(data, { maxFrames = ANALYSIS_LIMITS.maxFrames, signal } = {}) {
  return new Promise((resolve, reject) => {
    // One copy of the song, handed over rather than cloned again.
    const copy = new Uint8Array(data.length); copy.set(data);
    const worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { workerData: { data: copy, maxFrames }, transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 4 }, execArgv: [], stdout: true, stderr: true });
    // The decoder logs each corrupt packet; a damaged song mustn't fill the bot's log.
    worker.stdout.resume(); worker.stderr.resume();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      signal?.removeEventListener('abort', abort); void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new PortalError(503, 'analysis_cancelled', 'The analysis was cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('message', message => message.error ? finish(new PortalError(message.error.status, message.error.code, message.error.message)) : finish(null, message.result));
    worker.once('error', () => finish(new PortalError(503, 'analysis_failed', 'The song could not be analysed.')));
    worker.once('exit', () => finish(new PortalError(503, 'analysis_failed', 'The song could not be analysed.')));
  });
}

// The bridge's answer: compact JSON, the levels as base64 (frame-major, BANDS bytes a frame).
export const analysisProjection = result => ({ version: ANALYSIS_VERSION, status: 'ready', frameRate: FPS, frameCount: result.frames, bandCount: BANDS, bandHz: BAND_EDGES,
  durationMs: Math.round(result.frames * 1000 / FPS), tempo: result.tempo, levels: Buffer.from(result.levels.buffer, result.levels.byteOffset, result.levels.byteLength).toString('base64'),
  onsets: result.onsets, beats: result.beats });

// Analyses fetched through the device-playback audio cache (one download path),
// at most `analyses` at once, with results in a small LRU. A request waits up
// to waitMs and otherwise answers "pending" so the portal asks again shortly.
export function createAnalysisCache(audio, { limits = ANALYSIS_LIMITS, analyse = analyseInWorker, now = Date.now } = {}) {
  const results = new Map(); const running = new Map(); const closing = new AbortController();
  const remember = (id, value) => {
    results.delete(id); results.set(id, value);
    while (results.size > limits.results) results.delete(results.keys().next().value);
  };
  const unavailable = () => fail(404, 'analysis_unavailable', 'This song can’t be analysed.');
  const start = id => {
    if (running.size >= limits.analyses) fail(429, 'busy', 'Songs are still being analysed. Try again in a moment.');
    const task = (async () => {
      let entry;
      try { entry = await audio.get(id, { background: true }); await entry.done; }
      catch (error) { if ([404, 413].includes(error?.status)) return { unavailable: true }; throw error; }
      if (entry.type !== 'audio/ogg') return { unavailable: true };
      try { return { body: analysisProjection(await analyse(entry.data, { maxFrames: limits.maxFrames, signal: closing.signal })) }; }
      catch (error) { if ([413, 422].includes(error?.status)) return { unavailable: true }; throw error; }
    })().then(value => {
      if (!closing.signal.aborted) remember(id, value.unavailable ? { unavailable: true, until: now() + limits.unavailableMs } : value);
      return value;
    }).finally(() => running.delete(id));
    // Nobody may be waiting by the time it fails; the next request starts again.
    void task.catch(() => {});
    running.set(id, task);
    return task;
  };
  return {
    async get(id) {
      if (!validVideoId(id)) fail(400, 'invalid_audio', 'Choose a supported song.');
      const known = results.get(id);
      if (known && !(known.unavailable && known.until <= now())) { remember(id, known); if (known.unavailable) unavailable(); return known.body; }
      if (known) results.delete(id);
      const task = running.get(id) || start(id);
      let timer;
      const waited = await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, limits.waitMs, null); })]).finally(() => clearTimeout(timer));
      if (!waited) return { version: ANALYSIS_VERSION, status: 'pending', retryMs: 2000 };
      if (waited.unavailable) unavailable();
      return waited.body;
    },
    clear() { closing.abort(); results.clear(); },
    get size() { return results.size; },
    get active() { return running.size; },
  };
}
