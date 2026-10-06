import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearVoiceStatus,
  resetVoiceStatusWarnings,
  updateVoiceStatus,
} from '../src/utils/voice-status.js';
import { getPresentationDiagnostics } from '../src/utils/presentation-updates.js';

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

function ownedFixture() {
  const c = client(); const p = player(); const flags = new Map();
  p.getData = key => flags.get(key); p.setData = (key, value) => flags.set(key, value);
  let current = p;
  c.lavalink = { getPlayer: () => current };
  const gate = deferred(); const entered = deferred(); let count = 0;
  c.rest.put = async (route, payload) => {
    c.calls.push({ route, payload });
    if (++count === 1) { entered.resolve(); await gate.promise; }
  };
  return { c, p, gate, entered, replace(value) { current = value; } };
}

function player(paused = false) {
  return {
    guildId: 'guild',
    voiceChannelId: 'voice',
    paused,
    queue: { current: { info: { title: 'Song', author: 'Artist' } } },
  };
}

function client(allowed = true) {
  const calls = [];
  return {
    user: { id: 'bot' },
    channels: { cache: new Map([['voice', { permissionsFor: () => ({ has: () => allowed }) }]]) },
    rest: { put: async (route, payload) => { calls.push({ route, payload }); } },
    calls,
  };
}

beforeEach(resetVoiceStatusWarnings);

test('voice status sets playing and paused text, then clears', async () => {
  const c = client();
  const p = player();
  await updateVoiceStatus(c, p);
  p.paused = true;
  await updateVoiceStatus(c, p);
  await clearVoiceStatus(c, p);
  assert.equal(c.calls[0].payload.body.status, '🎵 Song — Artist');
  assert.equal(c.calls[1].payload.body.status, '⏸ Song — Artist');
  assert.equal(c.calls[2].payload.body.status, null);
});

test('missing voice-status permission is non-fatal', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const c = client(false);
    assert.equal(await updateVoiceStatus(c, player()), false);
    assert.equal(c.calls.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});

test('held PUT retains ownership until settlement, then Stop clears and old updates cannot reactivate', async () => {
  const f = ownedFixture();
  const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
  f.p.setData('vybertron.stopping', true);
  const clearing = clearVoiceStatus(f.c, f.p);
  f.replace(null); f.p.voiceChannelId = null;
  assert.equal(await updateVoiceStatus(f.c, f.p), false);
  assert.equal(f.c.calls.length, 1);
  assert.equal(getPresentationDiagnostics().ordinary, 1);
  f.gate.resolve(); await Promise.all([updating, clearing]);
  assert.equal(f.c.calls.length, 2); assert.equal(f.c.calls.at(-1).payload.body.status, null);
  assert.equal(await clearVoiceStatus(f.c, f.p), false, 'duplicate destroy after disconnect has no address to clear');
});

test('same-channel replacement follows a submitted old PUT and old clear is ignored', async () => {
  const f = ownedFixture();
  const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
  const replacement = player(true); replacement.queue.current.info.title = 'New song';
  f.replace(replacement);
  assert.equal(await clearVoiceStatus(f.c, f.p), false);
  const replacing = updateVoiceStatus(f.c, replacement);
  assert.equal(await updateVoiceStatus(f.c, f.p), false);
  assert.equal(await clearVoiceStatus(f.c, f.p), false);
  assert.equal(f.c.calls.length, 1);
  f.gate.resolve(); await Promise.all([updating, replacing]);
  assert.equal(f.c.calls.length, 2); assert.match(f.c.calls.at(-1).payload.body.status, /^⏸ New song/);
});

