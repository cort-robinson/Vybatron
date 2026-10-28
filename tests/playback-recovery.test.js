import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate, setTimeout as sleep } from 'node:timers/promises';
import { LavalinkManager } from 'lavalink-client';
import {
  ATTEMPT_KEY,
  createPlaybackRecovery,
  exactTrackQuery,
  HardenedPlayer,
  invalidatePlaybackRecovery,
  sameRecording,
} from '../src/playback-recovery.js';
import { setSleepTimer, sleepTimer, cancelSleepTimer } from '../src/utils/sleep-timer.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle() {
  for (let count = 0; count < 6; count += 1) await immediate();
}

function fixture(options = {}) {
  const gatewayPackets = [];
  const manager = new LavalinkManager({
    nodes: [{ id: 'main', host: 'localhost', port: 2333, authorization: 'test-password' }],
    client: { id: '123' }, sendToShard: (_guildId, payload) => {
      gatewayPackets.push(payload);
      if (payload.d.channel_id && options.voiceGateway !== false) {
        const server = { t: 'VOICE_SERVER_UPDATE', d: {
          guild_id: 'g1', token: 'fresh-test-token', endpoint: 'voice-fresh.example',
        } };
        const state = { t: 'VOICE_STATE_UPDATE', d: {
          guild_id: 'g1', user_id: '123', session_id: 'fresh-voice-session', channel_id: payload.d.channel_id,
        } };
        for (const packet of options.voiceEventOrder === 'state-first' ? [state, server] : [server, state]) {
          void forward(packet);
        }
      }
    }, playerClass: HardenedPlayer,
    autoSkip: true, playerOptions: { maxErrorsPerTime: { threshold: 0, maxAmount: 0 } },
  });
  const node = manager.nodeManager.nodes.get('main');
  node.socket = { readyState: 1 };
  node.sessionId = 'session-1';
  node.info = { sourceManagers: ['youtube', 'soundcloud'], plugins: [], filters: [] };
  const writes = [];
  node.request = async (endpoint, modify) => {
    const request = { path: endpoint, headers: {} };
    modify?.(request);
    const body = request.body ? JSON.parse(request.body) : {};
    writes.push({ endpoint, ...body });
    if (options.request) await options.request(body, endpoint);
    return { guildId: 'g1', voice: { connected: true, ping: 1 }, ...body };
  };
  const player = manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v1', node: 'main', volume: 57 });
  player.connected = true;
  player.voice = { endpoint: 'voice.example', sessionId: 'voice-session', token: 'test-token', channelId: 'v1' };
  const failed = [];
  const recovering = [];
  const resumed = [];
  const tasks = [];
  const recovery = createPlaybackRecovery({ manager, delay: async () => {}, retryDelays: [0, 0],
    search: async () => ({ tracks: [] }), onFailed: (...args) => failed.push(args),
    onRecovering: (...args) => recovering.push(args), onResumed: (...args) => resumed.push(args),
    logger: { error: () => {} }, ...options });
  manager.playbackRecovery = recovery;
  manager.initiated = true;
  recovery.attachNode(node);
  manager.on('trackStart', () => recovery.started(player));
  manager.on('trackError', (p, track, payload) => tasks.push(recovery.handleFailure(p, track, payload)));
  manager.on('trackStuck', (p, track, payload) => tasks.push(recovery.handleFailure(p, track, payload)));

  async function forward(packet) {
    if (!recovery.consumeVoiceUpdate(packet)) await manager.sendRawData(packet);
  }

  function track(identifier = 'dQw4w9WgXcQ', extra = {}) {
    return manager.utils.buildTrack({ encoded: `encoded-${identifier}`,
      info: { identifier, title: 'Song', author: 'Artist', uri: `https://www.youtube.com/watch?v=${identifier}`,
        sourceName: 'youtube', length: 200_000, isSeekable: true, isStream: false, ...extra },
      pluginInfo: {}, userData: {} }, { id: 'requester-1' });
  }
  function wire(current = player.queue.current) {
    return { encoded: current.encoded, info: { ...current.info, length: current.info.duration },
      pluginInfo: { ...current.pluginInfo }, userData: { ...current.userData } };
  }
  async function start(first = track(), upcoming = [track('Zi_XLOBDo_Y')]) {
    await player.queue.add([first, ...upcoming]);
    await player.play();
    await node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: wire() });
    return first;
  }
  async function error(payload = {}, source = wire()) {
    await node.handleEvent({ type: 'TrackExceptionEvent', guildId: 'g1', track: source,
      exception: { message: 'Temporary source failure', severity: 'fault' }, ...payload });
    await tasks.at(-1);
    await settle();
  }
  return { manager, node, player, recovery, writes, gatewayPackets, tasks, failed, recovering, resumed,
    track, wire, start, error, forward };
}

// Lavalink 4.2.2's EventEmitter converts the live AudioTrack with toTrack(),
// which calls Lavaplayer encodeTrack(). Its final long is getPosition(), so a
// server event's encoding is not the catalog encoding once playback has moved.
// https://github.com/lavalink-devs/Lavalink/blob/4.2.2/LavalinkServer/src/main/java/lavalink/server/util/util.kt
// https://github.com/lavalink-devs/lavaplayer/blob/master/main/src/main/java/com/sedmelluq/discord/lavaplayer/player/DefaultAudioPlayerManager.java
const CATALOG_ENCODING = 'QAAAjQIAJVJpY2sgQXN0bGV5IC0gTmV2ZXIgR29ubmEgR2l2ZSBZb3UgVXAADlJpY2tBc3RsZXlWRVZPAAAAAAADPCAAC2RRdzR3OVdnWGNRAAEAK2h0dHBzOi8vd3d3LnlvdXR1YmUuY29tL3dhdGNoP3Y9ZFF3NHc5V2dYY1EAB3lvdXR1YmUAAAAAAAAAAA==';
// The pinned plugin concatenates client exceptions into its message. These
// three causes were observed together for the playable production canary.
// https://github.com/lavalink-devs/youtube-source/blob/2be8e542d3f6f178e048dca565892684c2e40177/common/src/main/java/dev/lavalink/youtube/AllClientsFailedException.java
const MIXED_CLIENT_EXCEPTION = {
  message: '(yts.version: 1.19.0) All clients failed to load the item.\n\nClient [TVHTML5] failed: Not success status code: 403\n\nClient [ANDROID_VR] failed: This video requires login.\n\nClient [WEB] failed: No supported audio streams available',
  severity: 'suspicious', cause: 'dev.lavalink.youtube.AllClientsFailedException',
};

function atServerPosition(encoded, position) {
  const bytes = Buffer.from(encoded, 'base64');
  bytes.writeBigInt64BE(BigInt(position), bytes.length - 8);
  return bytes.toString('base64');
}

function serverEchoFixture(options = {}) {
  const remote = { track: null, position: 0, paused: false };
  const started = [];
  let f;
  f = fixture({ ...options, request: async (body, endpoint) => {
    if (body.track?.encoded === null) remote.track = null;
    else if (body.track?.encoded) {
      remote.track = { ...f.wire(), encoded: body.track.encoded,
        userData: structuredClone(body.track.userData || {}) };
      remote.position = body.position ?? 0;
      remote.paused = body.paused ?? false;
    } else if (body.track?.userData && remote.track) {
      remote.track.userData = structuredClone(body.track.userData);
    }
    // PlayerRestHandler's omitted track/userData fields do not replace the
    // active AudioTrack or its userData for pause/resume/seek/filter PATCHes.
    if (typeof body.position === 'number' && remote.track) remote.position = body.position;
    if (typeof body.paused === 'boolean') remote.paused = body.paused;
    await options.request?.(body, endpoint);
  } });
  const buildTrack = f.track;
  f.track = (identifier = 'dQw4w9WgXcQ', extra) => {
    assert.equal(identifier.length, 11);
    const catalog = Buffer.from(CATALOG_ENCODING, 'base64');
    const original = Buffer.from('dQw4w9WgXcQ');
    for (let offset = catalog.indexOf(original); offset >= 0; offset = catalog.indexOf(original, offset + original.length)) {
      Buffer.from(identifier).copy(catalog, offset);
    }
    const track = buildTrack(identifier, extra);
    track.encoded = catalog.toString('base64');
    return track;
  };
  function wire() {
    assert.ok(remote.track, 'the server has an active AudioTrack');
    return { ...structuredClone(remote.track), encoded: atServerPosition(remote.track.encoded, remote.position),
      info: { ...remote.track.info, position: remote.position } };
  }
  async function emit(payload, track = wire()) {
    await f.node.handleEvent({ guildId: 'g1', track, ...payload });
    await settle();
  }
  async function start({ position = 0, paused = false, upcoming = [f.track('Zi_XLOBDo_Y')] } = {}) {
    const first = f.track();
    await f.player.queue.add(upcoming);
    await f.player.play({ clientTrack: first, position, paused });
    await emit({ type: 'TrackStartEvent' });
    return first;
  }
  f.manager.on('trackStart', (_player, track) => started.push(track));
  return { ...f, remote, started, serverWire: wire, emit, start };
}

