import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { handleVoiceStateUpdate } from '../src/lavalink.js';
import {
  createOrUpdate, refresh, getControllerRecord, resetControllers,
  requestControllerRefresh, requestControllerUpdate, requestControllerStatus, requestControllerEnd,
} from '../src/utils/player-controller.js';
import { updateVoiceStatus, clearVoiceStatus, resetVoiceStatusWarnings } from '../src/utils/voice-status.js';
import { getPresentationDiagnostics, resetPresentationUpdates } from '../src/utils/presentation-updates.js';

function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve };
}

// Count reactions attached to the actual busy completion promise. This detects
// async wrapper/adoption retention even when the scheduler still has one record.
function reactionProbe() {
  const ids = new WeakMap(); let target; let reactions = 0;
  const hook = createHook({ init(id, type, trigger, resource) {
    if (type !== 'PROMISE') return;
    ids.set(resource, id);
    if (target !== undefined && trigger === target) reactions++;
  } });
  hook.enable();
  return {
    watch(promise) { target = ids.get(promise); assert.notEqual(target, undefined); reactions = 0; },
    get reactions() { return reactions; },
    close() { hook.disable(); },
  };
}

function fixture() {
  const player = {
    guildId: 'reaction-stress', textChannelId: 'text', voiceChannelId: 'voice',
    queue: { current: { info: { title: 'Song', author: 'Artist', identifier: 'song' } }, tracks: [] },
  };
  const gate = deferred(); const entered = deferred(); let edits = 0;
  const message = { id: 'controller', async edit() {
    edits++; entered.resolve(); await gate.promise; return message;
  } };
  const client = {
    lavalink: { getPlayer: () => player },
    channels: { cache: new Map([['text', {
      send: async () => message, messages: { fetch: async () => message },
    }]]) },
  };
  return { client, player, gate, entered, get edits() { return edits; } };
}

test.afterEach(() => { resetControllers(); resetVoiceStatusWarnings(); resetPresentationUpdates(); });

test('1000 ignored lifecycle submissions per producer retain zero shared-completion reactions', async () => {
  const f = fixture(); const probe = reactionProbe(); let completion; let native;
  try {
    await createOrUpdate(f.client, f.player);
    completion = requestControllerUpdate(f.client, f.player);
    await f.entered.promise;
    probe.watch(completion);
    const oldState = { guild: { id: f.player.guildId, channels: { cache: new Map([['voice', {
      members: { filter: () => ({ size: 1 }) },
    }]]) } } };
    for (const submit of [
      () => handleVoiceStateUpdate(f.client, oldState),
      () => requestControllerRefresh(f.client, f.player),
      () => requestControllerUpdate(f.client, f.player),
      () => requestControllerStatus(f.client, f.player, 'recovering', 'Retrying.'),
    ]) {
      for (let i = 0; i < 1000; i++) submit();
      assert.equal(probe.reactions, 0);
      assert.equal(getPresentationDiagnostics().records, 1);
      assert.equal(f.edits, 1);
    }
    native = refresh(f.client, f.player);
    assert.equal(probe.reactions, 1, 'bounded native await calibrates the reaction detector');
    probe.watch(completion);
    for (let i = 0; i < 1000; i++) requestControllerEnd(f.client, f.player);
    assert.equal(probe.reactions, 0, 'terminal ignored submissions do not adopt the completion promise');
    assert.equal(getPresentationDiagnostics().records, 1);
    assert.equal(getPresentationDiagnostics().ordinary, 1, 'submitted edit holds its actual slot');
  } finally {
    probe.close(); f.gate.resolve(); await Promise.all([completion, native]);
  }
  assert.equal(f.edits, 2, 'only the final terminal intent follows the submitted edit');
  assert.equal(getControllerRecord(f.player.guildId), null);
  assert.equal(getPresentationDiagnostics().records, 0);
});

test('1000 ignored voice updates and clears retain zero shared-completion reactions', async () => {
  const f = fixture(); const probe = reactionProbe(); let completion;
  f.client.rest = { async put() { f.entered.resolve(); await f.gate.promise; } };
  try {
    completion = updateVoiceStatus(f.client, f.player); await f.entered.promise;
    probe.watch(completion);
    for (let i = 0; i < 1000; i++) updateVoiceStatus(f.client, f.player);
    for (let i = 0; i < 1000; i++) clearVoiceStatus(f.client, f.player);
    assert.equal(probe.reactions, 0);
    assert.equal(getPresentationDiagnostics().records, 1);
    assert.equal(getPresentationDiagnostics().ordinary, 1);
  } finally {
    probe.close(); f.gate.resolve(); await completion;
  }
  assert.equal(getPresentationDiagnostics().records, 0);
});

test('ignored controller submission rejection is centrally observed without a caller catch', async () => {
  const f = fixture();
  f.client.channels.cache.get('text').send = async () => { throw new Error('synthetic transport failure'); };
  const before = getPresentationDiagnostics().failures;
  requestControllerUpdate(f.client, f.player);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getPresentationDiagnostics().failures, before + 1);
  assert.equal(getPresentationDiagnostics().records, 0);
});
