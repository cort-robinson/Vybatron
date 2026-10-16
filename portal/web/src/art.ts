import { useEffect, useState } from 'react';

// Room lighting derived from the current cover. Pixels are read only when the
// artwork host allows CORS; otherwise the default palette is used. Results are
// cached in memory for the page lifetime and never persisted.
export interface Palette { accent: string; glow: [string, string, string]; ground: string; source: 'art' | 'default' }

const linear = (c: number) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const encode = (c: number) => c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055;

function toOklch(r: number, g: number, b: number) {
  const [lr, lg, lb] = [linear(r / 255), linear(g / 255), linear(b / 255)];
  const l = Math.cbrt(.4122214708 * lr + .5363325363 * lg + .0514459929 * lb);
  const m = Math.cbrt(.2119034982 * lr + .6806995451 * lg + .1073969566 * lb);
  const s = Math.cbrt(.0883024619 * lr + .2817188376 * lg + .6299787005 * lb);
  const L = .2104542553 * l + .793617785 * m - .0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const B = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return { L, a: A, b: B, C: Math.hypot(A, B) };
}

function toRgb(L: number, C: number, h: number) {
  const a = C * Math.cos(h * Math.PI / 180); const b = C * Math.sin(h * Math.PI / 180);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (L - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (L - .0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + .2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s, -.0041960863 * l - .7034186147 * m + 1.707614701 * s].map(encode);
}

/** Converts OKLCH to an sRGB hex, reducing chroma until the color is in gamut. */
export function oklchHex(L: number, C: number, h: number) {
  let chroma = C; let rgb = toRgb(L, chroma, h);
  while (chroma > 0 && rgb.some(v => v < -.0005 || v > 1.0005)) { chroma = Math.max(0, chroma - .005); rgb = toRgb(L, chroma, h); }
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export const defaultPalette: Palette = {
  accent: oklchHex(.83, .13, 192),
  glow: [oklchHex(.42, .1, 200), oklchHex(.34, .13, 292), oklchHex(.3, .1, 252)],
  ground: oklchHex(.14, .014, 262),
  source: 'default',
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function paletteFromPixels(data: Uint8ClampedArray): Palette {
  const buckets = Array.from({ length: 18 }, () => ({ weight: 0, a: 0, b: 0, chroma: 0, count: 0 }));
  let colorful = 0; let sampled = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    const { L, a, b, C } = toOklch(data[i], data[i + 1], data[i + 2]);
    sampled++;
    if (L < .14 || C < .03) continue;
    colorful++;
    const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    const bucket = buckets[Math.floor(hue / 20) % 18];
    const weight = C * (1.15 - Math.abs(L - .62));
    bucket.weight += weight; bucket.a += a * weight; bucket.b += b * weight; bucket.chroma += C; bucket.count++;
  }
  const ranked = buckets.filter(bucket => bucket.count).map(bucket => ({
    hue: (Math.atan2(bucket.b, bucket.a) * 180 / Math.PI + 360) % 360, weight: bucket.weight, chroma: bucket.chroma / bucket.count,
  })).sort((x, y) => y.weight - x.weight);
  // Monochrome covers keep their character: a quiet near-white accent and graphite light.
  if (!sampled || colorful / sampled < .04 || !ranked.length) {
    const hue = ranked[0]?.hue ?? 262;
    return { accent: oklchHex(.9, .02, hue), glow: [oklchHex(.36, .02, hue), oklchHex(.28, .015, hue), oklchHex(.24, .01, hue)], ground: oklchHex(.14, .006, hue), source: 'art' };
  }
  const picks = [ranked[0]];
  for (const candidate of ranked.slice(1)) {
    if (picks.length === 3) break;
    if (picks.every(pick => Math.min(Math.abs(pick.hue - candidate.hue), 360 - Math.abs(pick.hue - candidate.hue)) >= 35) && candidate.weight > ranked[0].weight * .08) picks.push(candidate);
  }
  while (picks.length < 3) picks.push({ ...picks[picks.length - 1], hue: (picks[picks.length - 1].hue + 28) % 360 });
  const [lead, second, third] = picks;
  return {
    accent: oklchHex(.81, clamp(lead.chroma * 1.35, .09, .17), lead.hue),
    glow: [oklchHex(.46, clamp(lead.chroma * 1.2, .05, .16), lead.hue), oklchHex(.38, clamp(second.chroma * 1.15, .04, .15), second.hue), oklchHex(.32, clamp(third.chroma, .04, .13), third.hue)],
    ground: oklchHex(.14, clamp(lead.chroma * .2, .008, .024), lead.hue),
    source: 'art',
  };
}

const cache = new Map<string, Promise<Palette | null>>();

function extract(url: string) {
  return new Promise<Palette | null>(resolve => {
    const image = new Image();
    image.crossOrigin = 'anonymous'; image.referrerPolicy = 'no-referrer'; image.decoding = 'async';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, 40, 40);
        resolve(paletteFromPixels(context.getImageData(0, 0, 40, 40).data));
      } catch { resolve(null); }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

export function useArtPalette(url: string | undefined) {
  const [palette, setPalette] = useState<Palette>(defaultPalette);
  useEffect(() => {
    // Between songs the artwork can be briefly absent; hold the room's colors through the gap
    // instead of flashing to the default and back.
    if (!url) { const timer = setTimeout(() => setPalette(defaultPalette), 1500); return () => clearTimeout(timer); }
    let current = true;
    if (!cache.has(url)) { if (cache.size > 40) cache.delete(cache.keys().next().value!); cache.set(url, extract(url)); }
    void cache.get(url)!.then(result => { if (current) setPalette(result || defaultPalette); });
    return () => { current = false; };
  }, [url]);
  return palette;
}
