// Audio fingerprints for ADR-0017: does a candidate upload carry the same
// performance as a song's first source? Pure: no I/O, clock or decoding.
//
// A fingerprint is the visualizer's energy map (ADR-0013, 16 bands at 30 frames
// a second, 0-255) averaged to 4 bands at 2 frames a second, one byte each,
// over the first 256 seconds: at most 2 KB. Two fingerprints match when their
// levels correlate at FINGERPRINT.threshold or above at their best alignment
// within 2 seconds, which allows for leading silence.
//
// Calibrated on 2026-10-28 (ADR-0017, tests/fixtures/fingerprints.json):
// uploads of one recording scored 0.911 and up; a live version, a demo, a
// re-recorded clean edit and unrelated songs 0.684 and below. Masters that
// differ only in mastering or a few words (remasters, re-recordings, clean
// edits) score like the same recording; titles keep them apart, not this.
export const FINGERPRINT = Object.freeze({ bands: 4, fps: 2, columns: 512, maxShift: 4, minOverlap: 20, threshold: 0.85 });
const SOURCE_BANDS = 16; const SOURCE_FPS = 30;

/**
 * @param {Uint8Array} levels frame-major, 16 bands a frame, as analysis.js returns them
 * @param {number} frames
 * @returns {Buffer|null} null when the song is too short to compare
 */
export function fingerprintOf(levels, frames) {
  const { bands, fps, columns, minOverlap } = FINGERPRINT;
  const per = SOURCE_BANDS / bands; const step = SOURCE_FPS / fps;
  const count = Math.min(columns, Math.floor(Math.min(frames, levels.length / SOURCE_BANDS) / step));
  if (count < minOverlap) return null;
  const out = Buffer.alloc(count * bands);
  for (let column = 0; column < count; column++) for (let band = 0; band < bands; band++) {
    let sum = 0;
    for (let frame = column * step; frame < (column + 1) * step; frame++) {
      for (let source = band * per; source < (band + 1) * per; source++) sum += levels[frame * SOURCE_BANDS + source];
    }
    out[column * bands + band] = Math.round(sum / (step * per));
  }
  return out;
}

function correlation(a, b, shift, bands) {
  const columnsA = a.length / bands; const columnsB = b.length / bands;
  const start = Math.max(0, -shift); const end = Math.min(columnsA, columnsB - shift);
  if (end - start < FINGERPRINT.minOverlap) return -1;
  const n = (end - start) * bands;
  let sumA = 0; let sumB = 0;
  for (let column = start; column < end; column++) for (let band = 0; band < bands; band++) {
    sumA += a[column * bands + band]; sumB += b[(column + shift) * bands + band];
  }
  const meanA = sumA / n; const meanB = sumB / n;
  let product = 0; let squaresA = 0; let squaresB = 0;
  for (let column = start; column < end; column++) for (let band = 0; band < bands; band++) {
    const x = a[column * bands + band] - meanA; const y = b[(column + shift) * bands + band] - meanB;
    product += x * y; squaresA += x * x; squaresB += y * y;
  }
  return squaresA && squaresB ? product / Math.sqrt(squaresA * squaresB) : -1;
}

/** The best correlation of two fingerprints within the alignment window, -1 to 1. */
export function similarity(a, b) {
  const { bands, maxShift } = FINGERPRINT;
  if (!a?.length || !b?.length || a.length % bands || b.length % bands) return -1;
  let best = -1;
  for (let shift = -maxShift; shift <= maxShift; shift++) best = Math.max(best, correlation(a, b, shift, bands));
  return best;
}

export const sameAudio = (a, b) => similarity(a, b) >= FINGERPRINT.threshold;
