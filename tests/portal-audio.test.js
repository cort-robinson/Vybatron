import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { portalFixture } from './portal-fixtures.js';
import { createAudioCache, playableAudio, sendAudio, wholeOgg } from '../src/portal/audio.js';
import { SongStore } from '../src/utils/song-store.js';

// A whole song as the plugin sends it: Ogg pages ending with end-of-stream.
function ogg(size, flags = 0x04) {
  let segments = 1; while (size - 27 - segments > 255 * segments - 1) segments++;
  const body = size - 27 - segments;
  const page = Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
  page.write('OggS', 0, 'latin1'); page[4] = 0; page[5] = flags; page[26] = segments;
  for (let i = 0; i < segments; i++) page[27 + i] = i < segments - 1 ? 255 : body - 255 * (segments - 1);
  return page;
}
const song = ogg(1000);

// Lavalink at the network boundary: our audio plugin, plus the YouTube plugin's
// stream route (no real length, no Range support), which serves only some videos.
async function fakeLavalink(t, { hold } = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://lavalink.invalid');
    requests.push({ path: url.pathname, itag: url.searchParams.get('itag'), auth: request.headers.authorization });
    const id = url.pathname.split('/').pop();
    if (url.pathname.startsWith('/vybatron/audio/') && ['abcdefghijk', 'slowsong123'].includes(id)) {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' });
      response.write(song.subarray(0, 500));
      if (id === 'slowsong123') await hold;
      response.end(song.subarray(500)); return;
    }
    // The plugin refuses a song YouTube won't serve, and drops one cut off partway.
    if (url.pathname.startsWith('/vybatron/audio/') && id === 'refusedsong') { response.writeHead(502); response.end(); return; }
    if (url.pathname.startsWith('/vybatron/audio/') && id === 'cutoffsong1') {
      response.writeHead(200, { 'Content-Type': 'audio/ogg' }); response.end(ogg(500, 0)); return;
    }
    if (id === 'webmonly123' && url.searchParams.get('itag') === '251') { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(song); return; }
    response.writeHead(url.pathname.startsWith('/vybatron/') ? 404 : 400, { 'Content-Type': 'application/json' }); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, requests };
}
async function audioFixture(t, options) {
  const f = await portalFixture(t);
  const lavalink = await fakeLavalink(t, options);
  f.node.options = { host: '127.0.0.1', port: lavalink.port, authorization: 'lavalink-secret', secure: false };
  const get = (id, { actor = '200', headers = {} } = {}) => fetch(`${f.origin}/v1/guilds/100/audio/${id}?actorId=${actor}`, { headers: { Authorization: `Bearer ${f.token}`, ...headers } });
  return { f, lavalink, get };
}