test('different-channel replacement clears the submitted old address and writes only the latest channel', async () => {
  const f = ownedFixture();
  const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
  const replacement = player(); replacement.voiceChannelId = 'new-voice';
  f.replace(replacement);
  const clearing = clearVoiceStatus(f.c, f.p);
  const replacing = updateVoiceStatus(f.c, replacement);
  assert.equal(f.c.calls.length, 1);
  f.gate.resolve(); await Promise.all([updating, clearing, replacing]);
  assert.deepEqual(f.c.calls.map(call => [call.route, call.payload.body.status === null]), [
    ['/channels/voice/voice-status', false], ['/channels/voice/voice-status', true], ['/channels/new-voice/voice-status', false],
  ]);
  assert.equal(await clearVoiceStatus(f.c, f.p), false);
});

test('bursts and repeated channel moves keep one latest intent with no cleanup backlog', async () => {
  const f = ownedFixture();
  const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
  let latest;
  for (let i = 0; i < 40; i++) {
    f.p.voiceChannelId = `voice-${i}`; f.p.paused = true;
    f.p.queue.current.info.title = `Song ${i}`;
    latest = updateVoiceStatus(f.c, f.p);
    assert.equal(latest, updating, 'every producer awaits the same busy writer completion');
  }
  assert.equal(getPresentationDiagnostics().records, 1);
  assert.equal(f.c.calls.length, 1);
  f.gate.resolve(); await latest;
  assert.equal(f.c.calls.length, 3);
  assert.equal(f.c.calls[1].payload.body.status, null);
  assert.equal(f.c.calls[2].route, '/channels/voice-39/voice-status');
  assert.match(f.c.calls[2].payload.body.status, /^⏸ Song 39/);
});

test('a no-track clear remains resumable and REST failures are observed as numeric diagnostics', async () => {
  const c = client(); const p = player();
  await updateVoiceStatus(c, p);
  p.queue.current = null; await updateVoiceStatus(c, p);
  assert.equal(c.calls.at(-1).payload.body.status, null);
  p.queue.current = player().queue.current; await updateVoiceStatus(c, p);
  assert.match(c.calls.at(-1).payload.body.status, /^🎵/);
  const before = getPresentationDiagnostics().failures;
  c.rest.put = async () => { throw new Error('private upstream error'); };
  assert.equal(await updateVoiceStatus(c, p), false);
  assert.equal(getPresentationDiagnostics().failures, before + 1);
});

test('Stop during held previous-channel cleanup prevents submitting current active status', async () => {
  const f = ownedFixture();
  f.gate.resolve(); await updateVoiceStatus(f.c, f.p);
  const cleanup = deferred(); const entered = deferred();
  f.c.rest.put = async (route, payload) => {
    f.c.calls.push({ route, payload }); entered.resolve(); await cleanup.promise;
  };
  f.p.voiceChannelId = 'moved';
  const moving = updateVoiceStatus(f.c, f.p); await entered.promise;
  f.p.setData('vybertron.stopping', true);
  const clearing = clearVoiceStatus(f.c, f.p);
  assert.equal(f.c.calls.length, 2);
  cleanup.resolve(); await Promise.all([moving, clearing]);
  assert.ok(f.c.calls.slice(1).every(call => call.payload.body.status === null));
  assert.deepEqual(f.c.calls.map(call => call.route), [
    '/channels/voice/voice-status', '/channels/voice/voice-status', '/channels/moved/voice-status',
  ], 'terminal cleanup also clears the owned current address');
});

test('Stop before replacement drain clears submitted and current addresses without a move backlog', async t => {
  for (const channelId of ['voice', 'replacement']) await t.test(channelId, async () => {
    resetVoiceStatusWarnings();
    const f = ownedFixture();
    const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
    const replacement = player(); replacement.voiceChannelId = channelId;
    f.replace(replacement);
    const replacing = updateVoiceStatus(f.c, replacement);
    replacement.getData = key => key === 'vybertron.stopping';
    const clearing = clearVoiceStatus(f.c, replacement);
    f.replace(null); replacement.voiceChannelId = null;
    const destroying = clearVoiceStatus(f.c, replacement);
    assert.equal(f.c.calls.length, 1);
    f.gate.resolve(); await Promise.all([updating, replacing, clearing, destroying]);
    const addresses = channelId === 'voice' ? ['voice', 'voice'] : ['voice', 'voice', channelId];
    assert.deepEqual(f.c.calls.map(call => call.route), addresses.map(id => `/channels/${id}/voice-status`));
    assert.ok(f.c.calls.slice(1).every(call => call.payload.body.status === null));
    assert.equal(await clearVoiceStatus(f.c, replacement), false, 'settled duplicate teardown has no retained address');
  });
});

