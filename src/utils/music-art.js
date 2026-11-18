import sharp from 'sharp';
import { crc32, deflateSync } from 'node:zlib';
import { trackProjection } from '../portal/projection.js';

const tileSize = 128;
const colors = [[103, 90, 218], [42, 151, 155], [199, 102, 78], [72, 99, 170]];
let activeCovers = 0;

async function cover(track) {
  const url = trackProjection(track).artworkUrl;
  if (!url || activeCovers >= 4) return null;
  activeCovers++;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1800) });
    if (!response.ok || !/^image\/(?:jpeg|png|webp)\b/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel(); return null;
    }
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 2_000_000) return null;
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const isRaster = bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
      || bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      || (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP');
    if (!isRaster) return null;
    const raster = sharp(bytes, { limitInputPixels: 6_000_000 });
    if (!['jpeg', 'png', 'webp'].includes((await raster.metadata()).format)) return null;
    return await raster.resize(tileSize, tileSize, { fit: 'cover' }).removeAlpha().png().toBuffer();
  } catch { return null; } finally { activeCovers--; }
}

export async function mixCover(tracks) {
  const tiles = await Promise.all(colors.map(async ([r,g,b], i) => {
    const art = tracks[i] && await cover(tracks[i]);
    const input = art || await sharp({ create: { width: tileSize, height: tileSize, channels: 3, background: { r,g,b } } }).png().toBuffer();
    return { input, left: i % 2 * tileSize, top: Math.floor(i / 2) * tileSize };
  }));
  return sharp({ create: { width: tileSize * 2, height: tileSize * 2, channels: 3, background: '#242230' } }).composite(tiles).png().toBuffer();
}

export function videoOf(track) {
  const info = track?.info;
  return info?.sourceName?.toLowerCase() === 'youtube' && /^[\w-]{11}$/.test(info.identifier) && !info.isStream ? info.identifier : null;
}

export function energyBins(map, count = 80) {
  const levels = Buffer.from(map.levels, 'base64');
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor(map.frameCount * i / count) * map.bandCount;
    const end = Math.min(levels.length, Math.max(start + map.bandCount, Math.floor(map.frameCount * (i+1) / count) * map.bandCount));
    let sum = 0;
    for (let j = start; j < end; j++) sum += levels[j] ** 2;
    return Math.sqrt(sum / (end - start)) / 255;
  });
}

export async function energyArt(track, map) {
  const tile = await cover(track);
  const dominant = tile && (await sharp(tile).stats()).dominant;
  // Lift dark album colours so both halves stay visible on the charcoal strip.
  const color = dominant ? [dominant.r, dominant.g, dominant.b].map(v => Math.round(150 + .4 * v)) : [175,166,250];
  return { bins: energyBins(map), color };
}

function chunk(name, data) {
  const body = Buffer.concat([Buffer.from(name), data]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}

// A small RGB PNG. Only controller renders move the playhead.
export function waveform({ bins, color }, fraction) {
  const width = bins.length * 5, height = 48, stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  const playhead = Math.round(Math.min(1, Math.max(0, fraction || 0)) * (width - 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bar = x % 5 < 3 && Math.abs(y - height / 2) <= 1 + bins[Math.floor(x / 5)] * (height / 2 - 2);
      const at = y * stride + 1 + 3 * x;
      for (let c = 0; c < 3; c++) pixels[at+c] = x === playhead ? 250 : bar ? color[c] * (x < playhead ? 1 : .72) : 32;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',header), chunk('IDAT',deflateSync(pixels, { level: 1 })), chunk('IEND',Buffer.alloc(0))]);
}