test('server-encoded nonzero paused restore accepts TrackStart and pause/resume keep its wire token', async () => {
  const f = serverEchoFixture();
  const first = await f.start({ position: 107_420, paused: true });
  assert.notEqual(f.serverWire().encoded, first.encoded);
  assert.equal(f.started.length, 1);
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.lastPosition, 107_420);
  const token = f.serverWire().userData[ATTEMPT_KEY];
  await f.player.resume();
  assert.deepEqual(Object.keys(f.writes.at(-1)).sort(), ['endpoint', 'paused']);
  await f.player.pause();
  await f.player.resume();
  assert.equal(f.serverWire().userData[ATTEMPT_KEY], token);
  await f.emit({ type: 'TrackStartEvent' });
  assert.equal(f.player.playing, true);
  assert.equal(f.player.paused, false);
  assert.equal(f.recovery.summary().staleEvents, 0);
});

test('server-encoded FINISHED after seek advances the native queue once', async () => {
  const f = serverEchoFixture();
  const first = await f.start();
  await f.player.seek(95_000);
  f.remote.position = first.info.duration;
  const ended = f.serverWire();
  assert.notEqual(ended.encoded, first.encoded);
  f.remote.track = null;
  await f.emit({ type: 'TrackEndEvent', reason: 'finished' }, ended);
  await f.emit({ type: 'TrackEndEvent', reason: 'finished' }, ended);
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.player.queue.tracks.length, 0);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 2);
  assert.equal(f.recovery.summary().retries, 0);
  assert.equal(f.recovery.summary().staleEvents, 1);
});

test('server-encoded exception after restored resume retries the exact recording at its nonzero position', async () => {
  let f;
  f = serverEchoFixture({ search: async () => ({ tracks: [f.track()] }) });
  await f.start({ position: 107_420, paused: true });
  await f.player.resume();
  const failed = f.serverWire();
  f.remote.track = null;
  await f.emit({ type: 'TrackExceptionEvent',
    exception: { message: 'Temporary source failure', severity: 'fault' } }, failed);
  assert.equal(f.tasks.length, 1);
  await f.tasks[0];
  await settle();
  const retry = f.writes.filter((write) => write.track?.encoded).at(-1);
  assert.equal(retry.position, 107_420);
  assert.equal(retry.paused, false);
  assert.notEqual(retry.track.userData[ATTEMPT_KEY], failed.userData[ATTEMPT_KEY]);
  await f.emit({ type: 'TrackEndEvent', reason: 'loadFailed' }, failed);
  await f.emit({ type: 'TrackStartEvent' });
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.summary().retries, 1);
  assert.equal(f.recovery.summary().recovered, 1);
  assert.equal(f.recovery.summary().staleEvents, 1);
});

test('server-encoded exception preserves the failure position after a missing-track zero update', async () => {
  let f;
  f = serverEchoFixture({ search: async () => ({ tracks: [f.track()] }) });
  await f.start({ position: 107_420, paused: true });
  await f.player.resume();
  const failed = f.serverWire();
  f.remote.track = null;
  // Lavalink's player update reports track?.position ?: 0 after an executor
  // fails. Its TrackExceptionEvent still serializes the failed AudioTrack.
  await f.node.message(JSON.stringify({ op: 'playerUpdate', guildId: 'g1',
    state: { position: 0, connected: true, ping: 1, time: Date.now() } }));
  assert.equal(f.player.lastPosition, 0);
  await f.emit({ type: 'TrackExceptionEvent',
    exception: { message: 'Temporary source failure', severity: 'fault' } }, failed);
  await f.tasks[0];
  const retry = f.writes.filter((write) => write.track?.encoded).at(-1);
  assert.equal(retry.position, 107_420);
  assert.equal(retry.paused, false);
  assert.equal(f.player.queue.tracks.length, 1);
});

test('server-encoded exception rejects invalid event positions and keeps the reported fallback', async () => {
  for (const invalid of [-1, 200_001, '107420', Infinity, 12.5]) {
    let f;
    f = serverEchoFixture({ search: async () => ({ tracks: [f.track()] }) });
    await f.start({ position: 55_000 });
    const failed = f.serverWire();
    failed.info.position = invalid;
    f.remote.track = null;
    await f.emit({ type: 'TrackExceptionEvent',
      exception: { message: 'Temporary source failure', severity: 'fault' } }, failed);
    await f.tasks[0];
    const retry = f.writes.filter((write) => write.track?.encoded).at(-1);
    assert.equal(retry.position, 55_000);
  }
});

test('server-encoded same-identifier events with old or missing attempt tokens stay fenced', async () => {
  const f = serverEchoFixture();
  await f.start({ position: 95_000 });
  const old = f.serverWire();
  await f.player.play({ clientTrack: f.track(), position: 107_420, paused: false });
  const current = f.serverWire();
  assert.notEqual(current.encoded, old.encoded);
  assert.notEqual(current.userData[ATTEMPT_KEY], old.userData[ATTEMPT_KEY]);
  for (const payload of [
    { type: 'TrackStartEvent' },
    { type: 'TrackEndEvent', reason: 'finished' },
    { type: 'TrackExceptionEvent', exception: { message: 'Old source failure' } },
  ]) await f.emit(payload, old);
  const missing = structuredClone(current);
  delete missing.userData[ATTEMPT_KEY];
  await f.emit({ type: 'TrackEndEvent', reason: 'finished' }, missing);
  await f.emit({ type: 'TrackStartEvent' }, current);
  assert.equal(f.tasks.length, 0);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.started.length, 2);
  assert.equal(f.recovery.summary().staleEvents, 4);
});

for (const mixedClientFailure of [false, true]) {
  test(`native natural finish retries the next recording after ${mixedClientFailure ? 'mixed-client login and transport' : 'ordinary source'} failure`, async () => {
    const queries = [];
    let f;
    f = serverEchoFixture({ search: async (_player, query) => {
      queries.push(query.query);
      return { tracks: [f.track('2SUwOgmvzK4', { length: 217_000 })] };
    } });
    await f.player.queue.add([
      f.track('jNQXAC9IVRw', { length: 19_000 }),
      f.track('2SUwOgmvzK4', { length: 217_000 }),
    ]);
    await f.player.play();
    await f.emit({ type: 'TrackStartEvent' });
    f.remote.position = 19_000;
    const ended = f.serverWire();
    f.remote.track = null;
    await f.emit({ type: 'TrackEndEvent', reason: 'finished' }, ended);
    await f.emit({ type: 'TrackStartEvent' });
    // A duplicate end from the previous recording cannot terminate the next.
    await f.emit({ type: 'TrackEndEvent', reason: 'finished' }, ended);
    const failed = f.serverWire();
    f.remote.track = null;
    await f.emit({ type: 'TrackExceptionEvent', exception: mixedClientFailure ? MIXED_CLIENT_EXCEPTION : {
      message: 'All clients failed to load the item.', severity: 'suspicious',
      cause: 'dev.lavalink.youtube.AllClientsFailedException',
    } }, failed);
    await f.tasks[0];
    assert.deepEqual(queries, ['https://www.youtube.com/watch?v=2SUwOgmvzK4']);
    const retry = f.writes.filter((write) => write.track?.encoded).at(-1);
    assert.equal(retry.position, 0);
    assert.equal(f.player.queue.current.info.identifier, '2SUwOgmvzK4');
    await f.emit({ type: 'TrackStartEvent' });
    assert.equal(f.recovery.summary().retries, 1);
    assert.equal(f.recovery.summary().recovered, 1);
    assert.equal(f.recovery.summary().skipped, 0);
    assert.equal(f.recovery.summary().staleEvents, 1);
  });
}

test('repeated mixed-client failures exhaust their bounded allowance without replay or skip storms', async () => {
  let searches = 0;
  let f;
  f = serverEchoFixture({ search: async () => {
    searches += 1;
    return { tracks: [f.track()] };
  } });
  await f.start({ upcoming: [] });
  const firstAttempt = f.serverWire();
  f.remote.track = null;
  await f.emit({ type: 'TrackExceptionEvent', exception: MIXED_CLIENT_EXCEPTION }, firstAttempt);
  await f.tasks[0];
  await f.emit({ type: 'TrackStartEvent' });
  const replay = f.serverWire();
  f.remote.track = null;
  await f.emit({ type: 'TrackExceptionEvent', exception: MIXED_CLIENT_EXCEPTION }, replay);
  await f.tasks[1];
  await f.emit({ type: 'TrackEndEvent', reason: 'loadFailed' }, replay);
  await f.emit({ type: 'TrackExceptionEvent', exception: MIXED_CLIENT_EXCEPTION }, firstAttempt);
  assert.equal(searches, 1);
  assert.equal(f.recovery.summary().retries, 1);
  assert.equal(f.recovery.summary().skipped, 1);
  assert.equal(f.recovery.summary().recovering, 0);
  assert.equal(f.player.queue.current, null);
  assert.equal(f.writes.filter((write) => write.track?.encoded === null).length, 1);
});

