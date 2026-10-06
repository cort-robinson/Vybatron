import test from 'node:test';
import assert from 'node:assert/strict';
import { FilterManager } from 'lavalink-client';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createOrUpdate, refresh, resetControllers } from '../src/utils/player-controller.js';
import { resetVoiceStatusWarnings, updateVoiceStatus } from '../src/utils/voice-status.js';
import { execute as pause } from '../src/commands/pause.js';
import {
  getPresentationDiagnostics, resetPresentationUpdates, submitPresentationWrite,
} from '../src/utils/presentation-updates.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test.afterEach(() => { resetControllers(); resetVoiceStatusWarnings(); resetPresentationUpdates(); });

function cosmetics(f) {
  const edits = []; const statuses = [];
  const editGate = deferred(); const statusGate = deferred();
  const editEntered = deferred(); const statusEntered = deferred();
  const message = { id: 'controller', async edit(payload) {
    edits.push(payload); editEntered.resolve(); await editGate.promise; return message;
  } };
  const channel = f.channels.get('400');
  channel.send = async () => message;
  channel.messages = { fetch: async () => message };
  f.client.rest = { async put(route, payload) {
    statuses.push({ route, payload }); statusEntered.resolve(); await statusGate.promise;
  } };
  f.client.channels.cache.get('300').permissionsFor = () => ({ has: () => true });
  return { edits, statuses, editGate, statusGate, editEntered, statusEntered };
}