test('portal audio decodes through the Lavalink plugin and serves byte ranges', async t => {
  const { lavalink, get } = await audioFixture(t);
  const full = await get('abcdefghijk');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/ogg'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), song);
  assert.deepEqual(lavalink.requests, [{ path: '/vybatron/audio/abcdefghijk', itag: null, auth: 'lavalink-secret' }]);

  const part = await get('abcdefghijk', { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), song.subarray(10, 20));
  const tail = await get('abcdefghijk', { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.headers.get('content-range'), 'bytes 995-999/1000'); await tail.arrayBuffer();
  const whole = await get('abcdefghijk');
  assert.equal(whole.headers.get('content-length'), '1000'); await whole.arrayBuffer();
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=2000-' } })).status, 416);
  assert.equal((await get('abcdefghijk', { headers: { Range: 'bytes=a-b' } })).status, 416);
  // Every request after the first is answered from the one download.
  assert.equal(lavalink.requests.length, 1);
});

test('a song still arriving streams from its start while ranges wait for the whole song', async t => {
  let release; const hold = new Promise(resolve => { release = resolve; });
  const { get } = await audioFixture(t, { hold });
  const first = await get('slowsong123');
  assert.equal(first.status, 200); assert.equal(first.headers.get('content-length'), null);
  const reader = first.body.getReader();
  const { value } = await reader.read();
  assert.deepEqual(Buffer.from(value), song.subarray(0, 500));
  const ranged = get('slowsong123', { headers: { Range: 'bytes=900-909' } });
  release();
  const rest = []; for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest.push(chunk.value);
  assert.deepEqual(Buffer.concat([value, ...rest]), song);
  const answer = await ranged;
  assert.equal(answer.status, 206); assert.equal(answer.headers.get('content-range'), 'bytes 900-909/1000');
  assert.deepEqual(Buffer.from(await answer.arrayBuffer()), song.subarray(900, 910));
});

test('portal audio falls back to the YouTube stream route and explains unavailable songs', async t => {
  const { lavalink, get } = await audioFixture(t);
  const webm = await get('webmonly123');
  assert.equal(webm.status, 200); assert.equal(webm.headers.get('content-type'), 'audio/webm'); await webm.arrayBuffer();
  assert.deepEqual(lavalink.requests.map(item => item.itag ?? 'plugin'), ['plugin', '140', '251']);
  const missing = await get('missing1234');
  assert.equal(missing.status, 404); assert.equal((await missing.json()).error.code, 'audio_unavailable');
  // A failed lookup is not cached as a success; it is tried again next time.
  await (await get('missing1234')).arrayBuffer();
  assert.equal(lavalink.requests.filter(item => item.path.endsWith('missing1234')).length, 6);
});

test('a song YouTube refuses or cuts off is explained and never cached', async t => {
  const { lavalink, get } = await audioFixture(t);
  const refused = await get('refusedsong');
  assert.equal(refused.status, 404);
  assert.match((await refused.json()).error.message, /can’t be streamed right now/);
  assert.deepEqual(lavalink.requests.map(item => item.itag ?? 'plugin'), ['plugin', '140', '251']);

  // Lavalink's server ends a failed song's response normally, just without end-of-stream.
  const cut = await get('cutoffsong1');
  assert.equal(cut.status, 200);
  await assert.rejects(cut.arrayBuffer());
  // The player's follow-up check asks Lavalink again instead of getting the partial song.
  const probe = await get('cutoffsong1', { headers: { Range: 'bytes=0-0' } });
  assert.notEqual(probe.status, 206); await probe.arrayBuffer().catch(() => {});
  assert.equal(lavalink.requests.filter(item => item.path === '/vybatron/audio/cutoffsong1').length, 2);
});

test('only an Ogg stream that ends with end-of-stream counts as a whole song', () => {
  assert.equal(wholeOgg(song), true);
  assert.equal(wholeOgg(Buffer.concat([ogg(100, 0x02), ogg(200, 0)])), false);
  assert.equal(wholeOgg(Buffer.concat([ogg(100, 0x02), ogg(200)])), true);
  assert.equal(wholeOgg(song.subarray(0, 999)), false);
  assert.equal(wholeOgg(Buffer.alloc(0)), false);
});

test('portal audio needs server membership and a valid video id', async t => {
  const { lavalink, get, f } = await audioFixture(t);
  assert.equal((await get('abcdefghijk', { actor: '901' })).status, 404);
  assert.equal((await get('short')).status, 404);
  assert.equal((await fetch(`${f.origin}/v1/guilds/100/audio/abcdefghijk?actorId=200`)).status, 401);
  assert.equal(lavalink.requests.length, 0);
});

test('the audio cache evicts least recently used songs and bounds concurrent downloads', async () => {
  const sizes = { aaaaaaaaaaa: 40, bbbbbbbbbbb: 40, ccccccccccc: 40 };
  const fetches = [];
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 },
    fetchImpl: async url => { const id = new URL(url).pathname.split('/').pop(); fetches.push(id); return new Response(ogg(sizes[id] ?? 60)); } });
  const load = async id => { const entry = await cache.get(id); await entry.done; return entry; };
  await load('aaaaaaaaaaa'); await load('bbbbbbbbbbb');
  await load('aaaaaaaaaaa');
  await load('ccccccccccc');
  assert.equal(cache.size, 80);
  await load('aaaaaaaaaaa');
  assert.deepEqual(fetches, ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  await assert.rejects(load('ddddddddddd'), error => error.status === 413);
  const gated = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 1, timeoutMs: 1000 }, fetchImpl: () => new Promise(() => {}) });
  void gated.get('aaaaaaaaaaa').catch(() => {});
  assert.throws(() => gated.get('bbbbbbbbbbb'), error => error.status === 429);
});