test('real-client adapter retries the exact identifier without shifting the pending queue', async () => {
  let fresh;
  const f = fixture({ search: async (_player, query, requester) => {
    assert.equal(query.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    assert.equal(requester.id, 'requester-1');
    return { tracks: [fresh] };
  } });
  const first = await f.start();
  fresh = f.track(first.info.identifier);
  f.player.lastPosition = 41_500;
  const upcoming = [...f.player.queue.tracks];
  const oldEventTrack = f.wire();
  await f.node.handleEvent({ type: 'TrackStuckEvent', guildId: 'g1', track: oldEventTrack, thresholdMs: 10_000 });
  await f.node.handleEvent({ type: 'TrackEndEvent', guildId: 'g1', track: oldEventTrack, reason: 'loadFailed' });
  await f.tasks[0];
  assert.deepEqual(f.player.queue.tracks, upcoming);
  assert.equal(f.player.queue.current.info.identifier, first.info.identifier);
  assert.equal(f.player.queue.current.requester.id, 'requester-1');
  const playWrites = f.writes.filter((write) => write.track?.encoded);
  assert.equal(playWrites.length, 2);
  assert.equal(playWrites[1].position, 41_500);
  assert.notEqual(playWrites[0].track.userData[ATTEMPT_KEY], playWrites[1].track.userData[ATTEMPT_KEY]);
  assert.equal(f.failed.length, 0);
});

test('late loadFailed/stopped/start events from an earlier identical encoded attempt are ignored', async () => {
  const f = fixture({ search: async () => ({ tracks: [f.track()] }) });
  await f.start();
  const stale = f.wire();
  await f.error();
  for (const payload of [
    { type: 'TrackEndEvent', reason: 'loadFailed' },
    { type: 'TrackEndEvent', reason: 'stopped' },
    { type: 'TrackStartEvent' },
  ]) await f.node.handleEvent({ ...payload, guildId: 'g1', track: stale });
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.summary().staleEvents, 3);
});

test('ordinary finish advances once, preserving the library queue and rejecting duplicate ends', async () => {
  const f = fixture();
  await f.start();
  const ended = f.wire();
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'finished', guildId: 'g1', track: ended });
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'finished', guildId: 'g1', track: ended });
  await settle();
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.player.queue.tracks.length, 0);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 2);
});

test('stop after this track ends the session instead of starting the next queued track', async () => {
  const f = fixture();
  await f.start();
  const fired = [];
  setSleepTimer(f.player, { afterTrack: true, onFire: (player, mode) => fired.push([player, mode]) });
  const started = [];
  f.manager.on('trackStart', (_player, track) => started.push(track));
  const writes = f.writes.length;
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'finished', guildId: 'g1', track: f.wire() });
  await settle();
  assert.deepEqual(fired, [[f.player, 'track']]);
  assert.equal(f.writes.slice(writes).filter((write) => write.track?.encoded).length, 0, 'no next track is sent to the audio server');
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ', 'the library did not advance the queue');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.deepEqual(started, []);
  assert.equal(sleepTimer(f.player), null);
});

test('stop after this track never lets autoplay start a pick', async () => {
  const f = fixture();
  let autoplayCalls = 0;
  f.manager.options.playerOptions.onEmptyQueue = { autoPlayFunction: async (player) => { autoplayCalls += 1; await player.queue.add(f.track('Zi_XLOBDo_Y')); } };
  await f.start(f.track(), []);
  const fired = [];
  setSleepTimer(f.player, { afterTrack: true, onFire: (_player, mode) => fired.push(mode) });
  const writes = f.writes.length;
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'finished', guildId: 'g1', track: f.wire() });
  await settle();
  assert.deepEqual(fired, ['track']);
  assert.equal(autoplayCalls, 0);
  assert.equal(f.writes.slice(writes).filter((write) => write.track?.encoded).length, 0);
});

test('stop after this track stays armed through a skip and applies to the track that plays next', async () => {
  const f = fixture();
  await f.start();
  const fired = [];
  setSleepTimer(f.player, { afterTrack: true, onFire: (_player, mode) => fired.push(mode) });
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'stopped', guildId: 'g1', track: f.wire() });
  await settle();
  assert.deepEqual(fired, []);
  assert.deepEqual(sleepTimer(f.player), { mode: 'track' });
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  cancelSleepTimer(f.player);
});

test('destruction cancels a sleep timer before the audio server confirms the teardown', async () => {
  const gate = deferred();
  let held = 0;
  const f = fixture({ request: async (body, endpoint) => { if (/\/players\/g1$/.test(endpoint) && !Object.keys(body).length) { held += 1; await gate.promise; } } });
  await f.start();
  const fired = [];
  setSleepTimer(f.player, { minutes: 1, onFire: () => fired.push('time') });
  const destroying = f.player.destroy('voice-empty-disconnect');
  await settle();
  assert.ok(held >= 1, 'the DELETE is still pending');
  assert.equal(sleepTimer(f.player), null, 'cancelled while the teardown is still pending');
  gate.resolve();
  await destroying;
  assert.deepEqual(fired, []);
});

test('a skip cancels a retry before its backoff completes', async () => {
  const gate = deferred();
  let searches = 0;
  const f = fixture({ delay: () => gate.promise, search: async () => { searches += 1; return { tracks: [f.track()] }; } });
  await f.start();
  const stopped = f.wire();
  await f.node.handleEvent({ type: 'TrackExceptionEvent', guildId: 'g1', track: stopped });
  await f.player.skip();
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'stopped', guildId: 'g1', track: stopped });
  gate.resolve();
  await f.tasks[0];
  await settle();
  assert.equal(searches, 0);
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.failed.length, 0);
});

test('destroy cancels an in-flight lookup and its late answer cannot resurrect the player', async () => {
  const lookup = deferred();
  const entered = deferred();
  const f = fixture({ search: () => { entered.resolve(); return lookup.promise; } });
  await f.start();
  await f.node.handleEvent({ type: 'TrackExceptionEvent', guildId: 'g1', track: f.wire() });
  await entered.promise;
  await f.player.destroy();
  await f.tasks[0];
  lookup.resolve({ tracks: [f.track()] });
  await settle();
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('a recovery write already sent completes before a requested skip write', async () => {
  const writeGate = deferred();
  const replayEntered = deferred();
  let plays = 0;
  const f = fixture({ search: async () => ({ tracks: [f.track()] }), request: async (body) => {
    if (body.track?.encoded && ++plays === 2) {
      replayEntered.resolve();
      await writeGate.promise;
    }
  } });
  await f.start();
  await f.node.handleEvent({ type: 'TrackExceptionEvent', guildId: 'g1', track: f.wire() });
  await replayEntered.promise;
  const skip = f.player.skip();
  await settle();
  assert.equal(f.writes.filter((write) => write.track?.encoded === null).length, 0);
  writeGate.resolve();
  await skip;
  assert.equal(f.writes.at(-1).track.encoded, null);
  await f.tasks[0];
});

test('a destroyed player reference cannot write audio or rejoin even when its guild has a new player', async () => {
  const f = fixture();
  await f.start();
  await f.player.destroy();
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  const writeCount = f.writes.length;
  const gatewayCount = f.gatewayPackets.length;
  for (const operation of [
    () => f.player.play({ clientTrack: f.track() }),
    () => f.player.connect(),
    () => f.player.changeVoiceState({ voiceChannelId: 'v3' }),
    () => f.player.seek(40_000),
    () => f.player.skip(),
  ]) await assert.rejects(operation(), { name: 'AbortError' });
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.gatewayPackets.length, gatewayCount);
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.queue.current, null);
});

test('stale destruction cannot disconnect or delete a replacement player in the same guild', async () => {
  const f = fixture();
  await f.start();
  f.manager.players.delete('g1');
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  const track = f.track('Zi_XLOBDo_Y');
  await replacement.queue.add([track]);
  await replacement.play();
  const writeCount = f.writes.length;
  const gatewayCount = f.gatewayPackets.length;
  assert.notEqual(f.player.getData('internal_destroystatus'), true);
  await f.player.destroy('unused-request-disconnect');
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.queue.current, track);
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.gatewayPackets.length, gatewayCount);
});

test('destruction rechecks guild ownership after waiting behind an audio write', async () => {
  const writeGate = deferred();
  const entered = deferred();
  const f = fixture({ request: async (body) => {
    if (body.track?.encoded) { entered.resolve(); await writeGate.promise; }
  } });
  await f.player.queue.add([f.track()]);
  const playing = f.player.play();
  await entered.promise;
  const destroying = f.player.destroy();
  f.manager.players.delete('g1');
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  writeGate.resolve();
  await Promise.all([playing, destroying]);
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(f.writes.length, 1);
  assert.equal(f.gatewayPackets.length, 0);
});