test('portal Pause and Resume complete behind held controller edit and voice PUT, after actual audio settlement', async t => {
  const f = await portalFixture(t);
  const c = cosmetics(f);
  await createOrUpdate(f.client, f.player);
  const audio = deferred(); const invoked = deferred();
  let settled = false; let calls = 0;
  f.player.pause = async () => { calls++; f.player.paused = true; invoked.resolve(); await audio.promise; };
  const pausing = f.command({ command: 'pause' }).then(result => { settled = true; return result; });
  await invoked.promise; await tick();
  assert.equal(settled, false, 'optimistic paused state does not acknowledge an unsettled PATCH');
  assert.equal(c.edits.length, 0); assert.equal(c.statuses.length, 0);
  audio.resolve();
  const paused = await pausing;
  assert.equal(paused.status, 200); assert.equal(calls, 1);
  await Promise.all([c.editEntered.promise, c.statusEntered.promise]);
  const resumed = await f.command({ command: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(f.calls.filter(call => call === 'resume').length, 1);
  assert.equal(c.edits.length, 1); assert.equal(c.statuses.length, 1);
  const controllerDone = refresh(f.client, f.player);
  const voiceDone = updateVoiceStatus(f.client, f.player);
  c.editGate.resolve(); c.statusGate.resolve();
  await Promise.all([controllerDone, voiceDone]);
  assert.equal(c.edits.at(-1).embeds[0].data.author.name, 'Now Playing');
  assert.match(c.statuses.at(-1).payload.body.status, /^🎵/);
});

test('verified Seek, Volume and Filter also complete while their cosmetic edit is held', async t => {
  const f = await portalFixture(t);
  const c = cosmetics(f);
  await createOrUpdate(f.client, f.player);
  const holding = refresh(f.client, f.player);
  await c.editEntered.promise;
  f.player.filterManager = new FilterManager(f.player);
  f.player.filterManager.applyPlayerFilters = async () => { f.calls.push('filter'); };
  const snapshot = await f.request();
  const seek = await f.command({ command: 'seek', options: { timestamp: '00:20' }, expectedRevision: snapshot.body.revision });
  assert.equal(seek.status, 200);
  assert.equal((await f.command({ command: 'volume', options: { level: 42 } })).status, 200);
  assert.equal((await f.command({ command: 'filter', options: { preset: 'off' } })).status, 200);
  assert.deepEqual(f.calls.filter(call => ['seek', 'volume', 'filter'].includes(call)), ['seek', 'volume', 'filter']);
  assert.equal(c.edits.length, 1);
  c.editGate.resolve(); c.statusGate.resolve();
  await holding;
  assert.equal(c.edits.length, 2, 'all held web refreshes collapse to one latest render');
});

test('native Pause retains awaited controller then voice presentation semantics', async t => {
  const f = await portalFixture(t);
  const c = cosmetics(f);
  await createOrUpdate(f.client, f.player);
  const reply = deferred();
  const operation = pause({ client: f.client, guildId: '100', guild: f.guild,
    member: f.members.get('200'), user: f.users.get('200'), commandName: 'pause',
    async reply() { reply.resolve(); },
  });
  let finished = false; void operation.then(() => { finished = true; });
  await c.editEntered.promise; await tick();
  assert.equal(finished, false); assert.equal(c.statuses.length, 0);
  c.editGate.resolve(); await c.statusEntered.promise; await tick();
  assert.equal(finished, false);
  c.statusGate.resolve(); await operation; await reply.promise;
  assert.equal(finished, true);
});

test('playback failure schedules no success cosmetics; cosmetic failures do not fail successful audio', async t => {
  const f = await portalFixture(t);
  const c = cosmetics(f);
  await createOrUpdate(f.client, f.player);
  f.player.pause = async () => { throw new Error('audio failed'); };
  assert.notEqual((await f.command({ command: 'pause' })).status, 200);
  assert.equal(c.edits.length, 0); assert.equal(c.statuses.length, 0);
  f.player.pause = async () => { f.player.paused = true; };
  f.channels.get('400').messages.fetch = async () => ({ edit: async () => { throw new Error('deleted'); } });
  f.channels.get('400').send = async () => { throw new Error('offline'); };
  f.client.rest.put = async () => { throw new Error('REST failed'); };
  assert.equal((await f.command({ command: 'pause' })).status, 200);
  await tick();
  assert.ok(getPresentationDiagnostics().failures >= 2);
});

test('four ordinary workers, two terminal reservations and 256 records remain bounded until real settlement', async () => {
  const gate = deferred(); const started = [];
  const ordinary = Array.from({ length: 4 }, (_, i) => submitPresentationWrite(`held:${i}`, async () => { started.push(i); await gate.promise; }));
  await tick();
  const terminal = Array.from({ length: 2 }, (_, i) => submitPresentationWrite(`terminal:${i}`, async () => { started.push(4 + i); await gate.promise; }, { terminal: true }));
  const queued = Array.from({ length: 250 }, (_, i) => submitPresentationWrite(`queued:${i}`, async () => gate.promise));
  await tick();
  assert.deepEqual(getPresentationDiagnostics(), { records: 256, ordinary: 4, terminal: 2, drops: 0, failures: 0 });
  assert.equal(started.length, 6);
  let rejected = 0;
  assert.equal(await submitPresentationWrite('overflow', async () => assert.fail('overflow submitted'), {
    terminal: true, onRejected: () => { rejected++; },
  }), null);
  assert.equal(rejected, 1, 'terminal reservations do not guarantee new-key admission');
  assert.equal(submitPresentationWrite('terminal:0', async () => gate.promise, {
    terminal: true, onRejected: () => assert.fail('an existing writer lost admission at capacity'),
  }), terminal[0], 'an existing terminal writer keeps its fence and shared completion at capacity');
  let latest = 0;
  for (let i = 1; i <= 100; i++) {
    assert.equal(submitPresentationWrite('held:0', async () => { latest = i; }), ordinary[0]);
  }
  await tick();
  assert.equal(latest, 0); assert.equal(getPresentationDiagnostics().ordinary, 4);
  gate.resolve();
  await Promise.all([...ordinary, ...terminal, ...queued]);
  assert.equal(latest, 100);
  assert.deepEqual(getPresentationDiagnostics(), { records: 0, ordinary: 0, terminal: 0, drops: 1, failures: 0 });
});