test('sendAudio answers whole and partial requests the way media elements expect', async () => {
  const sent = [];
  const response = { writeHead: (status, headers) => sent.push({ status, headers }), end: body => sent.push(body?.length ?? 0) };
  await sendAudio({ headers: { range: 'bytes=0-1' } }, response, { complete: true, data: song, type: 'audio/ogg', done: Promise.resolve() });
  assert.equal(sent[0].status, 206); assert.equal(sent[0].headers['Content-Length'], 2); assert.equal(sent[1], 2);
});

test('a background fetch shares cached songs but never takes a download slot from playback', async () => {
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 }, fetchImpl: () => new Promise(() => {}) });
  void cache.get('aaaaaaaaaaa').catch(() => {});
  assert.throws(() => cache.get('bbbbbbbbbbb', { background: true }), error => error.status === 429);
  // A listener's next song still gets the second slot.
  void cache.get('ccccccccccc').catch(() => {});
  assert.throws(() => cache.get('ddddddddddd'), error => error.status === 429);
  const idle = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 }, fetchImpl: async () => new Response(ogg(40)) });
  const entry = await idle.get('aaaaaaaaaaa', { background: true }); await entry.done;
  assert.equal(entry.bytes, 40);
});

test('a device song plays from its best verified source and moves past one that can\'t stream', async t => {
  const songs = new SongStore(':memory:', { logger: { log() {}, error() {} } }); await songs.open(); t.after(() => songs.close());
  const upload = (id, author = 'Djo') => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title: 'End of Beginning', author, duration: 160_000, isStream: false } });
  const id = songs.record(upload('Kf5pXDhx5Vc', 'Djo - Topic'));
  songs.addVerifiedSource(id, upload('xy3AcmW0lrQ', 'Djo Music'), .99);
  const asked = []; const refused = new Set(['Kf5pXDhx5Vc']);
  const audio = { get: async video => {
    asked.push(video);
    if (refused.has(video)) throw Object.assign(new Error('unavailable'), { status: 404, code: 'audio_unavailable' });
    if (video === 'busybusy001') throw Object.assign(new Error('busy'), { status: 429 });
    return { type: 'audio/ogg', done: Promise.resolve(), video };
  } };
  const playable = playableAudio(audio, songs);
  // The Topic upload, which played before, is tried first and refuses; its verified alternate plays.
  assert.equal((await playable.get('Kf5pXDhx5Vc')).video, 'xy3AcmW0lrQ');
  assert.deepEqual(asked, ['Kf5pXDhx5Vc', 'xy3AcmW0lrQ']);
  await new Promise(resolve => setImmediate(resolve));
  // The refusal is remembered: next time the alternate goes straight away.
  asked.length = 0;
  assert.equal((await playable.get('Kf5pXDhx5Vc')).video, 'xy3AcmW0lrQ');
  assert.deepEqual(asked, ['xy3AcmW0lrQ']);
  // An unknown song plays as asked; busy is not a refusal; a refusal with nothing else fails as before.
  assert.equal((await playable.get('abcdefghijk')).video, 'abcdefghijk');
  await assert.rejects(playable.get('busybusy001'), error => error.status === 429);
  // Both refuse: the song waits out the cooldown instead of retrying the failed uploads.
  refused.add('xy3AcmW0lrQ');
  await assert.rejects(playable.get('Kf5pXDhx5Vc'), error => error.code === 'audio_unavailable');
  asked.length = 0;
  await assert.rejects(playable.get('Kf5pXDhx5Vc'), error => error.code === 'audio_unavailable');
  assert.deepEqual(asked, []);
});