test('a native destroy gateway rejection still deletes the owned player and emits one old-player cleanup', async () => {
  const f = fixture();
  const events = [];
  let remoteDeletes = 0;
  f.manager.on('playerDestroy', (player) => events.push(player));
  f.manager.options.sendToShard = async () => { throw new Error('Discord gateway unavailable'); };
  f.node.destroyPlayer = async () => { remoteDeletes += 1; };
  const destroying = f.player.destroy('queue-empty-disconnect');
  assert.equal(f.player.destroy('queue-empty-disconnect'), destroying);
  await assert.rejects(destroying, /gateway unavailable/);
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(remoteDeletes, 1);
  assert.deepEqual(events, [f.player]);
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  assert.notEqual(replacement, f.player);
});

test('a native remote destroy rejection still emits exactly one old-player cleanup', async () => {
  const f = fixture();
  const events = [];
  f.manager.on('playerDestroy', (player) => events.push(player));
  f.node.destroyPlayer = async () => { throw new Error('404: Lavalink restarted'); };
  await assert.rejects(f.player.destroy('queue-empty-disconnect'), /Lavalink restarted/);
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.deepEqual(f.gatewayPackets.map((packet) => packet.d.channel_id), [null]);
  assert.deepEqual(events, [f.player]);
  await f.player.destroy('queue-empty-disconnect');
  assert.deepEqual(events, [f.player]);
});

function controlledDeadline() {
  const pending = new Map();
  return {
    timers: {
      setTimeout: (action) => { const timer = {}; pending.set(timer, action); return timer; },
      clearTimeout: (timer) => pending.delete(timer),
    },
    expire: () => { for (const action of [...pending.values()]) action(); },
  };
}

test('a delayed remote destroy has a bounded deadline and never deletes its replacement', async () => {
  const clock = controlledDeadline();
  const f = fixture({ timers: clock.timers });
  const gate = deferred();
  const entered = deferred();
  const events = [];
  f.manager.on('playerDestroy', (player) => events.push(player));
  f.node.destroyPlayer = async () => { entered.resolve(); await gate.promise; };
  const destroying = f.player.destroy('queue-empty-disconnect');
  await entered.promise;
  f.manager.players.delete('g1');
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  const track = f.track('Zi_XLOBDo_Y');
  await replacement.play({ clientTrack: track });
  clock.expire();
  await assert.rejects(destroying, /timed out/);
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.queue.current, track);
  assert.deepEqual(events, [f.player]);
  gate.resolve();
  await settle();
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.deepEqual(events, [f.player]);
});

test('destroy deadline includes a stalled audio lane and fences its late teardown from a replacement', async () => {
  const clock = controlledDeadline();
  const gate = deferred();
  const entered = deferred();
  let plays = 0;
  let remoteDeletes = 0;
  const f = fixture({ timers: clock.timers, request: async (body) => {
    if (body.track?.encoded && ++plays === 1) { entered.resolve(); await gate.promise; }
  } });
  f.node.destroyPlayer = async () => { remoteDeletes += 1; };
  const playing = f.player.play({ clientTrack: f.track() });
  await entered.promise;
  const destroying = f.player.destroy('queue-empty-disconnect');
  await settle();
  clock.expire();
  await assert.rejects(destroying, /timed out/);
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.deepEqual(f.gatewayPackets.map((packet) => packet.d.channel_id), [null]);
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  const track = f.track('Zi_XLOBDo_Y');
  await replacement.play({ clientTrack: track });
  gate.resolve();
  await playing;
  await settle();
  assert.equal(remoteDeletes, 0);
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.queue.current, track);
});

test('an empty player in a fresh Lavalink session clears stale voice and preserves its pending queue', async () => {
  const f = fixture();
  const upcoming = f.track('Zi_XLOBDo_Y');
  await f.player.queue.add(upcoming);
  f.recovery.nodeDisconnected(f.node);
  f.node.sessionId = 'session-2';
  await f.recovery.nodeReady(f.node, { resumed: false, sessionId: 'session-2' });
  assert.equal(f.player.connected, false);
  assert.deepEqual(f.player.voice, {});
  assert.deepEqual(f.player.queue.tracks, [upcoming]);
  assert.equal(f.gatewayPackets.length, 0);
  await f.player.connect();
  assert.equal(f.gatewayPackets.length, 1);
  assert.equal(f.writes.at(-1).voice.channelId, 'v1');
  assert.equal(f.writes.at(-1).voice.sessionId, 'fresh-voice-session');
});

for (const remoteState of ['missing', 'disconnected', 'connected']) {
  test(`an empty resumed player reconciles ${remoteState} remote voice without automatic join`, async () => {
    const f = fixture();
    f.recovery.nodeDisconnected(f.node);
    const oldVoice = { ...f.player.voice };
    f.node.fetchAllPlayers = async () => remoteState === 'missing' ? [] : [{ guildId: 'g1', track: null,
      state: { connected: remoteState === 'connected', position: 0 } }];
    await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
    assert.equal(f.player.connected, remoteState === 'connected');
    assert.deepEqual(f.player.voice, remoteState === 'connected' ? oldVoice : {});
    assert.equal(f.gatewayPackets.length, 0);
  });
}

test('late idle nodeReady cannot reset voice after a new play changes its generation', async () => {
  const f = fixture();
  const gate = deferred();
  f.recovery.nodeDisconnected(f.node);
  f.node.updateSession = async () => { await gate.promise; };
  f.node.sessionId = 'session-2';
  const ready = f.recovery.nodeReady(f.node, { resumed: false, sessionId: 'session-2' });
  await settle();
  const track = f.track();
  await f.player.play({ clientTrack: track });
  const voice = { ...f.player.voice };
  gate.resolve();
  await ready;
  assert.equal(f.player.connected, true);
  assert.deepEqual(f.player.voice, voice);
  assert.equal(f.player.queue.current, track);
});

test('late idle nodeReady cannot reset a different player now owning the same guild', async () => {
  const f = fixture();
  const gate = deferred();
  f.recovery.nodeDisconnected(f.node);
  f.node.updateSession = async () => { await gate.promise; };
  f.node.sessionId = 'session-2';
  const ready = f.recovery.nodeReady(f.node, { resumed: false, sessionId: 'session-2' });
  await settle();
  f.manager.players.delete('g1');
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  replacement.connected = true;
  replacement.voice = { channelId: 'v2', sessionId: 'new-session', endpoint: 'new.example', token: 'new-test-token' };
  const voice = { ...replacement.voice };
  gate.resolve();
  await ready;
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.connected, true);
  assert.deepEqual(replacement.voice, voice);
});

test('a stopping player rejects playback methods while stopPlaying and destroy still complete', async () => {
  const f = fixture();
  await f.start();
  f.player.setData('vybertron.stopping', true);
  const writeCount = f.writes.length;
  for (const operation of [
    () => f.player.play(), () => f.player.connect(),
    () => f.player.changeVoiceState({ voiceChannelId: 'v2' }),
    () => f.player.seek(40_000), () => f.player.skip(),
  ]) await assert.rejects(operation(), { name: 'AbortError' });
  assert.equal(f.writes.length, writeCount);
  assert.equal(f.gatewayPackets.length, 0);
  await f.player.stopPlaying(true, false);
  assert.equal(f.writes.at(-1).track.encoded, null);
  await f.player.destroy();
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.deepEqual(f.gatewayPackets.map((packet) => packet.d.channel_id), [null]);
});

for (const action of ['play', 'seek', 'skip']) {
  test(`a ${action} queued behind an audio write rechecks the urgent stop marker inside its lane`, async () => {
    const writeGate = deferred();
    const entered = deferred();
    const f = fixture({ request: async (body) => {
      if (body.track?.encoded) { entered.resolve(); await writeGate.promise; }
    } });
    await f.player.queue.add([f.track(), f.track('Zi_XLOBDo_Y')]);
    const playing = f.player.play();
    await entered.promise;
    const queued = action === 'play' ? f.player.play({ clientTrack: f.track('aqz-KE-bpKQ') })
      : action === 'seek' ? f.player.seek(40_000) : f.player.skip();
    const rejected = assert.rejects(queued, { name: 'AbortError' });
    f.player.setData('vybertron.stopping', true);
    const stopping = f.player.stopPlaying(true, false);
    writeGate.resolve();
    await Promise.all([playing, rejected, stopping]);
    assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes.at(-1).track.encoded, null);
    assert.equal(f.writes.some((write) => write.position === 40_000), false);
  });
}