test('Stop during replacement cleanup clears its current address after the old clear settles', async () => {
  const f = ownedFixture();
  f.gate.resolve(); await updateVoiceStatus(f.c, f.p);
  const cleanup = deferred(); const entered = deferred();
  f.c.rest.put = async (route, payload) => {
    f.c.calls.push({ route, payload });
    if (route === '/channels/voice/voice-status') { entered.resolve(); await cleanup.promise; }
  };
  const replacement = player(); replacement.voiceChannelId = 'replacement';
  f.replace(replacement);
  const replacing = updateVoiceStatus(f.c, replacement); await entered.promise;
  replacement.getData = key => key === 'vybertron.stopping';
  const clearing = clearVoiceStatus(f.c, replacement);
  f.replace(null); replacement.voiceChannelId = null;
  cleanup.resolve(); await Promise.all([replacing, clearing]);
  assert.deepEqual(f.c.calls.map(call => [call.route, call.payload.body.status === null]), [
    ['/channels/voice/voice-status', false], ['/channels/voice/voice-status', true], ['/channels/replacement/voice-status', true],
  ]);
});

test('terminal cleanup rechecks a live new owner before each clear, even without a new render', async t => {
  for (const channelId of ['voice', 'replacement', 'other']) await t.test(channelId, async () => {
    resetVoiceStatusWarnings();
    const f = ownedFixture();
    const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
    const replacement = player(); replacement.voiceChannelId = 'replacement';
    f.replace(replacement);
    const replacing = updateVoiceStatus(f.c, replacement);
    replacement.getData = key => key === 'vybertron.stopping';
    const clearing = clearVoiceStatus(f.c, replacement);
    const next = player(); next.voiceChannelId = channelId;
    const cleanup = deferred(); const entered = deferred();
    f.c.rest.put = async (route, payload) => {
      f.c.calls.push({ route, payload });
      if (route === '/channels/voice/voice-status') { entered.resolve(); await cleanup.promise; }
    };
    if (channelId === 'voice') f.replace(next); // Protect the first address before drain.
    f.gate.resolve();
    if (channelId !== 'voice') { await entered.promise; f.replace(next); }
    cleanup.resolve(); await Promise.all([updating, replacing, clearing]);
    const clears = f.c.calls.slice(1);
    assert.ok(clears.every(call => call.payload.body.status === null));
    assert.ok(clears.every(call => call.route !== `/channels/${channelId}/voice-status`), 'live ownership protects each address');
    assert.equal(clears.length, channelId === 'other' ? 2 : 1);
  });
});

test('Stop after repeated moves clears only the submitted and latest owned addresses', async () => {
  const f = ownedFixture();
  const updating = updateVoiceStatus(f.c, f.p); await f.entered.promise;
  for (let i = 0; i < 1000; i++) {
    f.p.voiceChannelId = `move-${i}`; updateVoiceStatus(f.c, f.p);
  }
  f.p.setData('vybertron.stopping', true);
  const clearing = clearVoiceStatus(f.c, f.p);
  f.replace(null); f.p.voiceChannelId = null;
  assert.equal(getPresentationDiagnostics().records, 1);
  f.gate.resolve(); await Promise.all([updating, clearing]);
  assert.deepEqual(f.c.calls.map(call => [call.route, call.payload.body.status === null]), [
    ['/channels/voice/voice-status', false], ['/channels/voice/voice-status', true], ['/channels/move-999/voice-status', true],
  ]);
});