test('a device song keeps the source it started with across range requests', async t => {
  let clock = 1_800_000_000_000;
  const songs = new SongStore(':memory:', { logger: { log() {}, error() {} }, now: () => clock }); await songs.open(); t.after(() => songs.close());
  const upload = id => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title: 'Song', author: 'Artist', duration: 160_000, isStream: false } });
  const id = songs.record(upload('firstSong01'));
  songs.addVerifiedSource(id, upload('otherSong01'), .99);
  const audio = { get: async video => ({ done: Promise.resolve(), video }) };
  const playable = playableAudio(audio, songs);
  assert.equal((await playable.get('firstSong01')).video, 'firstSong01');
  await new Promise(resolve => setImmediate(resolve));
  // Discord plays the other upload a minute later, which makes it the preferred source.
  clock += 60_000;
  songs.sourceResult('https://www.youtube.com/watch?v=otherSong01', true);
  assert.equal(songs.playbackSources('https://www.youtube.com/watch?v=firstSong01')[0].identifier, 'otherSong01');
  assert.equal((await playable.get('firstSong01')).video, 'firstSong01');
});

test('a device song whose stream fails partway gives up its source for the next request', async t => {
  let clock = 1_800_000_000_000;
  const songs = new SongStore(':memory:', { logger: { log() {}, error() {} }, now: () => clock }); await songs.open(); t.after(() => songs.close());
  const upload = id => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title: 'Song', author: 'Artist', duration: 160_000, isStream: false } });
  const id = songs.record(upload('firstSong01'));
  songs.addVerifiedSource(id, upload('otherSong01'), .99);
  const asked = []; let cut;
  const audio = { get: async video => {
    asked.push(video);
    if (video === 'firstSong01') { const done = new Promise((_, reject) => { cut = reject; }); done.catch(() => {}); return { done, video }; }
    return { done: Promise.resolve(), video };
  } };
  const playable = playableAudio(audio, songs);
  assert.equal((await playable.get('firstSong01')).video, 'firstSong01');
  cut(new Error('cut off')); await new Promise(resolve => setImmediate(resolve));
  clock += 1000;
  assert.equal((await playable.get('firstSong01')).video, 'otherSong01');
  assert.deepEqual(asked, ['firstSong01', 'otherSong01']);
});

