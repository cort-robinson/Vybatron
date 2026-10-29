import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { OpusDecoder } from 'opus-decoder';
import { portalFixture } from './portal-fixtures.js';
import { SongStore } from '../src/utils/song-store.js';
import { analyseInWorker, analyseOgg, BAND_EDGES, createAnalyser, createAnalysisCache, oggPackets, opusHead, packetDecoder } from '../src/portal/analysis.js';

// Ten seconds of a 60 Hz kick every half second (120 BPM) over a quiet 3 kHz
// tone, made with ffmpeg's libopus at 12 kbit/s. Self-made; no recorded music.
const fixture = readFileSync(new URL('./fixtures/kick-120bpm.ogg', import.meta.url));
const band = hz => BAND_EDGES.findIndex((edge, i) => hz >= edge && hz < BAND_EDGES[i + 1]);
const meanLevels = ({ frames, levels }) => Array.from({ length: 16 }, (_, b) => { let sum = 0; for (let i = 0; i < frames; i++) sum += levels[i * 16 + b]; return sum / frames; });
const intervals = times => times.slice(1).map((time, i) => time - times[i]);

// One Ogg page as RFC 3533 lays it out (CRC left zero: the reader doesn't check it).
function page(serial, sequence, segments, body, flags = 0) {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1'); header[5] = flags; header.writeUInt32LE(serial, 14); header.writeUInt32LE(sequence, 18); header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), body]);
}

test('Ogg pages give back their packets, including ones that span pages', () => {
  const big = Buffer.alloc(300, 7); const small = Buffer.from([1, 2, 3]);
  const data = Buffer.concat([
    page(5, 0, [3], small, 2),
    // 300 bytes: 255 here, the last 45 continued on the next page.
    page(5, 1, [255], big.subarray(0, 255)),
    page(9, 0, [3], Buffer.from([9, 9, 9]), 2), // another logical stream, ignored
    page(5, 2, [45, 3], Buffer.concat([big.subarray(255), small]), 1),
  ]);
  const packets = oggPackets(data);
  assert.deepEqual(packets.map(packet => packet.length), [3, 300, 3]);
  assert.deepEqual(packets[1], big);
  assert.throws(() => oggPackets(Buffer.from('RIFF0000000000000000000000000000')), error => error.status === 422);
  assert.throws(() => oggPackets(Buffer.concat([page(5, 0, [10], Buffer.alloc(4))])), error => error.status === 422);
});

test('the Opus header names the channels and pre-skip', () => {
  const packets = oggPackets(fixture);
  assert.deepEqual(opusHead(packets[0]), { channels: 2, preSkip: 312 });
  assert.throws(() => opusHead(packets[1]), error => error.status === 422);
});

test('the analyser finds 120 BPM beats on time and energy in the right bands', () => {
  const rate = 48_000; const seconds = 12; const samples = new Float32Array(rate * seconds);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate; const since = t % .5;
    samples[i] = .8 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-since * 18) + .15 * Math.sin(2 * Math.PI * 3000 * t);
  }
  const analyser = createAnalyser({ expectedFrames: seconds * 30 });
  // Pushed in uneven pieces, as decoded packets arrive.
  for (let at = 0; at < samples.length; at += 1234) analyser.push(samples.subarray(at, at + 1234));
  const result = analyser.finish();
  assert.equal(result.frames, seconds * 30);
  assert.equal(result.tempo, 120);
  assert.ok(result.beats.length >= seconds * 2 - 2);
  for (const time of result.beats) assert.ok(Math.abs(time - Math.round(time / 500) * 500) <= 20, `beat at ${time} ms`);
  const levels = meanLevels(result);
  const tone = band(3000);
  assert.ok(levels[band(60)] > 60, 'the kick fills the bass');
  for (let b = band(300); b < 16; b++) if (b !== tone) assert.ok(levels[tone] > levels[b] + 60, `3 kHz stands out over band ${b}`);
  assert.ok(Math.max(...result.levels) === 255 && Math.min(...result.levels) === 0, 'levels use the whole range');
});

