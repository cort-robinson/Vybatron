import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayIntentBits, IntentsBitField, PermissionsBitField, Status } from 'discord.js';
import { deferred, portalFixture } from './portal-fixtures.js';
import { createPortalPolicy } from '../src/portal/policy.js';
import { createRevisions } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';

// A live Gateway session with the members intent: the cache holds the actor,
// the bot member and the @everyone role, and the guild's shard is Ready.
function gateway(f, { intent = true, status = Status.Ready } = {}) {
  f.client.options = { intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(intent ? [GatewayIntentBits.GuildMembers] : [])]) };
  f.guild.shard = { status };
  f.guild.members.me = f.me;
  f.guild.roles.cache.set('100', { id: '100', name: '@everyone', permissions: new PermissionsBitField(0n), rawPosition: 0 });
}

async function harness(t, options, fixture) {
  const f = await portalFixture(t, fixture);
  gateway(f, options);
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const commands = new Map(await loadCommandsData());
  // Count every Discord REST read and note how many happened before the first
  // playback write reached the player.
  let reads = 0; let readsAtWrite = null;
  for (const [owner, key] of [[f.client.users, 'fetch'], [f.client.application, 'fetch'], [f.client.rest, 'get'],
    [f.guild.members, 'fetch'], [f.guild.members, 'fetchMe'], [f.guild.channels, 'fetch']]) {
    const original = owner[key].bind(owner);
    owner[key] = async (...args) => { reads++; return original(...args); };
  }
  for (const method of ['pause', 'resume', 'seek', 'setVolume', 'skip', 'stopPlaying', 'destroy']) {
    const original = f.player[method].bind(f.player);
    f.player[method] = async (...args) => { readsAtWrite ??= reads; return original(...args); };
  }
  const shuffle = f.player.queue.shuffle.bind(f.player.queue);
  f.player.queue.shuffle = async () => { readsAtWrite ??= reads; return shuffle(); };
  return { ...f, revisions, get reads() { return reads; }, get readsAtWrite() { return readsAtWrite; },
    run: body => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId: '200', expectedRevision: revisions.revision('100'), ...body }) };
}

test('audible controls reach the player without a Discord REST read and keep a fresh final disclosure', async t => {
  for (const [command, options] of [['pause'], ['seek', { timestamp: '00:20' }], ['volume', { level: 40 }], ['skip']]) await t.test(command, async t => {
    const f = await harness(t);
    const result = await f.run({ command, options });
    assert.equal(result.ok, true);
    assert.equal(f.readsAtWrite, 0, 'no REST read before the playback write');
    assert.ok(f.reads > 0, 'the reply still takes a fresh REST round');
  });
});

test('the Gateway path falls back to a fresh REST round when the cache cannot be trusted', async t => {
  const cases = {
    'members intent off': f => gateway(f, { intent: false }),
    'shard resuming': f => gateway(f, { status: Status.Resuming }),
    'actor not cached': f => f.members.delete('200'),
    'no @everyone role': f => f.guild.roles.cache.delete('100'),
  };
  for (const [name, setup] of Object.entries(cases)) await t.test(name, async t => {
    const f = await harness(t);
    const actor = f.members.get('200');
    setup(f);
    // REST still knows the actor, so only the authority source differs.
    if (!f.members.has('200')) { const fetch = f.guild.members.fetch; f.guild.members.fetch = async query => query.user === '200' ? actor : fetch(query); }
    const result = await f.run({ command: 'pause' });
    assert.equal(result.ok, true);
    assert.ok(f.readsAtWrite > 0, 'a REST round ran before the write');
  });
});

test('Gateway authority enforces DJ, same-voice and visibility rules before any write', async t => {
  const cases = {
    'DJ role required': async f => f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; }),
    'another voice channel': async f => { f.members.get('200').voice.channel = f.channels.get('301'); },
    'hidden controller channel': async f => { f.channels.get('400').hidden.add('200'); },
  };
  for (const [name, setup] of Object.entries(cases)) await t.test(name, async t => {
    const f = await harness(t);
    await setup(f);
    await assert.rejects(f.run({ command: 'pause' }), error => error.status === 403);
    assert.equal(f.readsAtWrite, null, 'nothing reached the player');
    assert.equal(f.player.paused, false);
  });
  await t.test('a cached DJ role grants access', async t => {
    const f = await harness(t);
    await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
    f.members.get('200').roles.cache.set('500', f.roles.get('500'));
    assert.equal((await f.run({ command: 'pause' })).ok, true);
    assert.equal(f.readsAtWrite, 0);
  });
});