test('a stream that fails partway releases every upload pinned to it', async t => {
  let clock = 1_800_000_000_000;
  const songs = new SongStore(':memory:', { logger: { log() {}, error() {} }, now: () => clock }); await songs.open(); t.after(() => songs.close());
  const upload = id => ({ info: { identifier: id, uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', title: 'Song', author: 'Artist', duration: 160_000, isStream: false } });
  const id = songs.record(upload('uploadAAAAA'));
  songs.addVerifiedSource(id, upload('uploadBBBBB'), .99);
  let cut; const shared = new Promise((_, reject) => { cut = reject; }); shared.catch(() => {});
  // Like the audio cache, every request for A gets the one cached entry.
  const entryA = { done: shared, video: 'uploadAAAAA' };
  const audio = { get: async video => (video === 'uploadAAAAA' ? entryA : { done: Promise.resolve(), video }) };
  const playable = playableAudio(audio, songs);
  // Both uploads of the song are asked for and both get the cached stream of A.
  assert.equal((await playable.get('uploadAAAAA')).video, 'uploadAAAAA');
  assert.equal((await playable.get('uploadBBBBB')).video, 'uploadAAAAA');
  cut(new Error('cut off')); await new Promise(resolve => setImmediate(resolve));
  clock += 1000;
  assert.equal((await playable.get('uploadBBBBB')).video, 'uploadBBBBB');
  assert.equal((await playable.get('uploadAAAAA')).video, 'uploadBBBBB');
});

// Our Lavalink plugin with its own two export permits: a slow song holds one until
// it is finished, or until Lavalink notices the bot hung up, a moment after it did.
async function slowPlugin(t) {
  const holds = new Map(); const requests = []; const hungUp = []; let active = 0;
  const finish = id => holds.get(id)?.();
  const server = createServer((request, response) => {
    const id = new URL(request.url, 'http://lavalink.invalid').pathname.split('/').pop();
    requests.push(id);
    if (active >= 2) { response.writeHead(429); response.end(); return; }
    active++;
    let released = false; const release = () => { if (!released) { released = true; active--; } };
    response.writeHead(200, { 'Content-Type': 'audio/ogg' }); response.write(song.subarray(0, 500));
    holds.set(id, () => { response.end(song.subarray(500)); release(); });
    response.once('close', () => { if (!response.writableFinished) { hungUp.push(id); setTimeout(release, 30); } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { port: server.address().port, requests, hungUp, finish };
}
async function skipFixture(t, options) {
  const f = await portalFixture(t, options);
  const plugin = await slowPlugin(t);
  f.node.options = { host: '127.0.0.1', port: plugin.port, authorization: 'lavalink-secret', secure: false };
  // The bridge's own view of each audio request closing, so no test guesses with a delay.
  const closes = []; const arrived = [];
  f.bridge.server.on('request', (request, response) => {
    const id = new URL(request.url, f.origin).pathname.split('/').pop();
    arrived.push(id); response.once('close', () => closes.push(id));
  });
  const until = async condition => { while (!condition()) await new Promise(resolve => setImmediate(resolve)); };
  const closed = (id, count = 1) => until(() => closes.filter(seen => seen === id).length >= count);
  const get = (id, { headers = {}, signal } = {}) => fetch(`${f.origin}/v1/guilds/100/audio/${id}?actorId=200`, { headers: { Authorization: `Bearer ${f.token}`, ...headers }, signal });
  // A media element that starts a song, hears its first bytes, and is skipped.
  const skip = async id => {
    const leaving = new AbortController();
    const answer = await get(id, { signal: leaving.signal });
    assert.equal(answer.status, 200);
    await answer.body.getReader().read();
    leaving.abort();
    await closed(id);
  };
  return { plugin, get, skip, until, closed, arrived };
}

test('skipping past songs still loading gives their download slots to the song the listener lands on', async t => {
  const { plugin, get, skip } = await skipFixture(t);
  await skip('skipsongaaa'); await skip('skipsongbbb');
  const landed = await get('skipsongccc');
  assert.equal(landed.status, 200, 'the song the listener landed on gets a slot instead of a busy answer');
  plugin.finish('skipsongccc');
  assert.deepEqual(Buffer.from(await landed.arrayBuffer()), song);
  // Only the oldest abandoned download was hung up on, so Lavalink can free its own permit.
  assert.deepEqual(plugin.hungUp, ['skipsongaaa']);
  // A song abandoned partway was never kept: going back downloads it whole again.
  const back = await get('skipsongaaa');
  assert.equal(back.status, 200);
  plugin.finish('skipsongaaa');
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), song);
  assert.equal(plugin.requests.filter(id => id === 'skipsongaaa').length, 2);
  // Lavalink still held its permit when the landed song first asked, and was asked again.
  assert.ok(plugin.requests.filter(id => id === 'skipsongccc').length >= 2);
});

test('only a download nobody holds is abandoned, and that never counts against its source', async () => {
  const client = { lavalink: { nodeManager: { leastUsedNodes: () => [{ connected: true, options: { host: 'lavalink', port: 2333, authorization: 'x' } }] } } };
  const aborted = [];
  // Each song answers with its first bytes and then stalls until the bot hangs up.
  const fetchImpl = async (url, { signal }) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(10));
    signal.addEventListener('abort', () => { aborted.push(new URL(url).pathname.split('/').pop()); controller.error(signal.reason); }, { once: true });
  } }), { headers: { 'Content-Type': 'audio/ogg' } });
  const cache = createAudioCache(client, { limits: { trackBytes: 50, cacheBytes: 100, downloads: 2, timeoutMs: 1000 }, fetchImpl });
  const results = [];
  const playable = playableAudio(cache, { songOf: () => null, playbackSources: () => [], sourceResult: (url, ok) => results.push([url.slice(-11), ok]) });
  // An analysis (no signal) keeps its download; a listener's request holds one until it closes.
  void cache.get('aaaaaaaaaaa').catch(() => {});
  const listener = new AbortController();
  const skipped = await playable.get('bbbbbbbbbbb', { signal: listener.signal });
  assert.throws(() => cache.get('ccccccccccc', { signal: new AbortController().signal }), error => error.status === 429);
  listener.abort();
  // A background fetch never takes a slot from anyone.
  assert.throws(() => cache.get('ddddddddddd', { background: true }), error => error.status === 429);
  void cache.get('eeeeeeeeeee', { signal: new AbortController().signal }).catch(() => {});
  assert.equal((await skipped.done.catch(error => error)).code, 'abandoned');
  assert.deepEqual(aborted, ['bbbbbbbbbbb']);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(results, []);
  // A song asked for again starts over rather than reusing the partial one.
  assert.throws(() => cache.get('bbbbbbbbbbb'), error => error.status === 429);
});