test('destroy intent cancels deferred-lane playback before native destruction reaches the lane', async () => {
  const writeGate = deferred();
  const entered = deferred();
  const f = fixture({ request: async (body) => {
    if (body.track?.encoded) { entered.resolve(); await writeGate.promise; }
  } });
  await f.player.queue.add([f.track()]);
  const playing = f.player.play();
  await entered.promise;
  const late = f.player.play({ clientTrack: f.track('Zi_XLOBDo_Y') });
  const rejected = assert.rejects(late, { name: 'AbortError' });
  const destroying = f.player.destroy();
  writeGate.resolve();
  await Promise.all([playing, rejected, destroying]);
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('native play awaiting queue persistence rechecks stopping at its eventual REST write', async () => {
  const saved = deferred();
  const entered = deferred();
  const f = fixture();
  await f.player.queue.add([f.track()]);
  f.player.queue.utils.save = async () => { entered.resolve(); await saved.promise; };
  const playing = f.player.play();
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await entered.promise;
  f.player.setData('vybertron.stopping', true);
  const stopping = f.player.stopPlaying(true, false);
  saved.resolve();
  await Promise.all([rejected, stopping]);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 0);
  assert.equal(f.writes.at(-1).track.encoded, null);
});

test('native play awaiting persistence cannot write through a replacement guild player', async () => {
  const saved = deferred();
  const entered = deferred();
  const f = fixture();
  await f.player.queue.add([f.track()]);
  f.player.queue.utils.save = async () => { entered.resolve(); await saved.promise; };
  const playing = f.player.play();
  const rejected = assert.rejects(playing, { name: 'AbortError' });
  await entered.promise;
  f.manager.players.delete('g1');
  const replacement = f.manager.createPlayer({ guildId: 'g1', voiceChannelId: 'v2', node: 'main' });
  saved.resolve();
  await rejected;
  assert.equal(f.writes.length, 0);
  assert.equal(f.gatewayPackets.length, 0);
  assert.equal(f.manager.getPlayer('g1'), replacement);
  assert.equal(replacement.queue.current, null);
});

for (const action of ['connect', 'move']) {
  test(`stopping before the ${action} gateway-send microtask prevents voice resurrection`, async () => {
    const f = fixture({ voiceGateway: false });
    const pending = action === 'connect' ? f.player.connect()
      : f.player.changeVoiceState({ voiceChannelId: 'v2' });
    f.player.setData('vybertron.stopping', true);
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(f.gatewayPackets.length, 0);
    assert.equal(f.writes.length, 0);
    assert.equal(f.failed.length, 0);
  });
}

test('retry allowance survives a replay start and a bad recording does not loop forever', async () => {
  const f = fixture({ search: async () => ({ tracks: [f.track()] }) });
  await f.start();
  await f.player.setRepeatMode('queue');
  await f.error();
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  await f.error();
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.player.queue.tracks.length, 0);
  assert.equal(f.failed.length, 1);
  assert.equal(f.recovery.summary().retries, 1);
  assert.equal(f.player.repeatMode, 'queue');
});

test('known permanent unavailability skips once without repeated network lookups', async () => {
  let searches = 0;
  const f = fixture({ search: async () => { searches += 1; return { tracks: [] }; } });
  await f.start();
  const ended = f.wire();
  await f.error({ exception: { message: 'This is a private video.' } });
  await f.node.handleEvent({ type: 'TrackEndEvent', reason: 'loadFailed', guildId: 'g1', track: ended });
  assert.equal(searches, 0);
  assert.equal(f.failed.length, 1);
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
});

test('a failed terminal stop request keeps the whole queue and permits an explicit replay', async () => {
  const f = fixture({ request: async (body) => {
    if (body.track?.encoded === null) throw new Error('Temporary REST stop failure');
  } });
  const current = await f.start();
  const queued = [...f.player.queue.tracks];
  await f.error({ exception: { message: 'This video was removed', severity: 'common' } });
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.connected, true);
  assert.equal(f.player.queue.current, current);
  assert.deepEqual(f.player.queue.tracks, queued);
  assert.equal(f.failed.length, 1);
  assert.equal(f.failed[0][2].transport, true);
  await f.player.play();
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 2);
});

test('wrong exact-lookup results never replace the requested recording', async () => {
  const f = fixture({ search: async () => ({ tracks: [f.track('Zi_XLOBDo_Y')] }) });
  await f.start(f.track(), []);
  await f.error();
  assert.equal(f.player.queue.current, null);
  assert.equal(f.failed.length, 1);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('a source circuit preserves the remaining queue instead of consuming an outage playlist', async () => {
  const f = fixture();
  const upcoming = [f.track('Zi_XLOBDo_Y'), f.track('aqz-KE-bpKQ'), f.track('9bZkp7q19f0'), f.track('kJQP7kiw5Fk')];
  await f.start(f.track(), upcoming);
  for (let count = 0; count < 3; count += 1) {
    await f.error({ exception: { message: 'Temporary source failure' } });
    if (f.player.queue.current) await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  }
  assert.equal(f.player.queue.current, null);
  assert.deepEqual(f.player.queue.tracks.map((track) => track.info.identifier), ['9bZkp7q19f0', 'kJQP7kiw5Fk']);
  assert.equal(f.recovery.summary().circuitTrips, 1);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 3);
});

test('a hung source lookup is bounded and a late success cannot change the queue', async () => {
  const lookup = deferred();
  const f = fixture({ requestTimeoutMs: 10, search: () => lookup.promise });
  await f.start();
  await f.error();
  lookup.resolve({ tracks: [f.track()] });
  await settle();
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.recovery.summary().retries, 0);
});

test('resumable reconnect uses seconds and retains remote progress without replaying audio', async () => {
  const f = fixture();
  await f.start();
  const remoteTrack = f.wire();
  f.recovery.nodeDisconnected(f.node);
  assert.equal(f.node.options.sessionId, 'session-1');
  f.node.fetchAllPlayers = async () => [{ guildId: 'g1', track: remoteTrack,
    paused: true, state: { position: 55_000, connected: true } }];
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  assert.equal(f.writes.find((write) => write.resuming).timeout, 120);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
  assert.equal(f.player.lastPosition, 55_000);
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playing, false);
  assert.equal(f.resumed.length, 1);
});

for (const operation of ['updateSession', 'fetchAllPlayers']) {
  test(`resumed node ${operation} rejection exits recovery with a visible failure and intact queue`, async () => {
    const f = fixture();
    const current = await f.start();
    const queued = [...f.player.queue.tracks];
    f.recovery.nodeDisconnected(f.node);
    f.node[operation] = async () => { throw new Error('Temporary reconciliation failure'); };
    await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
    assert.equal(f.recovery.isRecovering(f.player), false);
    assert.equal(f.player.playing, false);
    assert.equal(f.node.connected, true);
    assert.equal(f.player.queue.current, current);
    assert.deepEqual(f.player.queue.tracks, queued);
    assert.equal(f.failed.length, 1);
    assert.equal(f.failed[0][2].transport, true);
    assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
  });
}

test('a stalled node reconciliation request has a finite failure deadline', async () => {
  const f = fixture({ requestTimeoutMs: 10 });
  const current = await f.start();
  f.recovery.nodeDisconnected(f.node);
  f.node.fetchAllPlayers = () => new Promise(() => {});
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.queue.current, current);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.failed.length, 1);
});

test('a superseded node snapshot is not marked failed by a later reconciliation rejection', async () => {
  const request = deferred();
  const entered = deferred();
  const f = fixture();
  await f.start();
  f.recovery.nodeDisconnected(f.node);
  f.node.updateSession = () => { entered.resolve(); return request.promise; };
  const reconnect = f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  await entered.promise;
  await f.player.play({ clientTrack: f.track('Zi_XLOBDo_Y') });
  request.resolve(Promise.reject(new Error('Late reconciliation failure')));
  await reconnect;
  assert.equal(f.failed.length, 0);
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
});

test('a fresh node session recreates the existing track, filters, volume, and pause position', async () => {
  const f = fixture();
  await f.start();
  f.player.lastPosition = 27_000;
  f.player.paused = true;
  f.player.filterManager.data.timescale = { speed: 1.1, pitch: 1, rate: 1 };
  f.player.filterManager.equalizerBands = [{ band: 0, gain: 0.2 }];
  f.recovery.nodeDisconnected(f.node);
  f.node.sessionId = 'session-2';
  await f.recovery.nodeReady(f.node, { resumed: false, sessionId: 'session-2' });
  const replay = f.writes.filter((write) => write.track?.encoded).at(-1);
  assert.equal(replay.position, 27_000);
  assert.equal(replay.paused, true);
  assert.equal(replay.volume, 57);
  assert.equal(replay.filters.timescale.speed, 1.1);
  assert.deepEqual(replay.filters.equalizer, [{ band: 0, gain: 0.2 }]);
  assert.equal(replay.voice.token, 'fresh-test-token');
  assert.equal(replay.voice.channelId, 'v1');
  assert.equal(replay.voice.sessionId, 'fresh-voice-session');
  assert.equal(f.player.queue.tracks.length, 1);
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  assert.equal(f.player.paused, true);
});