test('song additions reach the queue from Gateway authority and take one fresh round for the reply', async t => {
  const baseline = await harness(t);
  assert.equal((await baseline.run({ command: 'pause' })).ok, true);
  const oneRound = baseline.reads;
  for (const command of ['play', 'playnext']) await t.test(command, async t => {
    const f = await harness(t);
    for (const method of ['add', 'splice']) {
      const original = f.player.queue[method].bind(f.player.queue);
      f.player.queue[method] = async (...args) => { f.queueReads ??= f.reads; return original(...args); };
    }
    const before = f.player.queue.tracks.length;
    const result = await f.run({ command, options: { query: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y' } });
    assert.equal(result.ok, true);
    assert.equal(f.player.queue.tracks.length, before + 1);
    assert.equal(f.queueReads, 0, 'no REST read before the queue write');
    assert.equal(f.reads, oneRound, 'only the final disclosure reads Discord REST');
  });
  await t.test('falls back to fresh REST without the members intent', async t => {
    const f = await harness(t, { intent: false });
    assert.equal((await f.run({ command: 'play', options: { query: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y' } })).ok, true);
    assert.ok(f.reads > oneRound);
  });
  await t.test('Gateway authority still requires the DJ role to play next', async t => {
    const f = await harness(t);
    await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
    const before = f.player.queue.tracks.length;
    await assert.rejects(f.run({ command: 'playnext', options: { query: 'https://www.youtube.com/watch?v=Zi_XLOBDo_Y' } }), error => error.status === 403);
    assert.equal(f.player.queue.tracks.length, before);
  });
});

test('Gateway authority rechecks an addition after its slow lookup', async t => {
  const cases = {
    'left voice': f => { f.members.get('200').voice.channel = null; },
    'moved voice': f => { f.members.get('200').voice.channel = f.channels.get('301'); },
    'DJ role revoked': f => f.members.get('200').roles.cache.delete('500'),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const lookup = deferred(); const started = deferred();
    const f = await harness(t, {}, { search: () => { started.resolve(); return lookup.promise; } });
    await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
    f.members.get('200').roles.cache.set('500', f.roles.get('500'));
    const before = f.player.queue.tracks.length;
    const running = f.run({ command: name === 'DJ role revoked' ? 'playnext' : 'play', options: { query: 'slow song' } });
    await started.promise;
    change(f);
    lookup.resolve({ loadType: 'track', tracks: [{ encoded: 'QAAA', info: { title: 'Slow', author: 'A', identifier: 'aaaaaaaaaaa', uri: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', sourceName: 'youtube', duration: 1000 } }] });
    await assert.rejects(running, error => [403, 409].includes(error.status));
    assert.equal(f.player.queue.tracks.length, before, 'nothing was added');
  });
});

test('Stop and queue edits keep fresh REST authority before their write', async t => {
  for (const command of ['stop', 'shuffle']) await t.test(command, async t => {
    const f = await harness(t);
    assert.equal((await f.run({ command })).ok, true);
    assert.ok(f.readsAtWrite > 0);
  });
});

test('member role and timeout changes wake the change feed; nickname edits do not', async t => {
  const f = await portalFixture(t);
  const feed = (instance = '', after = '') => f.request(`/v1/changes?instance=${instance}&after=${after}`);
  const first = await feed(); await delay(30);
  let { sequence } = (await feed(first.body.instanceId, first.body.sequence)).body;
  const member = roles => ({ guild: f.guild, roles: { cache: new Map(roles.map(id => [id, {}])) }, communicationDisabledUntilTimestamp: null });
  const held = feed(first.body.instanceId, sequence);
  f.client.emit('guildMemberUpdate', member([]), { ...member([]), nickname: 'renamed' });
  await delay(20);
  f.client.emit('guildMemberUpdate', member([]), member(['500']));
  const woke = await held;
  assert.deepEqual(woke.body.guildIds, ['100']);
  assert.equal(woke.body.sequence, sequence + 1, 'only the role change published');
  sequence = woke.body.sequence;
  const removed = feed(first.body.instanceId, sequence);
  f.client.emit('guildMemberRemove', member([]));
  assert.deepEqual((await removed).body.guildIds, ['100']);
});