test('an Ogg Opus song decodes and measures, in a worker as on the thread', async () => {
  const result = await analyseOgg(fixture);
  assert.equal(result.frames, 301);
  assert.equal(result.tempo, 120);
  for (const gap of intervals(result.beats)) assert.ok(Math.abs(gap - 500) <= 30, `beats ${gap} ms apart`);
  const levels = meanLevels(result);
  assert.ok(levels[band(3000)] === Math.max(...levels.slice(band(300))), 'the tone is the loudest above the bass');
  assert.ok(levels[band(60)] > levels[band(800)] + 30);
  const worked = await analyseInWorker(fixture);
  assert.deepEqual({ ...worked, levels: Buffer.from(worked.levels) }, { ...result, levels: Buffer.from(result.levels) });
});

test('packets are read straight from the decoder, matching its own copies', async () => {
  const packets = oggPackets(fixture).slice(2, 60);
  const options = { channels: 2, preSkip: 312, streamCount: 1, coupledStreamCount: 1, channelMappingTable: [0, 1] };
  const fast = new OpusDecoder(options); const slow = new OpusDecoder(options); await fast.ready; await slow.ready;
  const direct = packetDecoder(fast, 2);
  // If an upgrade moves the decoder's internals this fails rather than silently copying again.
  assert.equal(direct.fast, true);
  for (const packet of packets) {
    const mine = direct.decode(packet); const { channelData: [left, right], samplesDecoded } = slow.decodeFrame(packet);
    assert.equal(mine.length, samplesDecoded);
    for (let i = 0; i < samplesDecoded; i += 97) assert.ok(Math.abs(mine[i] - (left[i] + right[i]) / 2) < 1e-6);
  }
  fast.free(); slow.free();
});

function fakeAudio(entries) {
  const calls = [];
  return { calls, get: async id => { calls.push(id); const entry = entries[id]; if (entry instanceof Error) throw entry; return { type: 'audio/ogg', data: Buffer.alloc(1), done: Promise.resolve(), ...entry }; } };
}
const statusError = (status, code) => Object.assign(new Error(code), { status, code });
const result = { frames: 2, levels: new Uint8Array(32).fill(200), onsets: [33], beats: [33], tempo: null };

test('analyses are cached, bounded and limited to one at a time', async () => {
  let time = 0; let release; const held = new Promise(resolve => { release = resolve; });
  const analysed = [];
  const audio = fakeAudio({ webmonly123: { type: 'audio/webm' }, missing1234: statusError(404, 'audio_unavailable'), crowded1234: statusError(429, 'busy') });
  const cache = createAnalysisCache(audio, { now: () => time, limits: { analyses: 1, results: 2, waitMs: 20, maxFrames: 1000, unavailableMs: 1000 },
    analyse: async (_data, options) => { analysed.push(options.maxFrames); if (analysed.length === 1) await held; return result; } });
  // A slow first analysis answers "pending", and nothing else starts meanwhile.
  assert.deepEqual(await cache.get('aaaaaaaaaaa'), { version: 1, status: 'pending', retryMs: 2000 });
  await assert.rejects(cache.get('bbbbbbbbbbb'), error => error.status === 429);
  release();
  const ready = await cache.get('aaaaaaaaaaa');
  assert.equal(ready.status, 'ready'); assert.equal(ready.version, 1); assert.equal(ready.frameRate, 30); assert.equal(ready.bandCount, 16);
  assert.equal(ready.frameCount, 2); assert.equal(Buffer.from(ready.levels, 'base64').length, 32); assert.deepEqual(ready.beats, [33]);
  assert.deepEqual(ready.bandHz, BAND_EDGES);
  await cache.get('aaaaaaaaaaa');
  assert.equal(analysed.length, 1, 'answered from the cache');
  assert.deepEqual(analysed, [1000]);
  // The least recently used result goes first.
  await cache.get('bbbbbbbbbbb'); await cache.get('aaaaaaaaaaa'); await cache.get('ccccccccccc');
  assert.equal(cache.size, 2);
  await cache.get('aaaaaaaaaaa'); assert.equal(analysed.length, 3);
  await cache.get('bbbbbbbbbbb'); assert.equal(analysed.length, 4);
  // A fallback stream or a missing song is "unavailable" and remembered for a while.
  await assert.rejects(cache.get('webmonly123'), error => error.status === 404 && error.code === 'analysis_unavailable');
  await assert.rejects(cache.get('webmonly123'), error => error.status === 404);
  assert.equal(audio.calls.filter(id => id === 'webmonly123').length, 1);
  time = 2000;
  await assert.rejects(cache.get('webmonly123'), error => error.status === 404);
  assert.equal(audio.calls.filter(id => id === 'webmonly123').length, 2);
  await assert.rejects(cache.get('missing1234'), error => error.code === 'analysis_unavailable');
  // A busy audio cache is passed on and never remembered.
  await assert.rejects(cache.get('crowded1234'), error => error.status === 429);
  await assert.rejects(cache.get('crowded1234'), error => error.status === 429);
  assert.equal(audio.calls.filter(id => id === 'crowded1234').length, 2);
  await assert.rejects(cache.get('short'), error => error.status === 400);
});

