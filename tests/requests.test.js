import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedMutation, withGuildMutation, cancelGuildMutations } from '../src/utils/requests.js';
import { maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';

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