test('a warm-up or a song someone still plays keeps its download when a listener skips', async t => {
  const { plugin, get, skip, until, closed } = await skipFixture(t);
  // The next song warms up while nobody listens to it yet, and its probe may give up before it finishes.
  const giving = new AbortController();
  const warm = get('warmsongaaa', { headers: { Range: 'bytes=0-0' }, signal: giving.signal }).catch(() => null);
  await until(() => plugin.requests.includes('warmsongaaa'));
  giving.abort(); await warm; await closed('warmsongaaa');
  await skip('skipsongbbb');
  const landed = await get('skipsongccc');
  assert.equal(landed.status, 200);
  const reader = landed.body.getReader(); await reader.read();
  // Both slots now serve the warm-up and a listener: a further song waits its turn.
  assert.equal((await get('skipsongddd')).status, 429);
  assert.deepEqual(plugin.hungUp, ['skipsongbbb']);
  plugin.finish('warmsongaaa'); plugin.finish('skipsongccc');
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read());
  const warmed = await get('warmsongaaa', { headers: { Range: 'bytes=0-0' } });
  assert.equal(warmed.status, 206); await warmed.arrayBuffer();
  assert.equal(plugin.requests.filter(id => id === 'warmsongaaa').length, 1);
});

test('a listener who skips while still being authorized leaves no download behind', { timeout: 10_000 }, async t => {
  let gate = null; let asked = 0;
  const { plugin, get, until, closed, arrived } = await skipFixture(t, { memberFetch: async () => { if (gate) { asked++; await gate.promise; } } });
  gate = Promise.withResolvers();
  const leaving = [new AbortController(), new AbortController()];
  const gone = ['skipsongaaa', 'skipsongbbb'].map((id, index) => get(id, { signal: leaving[index].signal }).catch(() => null));
  // Both requests reached the bridge and the member lookup they wait on is held.
  await until(() => asked >= 1 && arrived.includes('skipsongaaa') && arrived.includes('skipsongbbb'));
  await new Promise(resolve => setImmediate(resolve));
  for (const controller of leaving) controller.abort();
  await Promise.all(gone); await closed('skipsongaaa'); await closed('skipsongbbb');
  gate.resolve(); gate = null;
  const landed = await get('skipsongccc');
  assert.equal(landed.status, 200, 'requests that left during authorization hold no slot');
  plugin.finish('skipsongccc');
  assert.deepEqual(Buffer.from(await landed.arrayBuffer()), song);
  await until(() => plugin.requests.includes('skipsongccc'));
  assert.deepEqual(plugin.requests, ['skipsongccc'], 'nothing was downloaded for the listener who left');
});