test('explicit cancellation after disconnect prevents stale node restoration', async () => {
  const f = fixture();
  await f.start();
  f.recovery.nodeDisconnected(f.node);
  invalidatePlaybackRecovery(f.player);
  f.node.sessionId = 'session-2';
  await f.recovery.nodeReady(f.node, { resumed: false, sessionId: 'session-2' });
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('private playlist entries do not trip an outage circuit for an otherwise healthy source', async () => {
  const f = fixture();
  await f.start(f.track(), [f.track('Zi_XLOBDo_Y'), f.track('aqz-KE-bpKQ'), f.track('9bZkp7q19f0')]);
  for (let count = 0; count < 3; count += 1) await f.error({ exception: { message: 'Private video' } });
  assert.equal(f.recovery.summary().circuitTrips, 0);
  assert.equal(f.player.queue.current.info.identifier, '9bZkp7q19f0');
});

for (const voiceEventOrder of ['server-first', 'state-first']) {
  test(`initial native connect accepts ${voiceEventOrder} voice updates without old credentials`, async () => {
    const f = fixture({ voiceEventOrder });
    f.player.connected = false;
    f.player.voice = {};
    const queued = [f.track(), f.track('Zi_XLOBDo_Y')];
    await f.player.queue.add(queued);
    await f.player.connect();
    assert.equal(f.gatewayPackets.length, 1);
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0].voice, { channelId: 'v1', sessionId: 'fresh-voice-session',
      token: 'fresh-test-token', endpoint: 'voice-fresh.example' });
    assert.equal(f.player.queue.current, null);
    assert.deepEqual(f.player.queue.tracks, queued);
    await f.player.play();
    assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
  });

  test(`native channel move accepts ${voiceEventOrder} updates and patches the new channel only`, async () => {
    const f = fixture({ voiceEventOrder });
    await f.start();
    await f.player.changeVoiceState({ voiceChannelId: 'v2' });
    const voices = f.writes.filter((write) => write.voice);
    assert.equal(voices.length, 1);
    assert.deepEqual(voices[0].voice, { channelId: 'v2', sessionId: 'fresh-voice-session',
      token: 'fresh-test-token', endpoint: 'voice-fresh.example' });
    assert.equal(f.player.voiceChannelId, 'v2');
    assert.equal(f.player.queue.tracks.length, 1);
  });

  test(`external channel move accepts ${voiceEventOrder} updates without issuing an automatic rejoin`, async () => {
    const f = fixture();
    await f.start();
    const server = { t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
      token: 'external-token', endpoint: 'voice-new.example' } };
    const state = { t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '123',
      channel_id: 'v2', session_id: 'external-session' } };
    for (const packet of voiceEventOrder === 'state-first' ? [state, server] : [server, state]) await f.forward(packet);
    await settle();
    const voices = f.writes.filter((write) => write.voice);
    assert.equal(voices.length, 1);
    assert.deepEqual(voices[0].voice, { channelId: 'v2', sessionId: 'external-session',
      token: 'external-token', endpoint: 'voice-new.example' });
    assert.equal(f.gatewayPackets.length, 0);
    assert.equal(f.player.voiceChannelId, 'v2');
  });
}

test('initial connect without a complete gateway pair fails within its deadline and keeps queued tracks', async () => {
  const f = fixture({ voiceGateway: false, requestTimeoutMs: 10 });
  f.player.voice = {};
  f.player.connected = false;
  await f.player.queue.add([f.track(), f.track('Zi_XLOBDo_Y')]);
  const connect = f.player.connect();
  await settle();
  // A server token alone must never be combined with absent or old state.
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1', token: 'server-only', endpoint: 'voice.example' } });
  await assert.rejects(connect, /timed out/);
  assert.equal(f.player.queue.tracks.length, 2);
  assert.equal(f.player.queue.current, null);
  assert.equal(f.player.connected, false);
  assert.equal(f.player.playing, false);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.gatewayPackets.length, 1);
  assert.equal(f.failed.length, 1);
});

test('a gateway kick cancels initial native connect and keeps native destruction semantics', async () => {
  const f = fixture({ voiceGateway: false });
  f.player.voice = {};
  const connect = f.player.connect();
  const rejected = assert.rejects(connect, { name: 'AbortError' });
  await settle();
  await f.forward({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '123',
    channel_id: null, session_id: 'kicked-session' } });
  await rejected;
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.deepEqual(f.gatewayPackets.map((packet) => packet.d.channel_id), ['v1', null]);
});

test('late gateway updates for a stopping player are inert and cannot start a passive handshake', async () => {
  const f = fixture();
  await f.start();
  f.player.setData('vybertron.stopping', true);
  const writes = f.writes.length;
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'late-token', endpoint: 'late-voice.example' } });
  await f.forward({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '123',
    channel_id: 'v2', session_id: 'late-session' } });
  await settle();
  assert.equal(f.writes.length, writes);
  assert.equal(f.gatewayPackets.length, 0);
  assert.equal(f.failed.length, 0);
});

test('same-channel server-only failover refreshes voice with the unchanged established session', async () => {
  const f = fixture({ requestTimeoutMs: 80, voiceServerGraceMs: 1 });
  const current = await f.start();
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'failover-token', endpoint: 'voice-new.example' } });
  await sleep(20);
  const voices = f.writes.filter((write) => write.voice);
  assert.equal(voices.length, 1);
  assert.deepEqual(voices[0].voice, { channelId: 'v1', sessionId: 'voice-session',
    token: 'failover-token', endpoint: 'voice-new.example' });
  assert.equal(f.player.queue.current, current);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.player.playing, true);
  assert.equal(f.failed.length, 0);
  assert.equal(f.gatewayPackets.length, 0);
  assert.equal(f.resumed.length, 1);
});

test('server-only updates never complete an explicit join using the previous established session', async () => {
  const f = fixture({ voiceGateway: false, requestTimeoutMs: 10, voiceServerGraceMs: 1 });
  const connect = f.player.connect();
  const rejected = assert.rejects(connect, /timed out/);
  await settle();
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'join-token', endpoint: 'voice-join.example' } });
  await rejected;
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.gatewayPackets.length, 1);
});

test('a changed playback generation cancels reuse of an established failover session', async () => {
  const f = fixture({ requestTimeoutMs: 25, voiceServerGraceMs: 5 });
  await f.start();
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'failover-token', endpoint: 'voice-new.example' } });
  await f.player.play({ clientTrack: f.track('Zi_XLOBDo_Y') });
  await sleep(40);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.failed.length, 1);
});

test('null voice allocation waits for a non-null endpoint and preserves pause without rejoining', async () => {
  const f = fixture({ requestTimeoutMs: 100, voiceServerGraceMs: 1 });
  await f.start();
  await f.player.pause();
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1', token: 'allocation-token', endpoint: null } });
  await f.recovery.handleVoiceClosed(f.player, { code: 1006 });
  await sleep(20);
  assert.equal(f.player.connected, false);
  assert.equal(f.player.playing, false);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.gatewayPackets.length, 0);
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'allocated-token', endpoint: 'voice-allocated.example' } });
  await sleep(20);
  const voices = f.writes.filter((write) => write.voice);
  assert.equal(voices.length, 1);
  assert.deepEqual(voices[0].voice, { channelId: 'v1', sessionId: 'voice-session',
    token: 'allocated-token', endpoint: 'voice-allocated.example' });
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playing, false);
  assert.equal(f.failed.length, 0);
  assert.equal(f.player.queue.tracks.length, 1);
});

test('voice allocation that never returns fails visibly within its deadline without reconnecting', async () => {
  const f = fixture({ requestTimeoutMs: 10 });
  await f.start();
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1', token: 'allocation-token', endpoint: null } });
  await sleep(25);
  assert.equal(f.failed.length, 1);
  assert.equal(f.player.connected, false);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.gatewayPackets.length, 0);
});

test('a rejected native gateway send clears the handshake timer immediately', async () => {
  const activeTimers = new Set();
  const f = fixture({ timers: {
    setTimeout: (action, ms) => {
      const timer = setTimeout(action, ms);
      activeTimers.add(timer);
      return timer;
    },
    clearTimeout: (timer) => { activeTimers.delete(timer); clearTimeout(timer); },
  } });
  f.manager.options.sendToShard = async () => { throw new Error('Gateway unavailable'); };
  await assert.rejects(f.player.connect(), /Gateway unavailable/);
  assert.equal(activeTimers.size, 0);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
  assert.equal(f.failed.length, 1);
});

