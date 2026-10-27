import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedMutation, withGuildMutation, cancelGuildMutations } from '../src/utils/requests.js';
import { maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';
import { track } from './fixtures.js';

function interaction(client, type = 'slash') {
  return {
    client, guildId: '100', deferred: false, replied: false, responses: [],
    isMessageComponent: () => type === 'component', isModalSubmit: () => type === 'modal',
    async deferReply() { this.deferred = true; this.responses.push('deferReply'); },
    async deferUpdate() { this.deferred = true; this.responses.push('deferUpdate'); },
    async reply(payload) { this.replied = true; this.responses.push(['reply', payload]); },
    async editReply(payload) { this.responses.push(['editReply', payload]); },
    async followUp(payload) { this.responses.push(['followUp', payload]); },
    async update(payload) { this.responses.push(['update', payload]); },
  };
}

test('concurrent guild requests acknowledge before waiting, serialize changes and release maintenance counters', async () => {
  const client = {}; const events = [];
  let unblock; const wait = new Promise(resolve => { unblock = resolve; });
  const first = interaction(client); const second = interaction(client);
  const a = guardedMutation(first, async proxy => { events.push('first'); await wait; await proxy.reply({ content: 'first result', flags: 64 }); }, { playback: true });
  const b = guardedMutation(second, async proxy => { events.push('second'); await proxy.reply({ content: 'second result', flags: 64 }); }, { playback: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.deferred, true); assert.equal(second.deferred, true);
  assert.deepEqual(events, ['first']); assert.equal(maintenanceStatus(client).inFlight, 2);
  unblock(); await Promise.all([a, b]);
  assert.deepEqual(events, ['first', 'second']); assert.equal(maintenanceStatus(client).inFlight, 0);
  assert.deepEqual(second.responses[1], ['editReply', { content: 'second result' }]);
});

test('a failed mutation does not poison the guild lane and counters close even on rejected operations', async () => {
  const client = {}; const current = interaction(client);
  await assert.rejects(guardedMutation(current, async () => { throw new Error('failure'); }, { playback: true }), /failure/);
  assert.equal(maintenanceStatus(client).inFlight, 0);
  assert.equal(await withGuildMutation('100', async () => 'next'), 'next');
});

test('maintenance denies playback before creating a guild mutation but personal library work can continue', async () => {
  const client = {}; setMaintenance(client, true);
  const denied = interaction(client);
  await guardedMutation(denied, () => assert.fail('must not run'), { playback: true });
  assert.match(denied.responses[0][1].content, /briefly updating/);
  const library = interaction(client);
  await guardedMutation(library, proxy => proxy.reply({ content: 'saved', flags: 64 }));
  assert.equal(library.responses.at(-1)[0], 'editReply');
});

test('component update edits its acknowledged message and private confirmations use follow-up', async () => {
  const current = interaction({}, 'component');
  await guardedMutation(current, async proxy => {
    await proxy.deferUpdate();
    await proxy.update({ content: 'changed', components: [] });
    await proxy.reply({ content: 'private confirmation', flags: 64 });
  });
  assert.deepEqual(current.responses.map(r => Array.isArray(r) ? r[0] : r), ['deferUpdate', 'editReply', 'followUp']);
});

test('authorized urgent stop runs before a slow import, cancels older waiting work, and permits a new request', async () => {
  const client = {}; const events = [];
  let finish; const wait = new Promise(resolve => { finish = resolve; });
  const loading = guardedMutation(interaction(client), async () => { events.push('loading'); await wait; }, { playback: true });
  const old = guardedMutation(interaction(client), () => assert.fail('Stopped waiting request must not run'), { playback: true });
  const oldRejection = assert.rejects(old, /cancelled by Stop/);
  await new Promise(resolve => setImmediate(resolve));
  await guardedMutation(interaction(client), async () => { cancelGuildMutations('100'); events.push('stop'); }, { playback: true, urgent: true });
  assert.deepEqual(events, ['loading', 'stop']);
  const fresh = guardedMutation(interaction(client), async () => { events.push('fresh'); }, { playback: true });
  await fresh;
  assert.deepEqual(events, ['loading', 'stop', 'fresh']);
  finish(); await Promise.all([loading, oldRejection]);
  assert.deepEqual(events, ['loading', 'stop', 'fresh']);
  assert.equal(maintenanceStatus(client).inFlight, 0);
});

const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('an ordered addition looks up outside the lane: later controls run meanwhile, later additions keep their place', async () => {
  const events = []; const lookup = gate();
  const addition = withGuildMutation('100', async lane => {
    events.push('A:start');
    await lane.outsideLane(async () => { events.push('A:lookup'); await lookup.promise; });
    events.push('A:write');
  }, { ordered: true });
  await turn();
  const later = withGuildMutation('100', async () => { events.push('B:write'); }, { ordered: true });
  const control = withGuildMutation('100', async lane => { assert.equal(lane.outsideLane, null, 'only additions may leave the lane'); events.push('pause'); });
  await control;
  assert.deepEqual(events, ['A:start', 'A:lookup', 'pause'], 'Pause ran during the lookup; the later addition waited');
  lookup.resolve(); await Promise.all([addition, later]);
  assert.deepEqual(events, ['A:start', 'A:lookup', 'pause', 'A:write', 'B:write']);
});

test('an addition re-entering the lane waits for the current holder and honors Stop', async () => {
  const events = []; const lookup = gate(); const hold = gate(); const held = gate();
  const addition = withGuildMutation('100', async lane => {
    await lane.outsideLane(() => lookup.promise);
    events.push('A:write');
  }, { ordered: true });
  await turn();
  const control = withGuildMutation('100', async () => { held.resolve(); await hold.promise; events.push('volume'); });
  await held.promise; lookup.resolve(); await turn(); await turn();
  assert.deepEqual(events, [], 'the addition waits behind the control that holds the lane');
  hold.resolve(); await Promise.all([control, addition]);
  assert.deepEqual(events, ['volume', 'A:write']);
  // Stop during the lookup cancels the write on re-entry.
  const stopped = gate();
  const cancelled = withGuildMutation('100', async lane => { await lane.outsideLane(() => stopped.promise); assert.fail('must not write after Stop'); }, { ordered: true });
  const rejection = assert.rejects(cancelled, /cancelled by Stop/);
  await turn(); cancelGuildMutations('100'); stopped.resolve(); await rejection;
});

function activityClient() {
  const player = { queue: { current: track('aaaaaaaaaaa'), tracks: [] } };
  const recorded = []; let release = null;
  const client = {
    lavalink: { getPlayer: () => player },
    library: { readGuild: () => ({ session: null }), settings: () => ({}),
      recordActivity: (guildId, user) => { recorded.push(user.id); return release ? release.promise : Promise.resolve(); } },
  };
  return { client, player, recorded, hold() { release = gate(); return release; } };
}

test('the lane does not wait for activity to be saved, and activity keeps lane order', async () => {
  const { client, player, recorded, hold } = activityClient();
  const saving = hold();
  const skip = (id, identifier) => guardedMutation({ ...interaction(client), commandName: 'skip', user: { id }, options: { getSubcommand: () => null } },
    async () => { player.queue.tracks.push(track(identifier)); }, { playback: true });
  await skip('200', 'bbbbbbbbbbb');
  await skip('201', 'ccccccccccc');
  assert.deepEqual(recorded, ['200', '201'], 'both recorded in lane order while the first save is still pending');
  saving.resolve();
});

test('changes others make during an outside-lane lookup are not recorded as the addition’s activity', async () => {
  const { client, player, recorded } = activityClient();
  const lookup = gate(); const looking = gate();
  const play = guardedMutation({ ...interaction(client), commandName: 'play', user: { id: '200' }, options: { getSubcommand: () => null } },
    async proxy => { await proxy.outsideMutationLane(async () => { looking.resolve(); await lookup.promise; }); }, { playback: true, lookupOutsideLane: true });
  await looking.promise;
  await guardedMutation({ ...interaction(client), commandName: 'skip', user: { id: '201' }, options: { getSubcommand: () => null } },
    async () => { player.queue.current = track('bbbbbbbbbbb'); }, { playback: true });
  lookup.resolve(); await play;
  assert.deepEqual(recorded, ['201'], 'the lookup that changed nothing records nothing');
});

test('every addition keeps its place among additions; only /play may look up outside the lane', async () => {
  const { commandMutationPolicy } = await import('../src/utils/requests.js');
  for (const [name, action] of [['play'], ['playnext'], ['replay'], ['transfer'], ['favorite', 'play'], ['mix', 'load'], ['top', 'play'], ['mymix', 'play'], ['radio', 'promote']]) {
    const policy = commandMutationPolicy(name, action);
    assert.equal(policy.ordered, true, `${name} ${action || ''}`);
    assert.equal(Boolean(policy.lookupOutsideLane), name === 'play');
  }
  for (const [name, action] of [['pause'], ['volume'], ['skip'], ['remove'], ['shuffle'], ['radio', 'remove'], ['stop']]) {
    assert.equal(commandMutationPolicy(name, action).ordered, undefined, `${name} doesn't wait behind additions`);
  }
});

test('a Discord history Replay button keeps its place among additions; other buttons do not wait', async () => {
  const { componentMutationPolicy } = await import('../src/utils/requests.js');
  assert.equal(componentMutationPolicy('history:v2:replay:abc').ordered, true);
  for (const id of ['player:v1:skip', 'player:v1:toggle', 'queue:v2:jump:1', 'player:v1:stop-confirm']) assert.equal(componentMutationPolicy(id).ordered, undefined, id);
  assert.deepEqual(componentMutationPolicy('player:v1:stop-confirm'), { playback: true, urgent: true });
  assert.deepEqual(componentMutationPolicy('player:v2:favorite:x'), { playback: false, urgent: false });
});