test('a failed analysis is retried on the next request', async () => {
  let fails = true;
  const cache = createAnalysisCache(fakeAudio({}), { limits: { analyses: 1, results: 2, waitMs: 50, maxFrames: 1000, unavailableMs: 1000 },
    analyse: async () => { if (fails) throw statusError(503, 'analysis_failed'); return result; } });
  await assert.rejects(cache.get('aaaaaaaaaaa'), error => error.status === 503);
  fails = false;
  assert.equal((await cache.get('aaaaaaaaaaa')).status, 'ready');
});

async function fakeLavalink(t) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://lavalink.invalid'); const id = url.pathname.split('/').pop();
    requests.push(url.pathname);
    if (url.pathname.startsWith('/vybatron/audio/') && id === 'abcdefghijk') { response.writeHead(200, { 'Content-Type': 'audio/ogg' }); response.end(fixture); return; }
    if (id === 'webmonly123' && url.searchParams.get('itag') === '251') { response.writeHead(200, { 'Content-Type': 'audio/webm' }); response.end(Buffer.alloc(100)); return; }
    response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, requests };
}

test('the bridge serves a song’s analysis to server members only', async t => {
  const f = await portalFixture(t); const lavalink = await fakeLavalink(t);
  f.node.options = { host: '127.0.0.1', port: lavalink.port, authorization: 'lavalink-secret', secure: false };
  const get = (id, actor = '200', headers = { Authorization: `Bearer ${f.token}` }) => fetch(`${f.origin}/v1/guilds/100/analysis/${id}?actorId=${actor}`, { headers });
  assert.equal((await get('abcdefghijk', '901')).status, 404);
  assert.equal((await get('short')).status, 404);
  assert.equal((await get('abcdefghijk', '200', {})).status, 401);
  assert.equal(lavalink.requests.length, 0, 'nothing is fetched before authorization');
  const response = await get('abcdefghijk');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ready'); assert.equal(body.version, 1); assert.equal(body.frameCount, 301); assert.equal(body.tempo, 120);
  assert.equal(Buffer.from(body.levels, 'base64').length, 301 * 16);
  // The song came through the device-playback audio cache, once.
  assert.equal((await (await get('abcdefghijk')).json()).frameCount, 301);
  assert.deepEqual(lavalink.requests, ['/vybatron/audio/abcdefghijk']);
  const webm = await get('webmonly123');
  assert.equal(webm.status, 404); assert.equal((await webm.json()).error.code, 'analysis_unavailable');
});

test('a song whose own upload can\'t stream is analysed from the source its device plays', async t => {
  const songs = new SongStore(':memory:', { logger: { log() {}, error() {} } }); await songs.open(); t.after(() => songs.close());
  const upload = id => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title: 'Song', author: 'Artist', duration: 10_000, isStream: false } });
  songs.addVerifiedSource(songs.record(upload('refusedSong')), upload('abcdefghijk'), .99);
  const f = await portalFixture(t, { songs }); const lavalink = await fakeLavalink(t);
  f.node.options = { host: '127.0.0.1', port: lavalink.port, authorization: 'lavalink-secret', secure: false };
  const response = await fetch(`${f.origin}/v1/guilds/100/analysis/refusedSong?actorId=200`, { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).frameCount, 301);
  assert.ok(lavalink.requests.includes('/vybatron/audio/abcdefghijk'));
});