test('destroy cancels a resolved passive voice pair waiting behind an audio write', async () => {
  const writeGate = deferred();
  const entered = deferred();
  const f = fixture({ request: async (body) => {
    if (body.track?.encoded) { entered.resolve(); await writeGate.promise; }
  } });
  await f.player.queue.add([f.track()]);
  const playing = f.player.play();
  await entered.promise;
  await f.forward({ t: 'VOICE_SERVER_UPDATE', d: { guild_id: 'g1',
    token: 'external-token', endpoint: 'voice-new.example' } });
  await f.forward({ t: 'VOICE_STATE_UPDATE', d: { guild_id: 'g1', user_id: '123',
    channel_id: 'v2', session_id: 'external-session' } });
  await settle();
  const destroying = f.player.destroy();
  writeGate.resolve();
  await Promise.all([playing, destroying]);
  await settle();
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(f.writes.filter((write) => write.voice).length, 0);
});

test('a late native TrackStart preserves pause requested after play', async () => {
  const f = fixture();
  await f.player.queue.add([f.track()]);
  await f.player.play();
  await f.player.pause();
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playing, false);
  assert.equal(f.writes.at(-1).paused, true);
});

test('a paused checkpoint play stays paused through its native TrackStart', async () => {
  const f = fixture();
  const first = f.track();
  await f.player.play({ clientTrack: first, position: 47_000, paused: true });
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  assert.equal(f.player.paused, true);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.lastPosition, 47_000);
  assert.equal(f.writes.length, 1);
});

for (const sameAttempt of [true, false]) {
  test(`resumed node with disconnected voice requests fresh credentials for ${sameAttempt ? 'the current' : 'an older'} attempt`, async () => {
    const f = fixture();
    await f.start();
    f.player.lastPosition = 22_000;
    f.player.paused = true;
    f.player.filterManager.data.timescale = { speed: 1.1, pitch: 1, rate: 1 };
    const remoteTrack = f.wire();
    if (!sameAttempt) remoteTrack.userData[ATTEMPT_KEY] = 'previous-attempt';
    f.recovery.nodeDisconnected(f.node);
    f.node.fetchAllPlayers = async () => [{ guildId: 'g1', track: remoteTrack,
      paused: sameAttempt, state: { position: 55_000, connected: false } }];
    await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
    const plays = f.writes.filter((write) => write.track?.encoded);
    assert.equal(plays.length, 2);
    assert.equal(plays[1].position, sameAttempt ? 55_000 : 22_000);
    assert.equal(plays[1].paused, true);
    assert.equal(plays[1].filters.timescale.speed, 1.1);
    assert.deepEqual(plays[1].voice, { channelId: 'v1', sessionId: 'fresh-voice-session',
      token: 'fresh-test-token', endpoint: 'voice-fresh.example' });
    assert.equal(f.gatewayPackets.length, 1);
    assert.equal(f.resumed.length, 0);
    await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
    assert.equal(f.player.paused, true);
    assert.equal(f.player.playing, false);
    assert.equal(f.recovery.isRecovering(f.player), false);
  });
}

test('resumed node disconnected voice has a bounded handshake failure with the whole queue preserved', async () => {
  const f = fixture({ voiceGateway: false, requestTimeoutMs: 10 });
  await f.start();
  const remoteTrack = f.wire();
  f.recovery.nodeDisconnected(f.node);
  f.node.fetchAllPlayers = async () => [{ guildId: 'g1', track: remoteTrack,
    paused: false, state: { position: 55_000, connected: false } }];
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.player.playing, false);
  assert.equal(f.player.connected, false);
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.failed.length, 1);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

for (const voiceConnected of [true, false]) {
  test(`resumed node missing its remote track refreshes the exact recording with ${voiceConnected ? 'connected' : 'fresh'} voice`, async () => {
    let fresh;
    const f = fixture({ search: async (_player, query) => {
      assert.equal(query.query, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      return { tracks: [fresh] };
    } });
    const original = await f.start();
    fresh = f.track();
    fresh.encoded = 'fresh-catalog-encoding';
    f.player.lastPosition = 32_000;
    f.player.paused = true;
    f.player.filterManager.data.timescale = { speed: 1.1, pitch: 1, rate: 1 };
    f.recovery.nodeDisconnected(f.node);
    f.node.fetchAllPlayers = async () => voiceConnected
      ? [{ guildId: 'g1', track: null, state: { connected: true } }] : [];
    await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
    const plays = f.writes.filter((write) => write.track?.encoded);
    assert.equal(plays.length, 2);
    assert.equal(plays[1].track.encoded, 'fresh-catalog-encoding');
    assert.equal(plays[1].position, 32_000);
    assert.equal(plays[1].paused, true);
    assert.equal(plays[1].volume, 57);
    assert.equal(plays[1].filters.timescale.speed, 1.1);
    assert.equal(f.player.queue.current.requester, original.requester);
    assert.equal(f.player.queue.tracks.length, 1);
    assert.equal(f.recovery.isRecovering(f.player), false);
    assert.equal(f.gatewayPackets.length, voiceConnected ? 0 : 1);
    if (!voiceConnected) assert.equal(plays[1].voice.token, 'fresh-test-token');
    await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
    assert.equal(f.player.paused, true);
    assert.equal(f.player.playing, false);
  });
}

test('missing remote track with failed exact lookup preserves the current recording and exits recovery', async () => {
  const f = fixture();
  const original = await f.start();
  f.recovery.nodeDisconnected(f.node);
  f.node.fetchAllPlayers = async () => [];
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  assert.equal(f.player.queue.current, original);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.player.playing, false);
  assert.equal(f.failed.length, 1);
  assert.equal(f.gatewayPackets.length, 0);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('missing remote track bounds a stalled catalog lookup and discards its late result', async () => {
  const lookup = deferred();
  const f = fixture({ requestTimeoutMs: 10, search: () => lookup.promise });
  const original = await f.start();
  f.recovery.nodeDisconnected(f.node);
  f.node.fetchAllPlayers = async () => [];
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  lookup.resolve({ tracks: [f.track()] });
  await settle();
  assert.equal(f.player.queue.current, original);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.failed.length, 1);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

for (const action of ['finished', 'stop', 'skip']) {
  test(`${action} supersedes the missing-remote-track lookup without a stale replay`, async () => {
    const lookup = deferred();
    const entered = deferred();
    const f = fixture({ search: () => { entered.resolve(); return lookup.promise; } });
    await f.start();
    const ended = f.wire();
    f.recovery.nodeDisconnected(f.node);
    f.node.fetchAllPlayers = async () => [];
    const reconnect = f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
    await entered.promise;
    if (action === 'stop') await f.player.stopPlaying(true, false);
    if (action === 'skip') await f.player.skip();
    await f.node.handleEvent({ type: 'TrackEndEvent', guildId: 'g1', track: ended,
      reason: action === 'finished' ? 'finished' : 'stopped' });
    await reconnect;
    lookup.resolve({ tracks: [f.track()] });
    await settle();
    assert.equal(f.recovery.isRecovering(f.player), false);
    assert.equal(f.failed.length, 0);
    assert.equal(f.gatewayPackets.length, 0);
    const plays = f.writes.filter((write) => write.track?.encoded);
    assert.equal(plays.length, action === 'stop' ? 1 : 2);
    assert.equal(f.player.queue.current?.info.identifier, action === 'stop' ? undefined : 'Zi_XLOBDo_Y');
  });
}

test('missing remote track bounds its replacement write without consuming the upcoming queue', async () => {
  const writeGate = deferred();
  let plays = 0;
  const f = fixture({ requestTimeoutMs: 10, search: async () => ({ tracks: [f.track()] }),
    request: async (body) => { if (body.track?.encoded && ++plays === 2) await writeGate.promise; } });
  await f.start();
  f.recovery.nodeDisconnected(f.node);
  f.node.fetchAllPlayers = async () => [{ guildId: 'g1', track: null, state: { connected: true } }];
  await f.recovery.nodeReady(f.node, { resumed: true, sessionId: 'session-1' });
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.isRecovering(f.player), false);
  assert.equal(f.player.playing, false);
  assert.equal(f.failed.length, 1);
  writeGate.resolve();
  await settle();
});

test('seek cancels a pending retry but a subsequent current-attempt stall can still recover', async () => {
  const lookup = deferred();
  const entered = deferred();
  let searches = 0;
  const f = fixture({ search: () => {
    searches += 1;
    if (searches === 1) { entered.resolve(); return lookup.promise; }
    return Promise.resolve({ tracks: [f.track()] });
  } });
  await f.start();
  const stale = f.wire();
  await f.node.handleEvent({ type: 'TrackExceptionEvent', guildId: 'g1', track: stale });
  await entered.promise;
  await f.player.seek(71_000);
  await f.tasks[0];
  await f.recovery.handleFailure(f.player, f.player.queue.current, { type: 'WatchdogStall' });
  lookup.resolve({ tracks: [f.track()] });
  await settle();
  const plays = f.writes.filter((write) => write.track?.encoded);
  assert.equal(plays.length, 2);
  assert.equal(plays[1].position, 71_000);
  assert.equal(searches, 2);
  assert.equal(f.recovery.summary().retries, 1);
  assert.equal(f.player.queue.tracks.length, 1);
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: stale });
  assert.equal(f.recovery.summary().staleEvents, 1);
});

test('actual Discord voice forwarding includes the DAVE-required channelId', async () => {
  const f = fixture();
  f.manager.initiated = true;
  f.player.voice = {};
  await f.manager.sendRawData({ t: 'VOICE_STATE_UPDATE', d: {
    guild_id: 'g1', user_id: '123', channel_id: 'v1', session_id: 'new-voice-session',
  } });
  await f.manager.sendRawData({ t: 'VOICE_SERVER_UPDATE', d: {
    guild_id: 'g1', endpoint: 'voice.example', token: 'new-test-token',
  } });
  const packet = f.writes.find((write) => write.voice);
  assert.deepEqual(packet.voice, { channelId: 'v1', sessionId: 'new-voice-session',
    endpoint: 'voice.example', token: 'new-test-token' });
});

test('recoverable Discord voice closure performs a fresh handshake and keeps the queue', async () => {
  const f = fixture();
  await f.start();
  f.player.lastPosition = 65_000;
  await f.recovery.handleVoiceClosed(f.player, { code: 4006 });
  const replay = f.writes.filter((write) => write.track?.encoded).at(-1);
  assert.equal(replay.position, 65_000);
  assert.equal(replay.voice.sessionId, 'fresh-voice-session');
  assert.equal(replay.voice.token, 'fresh-test-token');
  assert.equal(replay.voice.channelId, 'v1');
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.recovery.summary().voiceReconnects, 1);
});

test('removed/kicked and encryption-incompatible voice sessions never trigger automatic rejoin', async () => {
  for (const code of [4014, 4016, 4017, 4004]) {
    const f = fixture();
    await f.start();
    await f.recovery.handleVoiceClosed(f.player, { code });
    assert.equal(f.gatewayPackets.length, 0);
    assert.equal(f.failed.length, 1);
    assert.equal(f.player.queue.tracks.length, 1);
  }
});

test('stop during an unanswered voice handshake cancels reconnect without resurrection', async () => {
  const f = fixture({ voiceGateway: false });
  await f.start();
  const reconnect = f.recovery.handleVoiceClosed(f.player, { code: 4015 });
  await settle();
  assert.equal(f.gatewayPackets.length, 1);
  await f.player.destroy();
  await reconnect;
  assert.equal(f.manager.getPlayer('g1'), undefined);
  assert.equal(f.writes.filter((write) => write.track?.encoded).length, 1);
});

test('an unanswered gateway handshake is bounded and retains the queue', async () => {
  const f = fixture({ voiceGateway: false, requestTimeoutMs: 10 });
  await f.start();
  await f.recovery.handleVoiceClosed(f.player, { code: 4006 });
  assert.equal(f.failed.length, 1);
  assert.equal(f.player.queue.tracks.length, 1);
  assert.equal(f.player.queue.current.info.identifier, 'dQw4w9WgXcQ');
  assert.equal(f.recovery.isRecovering(f.player), false);
});

test('voice reconnection has a bounded budget even if repeated starts appear successful', async () => {
  const f = fixture();
  await f.start();
  for (let count = 0; count < 3; count += 1) {
    await f.recovery.handleVoiceClosed(f.player, { code: 4006 });
    if (count < 2) await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  }
  assert.equal(f.recovery.summary().voiceReconnects, 2);
  assert.equal(f.failed.length, 1);
  assert.equal(f.player.queue.tracks.length, 1);
});

test('recording matching rejects remixes, streams, duration mismatch, and alternate direct videos', () => {
  const original = { encoded: 'spotify', info: { title: 'Song', author: 'Artist', sourceName: 'spotify', duration: 200_000 } };
  const candidate = { encoded: 'mirror', info: { title: 'Song', author: 'Artist - Topic', sourceName: 'youtube', duration: 201_000 } };
  assert.equal(sameRecording(original, candidate), true);
  assert.equal(sameRecording(original, { ...candidate, info: { ...candidate.info, title: 'Song (Remix)' } }), false);
  assert.equal(sameRecording(original, { ...candidate, info: { ...candidate.info, duration: 220_000 } }), false);
  assert.equal(sameRecording(original, { ...candidate, info: { ...candidate.info, isStream: true } }), false);
  assert.equal(sameRecording({ ...original, info: { ...original.info, sourceName: 'youtube' } }, candidate), false);
  assert.equal(sameRecording({ ...original, info: { ...original.info, isrc: 'USABC2600001' } },
    { ...candidate, info: { ...candidate.info, isrc: 'USABC2600001' } }), true);
});

test('exact refresh strips playlists from a video request and rejects unsupported URI protocols', () => {
  assert.equal(exactTrackQuery({ info: { sourceName: 'youtube', identifier: 'dQw4w9WgXcQ',
    uri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=playlist' } }),
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(exactTrackQuery({ info: { uri: 'file:///etc/passwd' } }), null);
});

// ADR-0017: a song whose upload can't play tries its other verified sources.
function alternatesFixture(alternateIds, playable = alternateIds) {
  const results = [];
  const watch = id => `https://www.youtube.com/watch?v=${id}`;
  const f = fixture({
    alternates: track => (track.info.identifier === 'dQw4w9WgXcQ' ? ['dQw4w9WgXcQ', ...alternateIds] : [])
      .map(id => ({ uri: watch(id), sourceName: 'youtube', identifier: id })),
    onSourceResult: (track, played) => results.push([track.info.uri.slice(-11), played]),
    search: async (_player, { query }) => ({ tracks: playable.filter(id => query === watch(id)).map(id => f.track(id)) }),
  });
  return { ...f, results };
}

test('a permanently unavailable upload plays its verified alternate instead of skipping', async () => {
  const f = alternatesFixture(['altSource01']);
  await f.start();
  await f.error({ exception: { message: 'This is a private video.' } });
  assert.equal(f.player.queue.current.info.identifier, 'altSource01');
  assert.equal(f.player.queue.current.requester.id, 'requester-1');
  assert.equal(f.failed.length, 0);
  assert.deepEqual(f.results, [['dQw4w9WgXcQ', false]]);
  assert.deepEqual(f.player.queue.tracks.map(track => track.info.identifier), ['Zi_XLOBDo_Y']);
});

test('an alternate that fails too moves on once, then the song is skipped', async () => {
  const f = alternatesFixture(['altSource01', 'altSource02', 'altSource03'], ['altSource01', 'altSource03']);
  await f.start();
  await f.error({ exception: { message: 'This is a private video.' } });
  assert.equal(f.player.queue.current.info.identifier, 'altSource01');
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  await f.error({ exception: { message: 'This video has been removed' } });
  // altSource02 no longer loads; altSource03 does.
  assert.equal(f.player.queue.current.info.identifier, 'altSource03');
  await f.node.handleEvent({ type: 'TrackStartEvent', guildId: 'g1', track: f.wire() });
  await f.error({ exception: { message: 'This video has been removed' } });
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.failed.length, 1);
  assert.deepEqual(f.results, [['dQw4w9WgXcQ', false], ['altSource01', false], ['altSource02', false], ['altSource03', false]]);
});

test('a temporary failure tries alternates only after its exact retries', async () => {
  const f = alternatesFixture(['altSource01']);
  await f.start();
  await f.error({ exception: MIXED_CLIENT_EXCEPTION });
  assert.equal(f.player.queue.current.info.identifier, 'altSource01');
  assert.equal(f.failed.length, 0);
});

test('a song with verified sources never takes a metadata mirror on its retries', async () => {
  let mirrored = 0;
  const watch = id => `https://www.youtube.com/watch?v=${id}`;
  const f = fixture({
    alternates: () => [{ uri: watch('altSource01'), sourceName: 'youtube', identifier: 'altSource01' }],
    search: async (_player, { query, source }) => {
      if (source) { mirrored++; return { tracks: [f.track('mirrorTrk01', { sourceName: 'soundcloud', uri: 'https://soundcloud.com/a/b' })] }; }
      return { tracks: query === watch('altSource01') ? [f.track('altSource01')] : [] };
    },
  });
  await f.start(f.track('dQw4w9WgXcQ', { isrc: 'USRC17607839' }));
  await f.error({ exception: MIXED_CLIENT_EXCEPTION });
  assert.equal(mirrored, 0);
  assert.equal(f.player.queue.current.info.identifier, 'altSource01');
});

test('an unknown song is skipped as before', async () => {
  const f = alternatesFixture([]);
  await f.start();
  await f.error({ exception: { message: 'This is a private video.' } });
  assert.equal(f.player.queue.current.info.identifier, 'Zi_XLOBDo_Y');
  assert.equal(f.failed.length, 1);
});
