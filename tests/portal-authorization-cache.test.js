import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayIntentBits, IntentsBitField, PermissionsBitField, Status } from 'discord.js';
import { deferred, portalFixture } from './portal-fixtures.js';
import { createPortalPolicy, IDENTITY_CACHE } from '../src/portal/policy.js';
import { createRevisions } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';

// ADR-0011: protected reads and the final disclosure use Gateway state when it
// can vouch, identity answers are remembered briefly, and every revocation the
// Gateway reports applies to the next read or reply.

function gateway(f, { intent = true, status = Status.Ready } = {}) {
  f.client.options = { intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, ...(intent ? [GatewayIntentBits.GuildMembers] : [])]) };
  f.guild.shard = { status };
  f.guild.members.me = f.me;
  f.guild.roles.cache.set('100', { id: '100', name: '@everyone', permissions: new PermissionsBitField(0n), rawPosition: 0 });
}

const ROUTES = [['user', f => [f.client.users, 'fetch']], ['application', f => [f.client.application, 'fetch']], ['guild', f => [f.client.rest, 'get']],
  ['member', f => [f.guild.members, 'fetch']], ['bot', f => [f.guild.members, 'fetchMe']], ['channel', f => [f.guild.channels, 'fetch']]];

// Counts every Discord REST read by route, with an optional injected latency.
function countReads(f, latencyMs = 0) {
  const counts = {};
  for (const [label, target] of ROUTES) {
    const [owner, key] = target(f); const original = owner[key].bind(owner);
    owner[key] = async (...args) => { counts[label] = (counts[label] || 0) + 1; if (latencyMs) await delay(latencyMs); return original(...args); };
  }
  return { counts, get total() { return Object.values(counts).reduce((sum, value) => sum + value, 0); }, reset() { for (const key of Object.keys(counts)) delete counts[key]; } };
}

async function harness(t, { latencyMs = 0, ...options } = {}, fixture) {
  const f = await portalFixture(t, fixture);
  gateway(f, options);
  const policy = createPortalPolicy(f.client, options.policy); t.after(() => policy.close());
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const commands = new Map(await loadCommandsData());
  const reads = countReads(f, latencyMs);
  return { ...f, policy, revisions, reads,
    run: (body, actorId = '200') => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId, expectedRevision: revisions.revision('100'), ...body }) };
}

// Runs `change` right after the player's playback write, before the reply's disclosure.
function afterWrite(f, method, change) {
  const original = f.player[method].bind(f.player);
  f.player[method] = async (...args) => { const result = await original(...args); await change(); return result; };
}

test('an audible control makes no Discord REST read once identity is remembered; the old final disclosure made a full round', async t => {
  const f = await harness(t, { latencyMs: 35 });
  // First command of a session: the final disclosure reads identity (user and owner) once.
  let start = performance.now(); assert.equal((await f.run({ command: 'pause' })).ok, true);
  const first = { reads: f.reads.total, ms: Math.round(performance.now() - start) };
  assert.deepEqual(f.reads.counts, { user: 1, application: 1 });
  f.reads.reset(); start = performance.now();
  assert.equal((await f.run({ command: 'resume' })).ok, true);
  const warm = { reads: f.reads.total, ms: Math.round(performance.now() - start) };
  assert.equal(warm.reads, 0, 'a warm audible control reads no Discord REST');
  // The disclosure as it was: a fresh REST round for the same actor and guild.
  f.reads.reset(); start = performance.now();
  await f.policy.guild('200', '100', undefined, { fresh: true });
  const before = { reads: f.reads.total, ms: Math.round(performance.now() - start) };
  assert.deepEqual(f.reads.counts, { user: 1, application: 1, guild: 1, member: 1, bot: 1, channel: 2 });
  t.diagnostic(`35 ms per route. Final disclosure before: ${before.reads} reads in ${before.ms} ms. Pause after: first ${first.reads} reads in ${first.ms} ms, warm ${warm.reads} reads in ${warm.ms} ms`);
});

test('the final disclosure falls back to a fresh REST round when the Gateway cache cannot vouch', async t => {
  const cases = {
    'members intent off': f => gateway(f, { intent: false }),
    'shard resuming': f => gateway(f, { status: Status.Resuming }),
    'actor not cached': f => {
      // REST still knows the actor; only the Gateway member cache lacks it.
      const actor = f.members.get('200'); f.members.delete('200'); const fetch = f.guild.members.fetch;
      f.guild.members.fetch = async query => { if (query.user !== '200') return fetch(query); f.reads.counts.member = (f.reads.counts.member || 0) + 1; return actor; };
    },
  };
  for (const [name, setup] of Object.entries(cases)) await t.test(name, async t => {
    const f = await harness(t);
    afterWrite(f, 'pause', () => { f.reads.reset(); setup(f); });
    assert.equal((await f.run({ command: 'pause' })).ok, true);
    // A fresh round: identity is read again, never taken from the remembered answer.
    assert.equal(f.reads.counts.user, 1); assert.equal(f.reads.counts.guild, 1); assert.equal(f.reads.counts.member, 1);
  });
});

test('final disclosure security: a revocation reported after the write hides the reply and snapshot', async t => {
  await t.test('controller channel hidden (channel overwrite update)', async t => {
    const f = await harness(t);
    afterWrite(f, 'skip', () => { f.channels.get('400').hidden.add('200'); });
    const result = await f.run({ command: 'skip' });
    assert.equal(result.message, 'Request completed.');
    assert.equal(result.snapshot.session.current, null); assert.deepEqual(result.snapshot.session.queue, []);
    assert.equal(f.reads.total, 2, 'decided from Gateway state plus the identity answer');
  });
  await t.test('member kicked (guildMemberRemove)', async t => {
    const f = await harness(t);
    afterWrite(f, 'pause', () => { f.members.delete('200'); });
    await assert.rejects(f.run({ command: 'pause' }), { status: 404 });
    assert.equal(f.reads.counts.member, 1, 'the uncached actor took the REST round');
  });
  await t.test('bot removed from the server (guildDelete)', async t => {
    const f = await harness(t);
    afterWrite(f, 'pause', () => { f.client.guilds.cache.delete('100'); });
    await assert.rejects(f.run({ command: 'pause' }), { status: 404 });
  });
  await t.test('Manage Server removed (role permission change)', async t => {
    const f = await harness(t);
    const update = f.library.updateGuild.bind(f.library);
    f.library.updateGuild = async (...args) => { const result = await update(...args); f.members.get('201').permissions = new PermissionsBitField([]); return result; };
    const result = await f.run({ command: 'settings', subcommand: 'volume', options: { value: 60 } }, '201');
    assert.equal(f.library.settings('100').volume, 60, 'the authorized write happened');
    assert.equal(result.message, 'Request completed.');
    assert.equal(result.snapshot.guild.admin, false); assert.equal(result.snapshot.settings, null);
  });
  await t.test('listening voice channel hidden', async t => {
    const f = await harness(t);
    afterWrite(f, 'skip', () => { f.channels.get('300').hidden.add('200'); });
    const result = await f.run({ command: 'skip' });
    assert.equal(result.message, 'Request completed.'); assert.equal(result.snapshot.session.current, null);
  });
});

test('protected reads use Gateway state with remembered identity; revocations apply to the next read', async t => {
  const f = await harness(t, { latencyMs: 35 });
  let start = performance.now(); let snapshot = await f.request();
  const first = { reads: f.reads.total, ms: Math.round(performance.now() - start) };
  assert.equal(snapshot.status, 200); assert.ok(snapshot.body.session.current);
  assert.deepEqual(f.reads.counts, { user: 1, application: 1 });
  f.reads.reset(); start = performance.now();
  for (const resource of ['', '/library', '/stats', '/recap']) await f.request(resource);
  const warm = { reads: f.reads.total, ms: Math.round(performance.now() - start) };
  assert.equal(warm.reads, 0, 'snapshot, library, stats and recap read no Discord REST while identity is remembered');
  t.diagnostic(`35 ms per route. Snapshot first ${first.reads} reads in ${first.ms} ms; four warm protected reads ${warm.reads} reads in ${warm.ms} ms`);

  // Channel overwrite update: the session disappears from the next snapshot.
  f.channels.get('400').hidden.add('200');
  assert.equal((await f.request()).body.session.current, null);
  f.channels.get('400').hidden.delete('200');
  // A history source hidden: its entries leave the library at once.
  await f.library.recordHistory({ guildId: '100', voiceChannelId: '301' }, f.player.queue.current);
  assert.equal((await f.request('/library')).body.history.length, 1);
  f.channels.get('301').hidden.add('200');
  assert.equal((await f.request('/library')).body.history.length, 0);
  // Role permission change: Manage Server removed from an admin.
  assert.equal((await f.request('', { actor: '201' })).body.guild.admin, true);
  f.members.get('201').permissions = new PermissionsBitField([]);
  const demoted = (await f.request('', { actor: '201' })).body;
  assert.equal(demoted.guild.admin, false); assert.equal(demoted.settings, null);
  assert.equal((await f.request('/diagnostics', { actor: '201' })).status, 403);
  // Kicked: no cached member, and the REST round finds no member.
  f.reads.reset(); f.members.delete('200');
  assert.equal((await f.request()).status, 404); assert.equal(f.reads.counts.member, 1);
  // Bot removed from the server.
  f.client.guilds.cache.delete('100');
  assert.equal((await f.request('', { actor: '202' })).status, 404);
});

test('protected reads take the REST round while the guild shard is not Ready', async t => {
  const f = await harness(t, { status: Status.Reconnecting });
  assert.equal((await f.request()).status, 200);
  assert.equal(f.reads.counts.guild, 1); assert.equal(f.reads.counts.member, 1); assert.ok(f.reads.counts.channel >= 2);
});

test('maintainer status on Gateway reads comes only from the verified owner, remembered for five minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await harness(t, {}, { owner: { id: '200' } });
  assert.equal((await f.request()).body.guild.admin, true, 'the application owner is a maintainer');
  f.client.application.fetch = async () => ({ owner: { id: '901' } });
  assert.equal((await f.request()).body.guild.admin, true, 'within the window the remembered owner applies');
  t.mock.timers.tick(IDENTITY_CACHE.applicationMs + 1);
  assert.equal((await f.request()).body.guild.admin, false, 'after five minutes the transfer applies');
  // Audible-control authority never grants maintainer access.
  assert.equal(f.policy.gatewayGuild('200', '100').maintainer, false);
});

test('identity answers: validated successes only, 30 s for the account, invalidated by userUpdate and close', async t => {
  let clock = 1_000_000;
  const f = await harness(t, { policy: { now: () => clock } });
  const { policy, reads } = f;
  await policy.identity('200'); await policy.identity('200');
  assert.deepEqual(reads.counts, { user: 1, application: 1 });
  clock += IDENTITY_CACHE.userMs + 1; await policy.identity('200');
  assert.deepEqual(reads.counts, { user: 2, application: 1 }, 'the account expires before the owner');
  // Failures and rejected accounts are never remembered.
  reads.reset(); const users = f.client.users.fetch;
  f.client.users.fetch = async () => { reads.counts.user = (reads.counts.user || 0) + 1; throw new Error('Discord unavailable'); };
  await assert.rejects(policy.identity('201'), /unavailable/); await assert.rejects(policy.identity('201'), /unavailable/);
  assert.equal(reads.counts.user, 2);
  f.client.users.fetch = async id => ({ id, bot: true });
  await assert.rejects(policy.identity('201'), { status: 403 }); await assert.rejects(policy.identity('201'), { status: 403 });
  f.client.users.fetch = users;
  // userUpdate forgets the account, including a read that straddles it.
  reads.reset(); f.client.emit('userUpdate', null, { id: '200' }); await policy.identity('200');
  assert.equal(reads.counts.user, 1);
  const held = deferred(); const fetch = f.client.users.fetch;
  f.client.users.fetch = async (...args) => { await held.promise; return fetch(...args); };
  const straddling = policy.identity('202'); await delay(5);
  f.client.emit('userUpdate', null, { id: '202' }); held.resolve(); await straddling;
  f.client.users.fetch = fetch; reads.reset(); await policy.identity('202');
  assert.equal(reads.counts.user, 1, 'a read that started before the invalidation is not remembered');
  // A fresh identity always reads, and close forgets everything.
  reads.reset(); await policy.identity('200', { fresh: true }); assert.deepEqual(reads.counts, { user: 1, application: 1 });
  policy.close(); reads.reset(); await policy.identity('200'); assert.deepEqual(reads.counts, { user: 1, application: 1 });
});

test('pre-mutation stages still read fresh REST; only the final disclosure may use Gateway state', async t => {
  for (const command of ['stop', 'shuffle']) await t.test(command, async t => {
    const f = await harness(t);
    let readsAtWrite = null;
    const method = command === 'stop' ? 'stopPlaying' : null;
    if (method) afterWrite(f, method, () => { readsAtWrite ??= f.reads.total; });
    else { const shuffle = f.player.queue.shuffle.bind(f.player.queue); f.player.queue.shuffle = async () => { readsAtWrite ??= f.reads.total; return shuffle(); }; }
    assert.equal((await f.run({ command })).ok, true);
    assert.ok(readsAtWrite >= 7, 'a full fresh REST round ran before the write');
  });
});

// Extra installed servers that share the fixture's members and channels.
function addGuilds(f, count) {
  const ids = [];
  for (let index = 0; index < count; index++) {
    const id = String(110 + index); ids.push(id);
    f.client.guilds.cache.set(id, { ...f.guild, id, name: `Server ${id}` });
    f.guild.roles.cache.set(id, { id, name: '@everyone', permissions: new PermissionsBitField(0n), rawPosition: 0 });
  }
  return ids;
}

test('bootstrap authorizes guilds together: one REST round for 12 uncached guilds, none from Gateway state', async t => {
  await t.test('Gateway cannot vouch (REST fallback)', async t => {
    const f = await harness(t, { intent: false, latencyMs: 35 }); addGuilds(f, 11);
    let active = 0, maximum = 0; const fetchMe = f.guild.members.fetchMe;
    f.guild.members.fetchMe = async (...args) => { maximum = Math.max(maximum, ++active); try { return await fetchMe(...args); } finally { active--; } };
    const start = performance.now(); const response = await f.request('/v1/bootstrap?actorId=200');
    const elapsed = Math.round(performance.now() - start);
    assert.equal(response.status, 200); assert.equal(response.body.guilds.length, 12);
    assert.deepEqual(response.body.guilds.map(guild => guild.id), ['100', ...Array.from({ length: 11 }, (_, index) => String(110 + index))]);
    assert.equal(response.body.voiceGuildId, '100');
    assert.equal(maximum, 12, 'every guild round in flight at once (previously four)');
    assert.equal(f.reads.counts.guild, 12);
    t.diagnostic(`12 guilds, 35 ms per route: ${f.reads.total} reads in ${elapsed} ms, one guild round after identity (previously three serial waves)`);
  });
  await t.test('Gateway vouches', async t => {
    const f = await harness(t, { latencyMs: 35 });
    for (const id of addGuilds(f, 11)) f.client.guilds.cache.get(id).shard = { status: Status.Ready };
    const start = performance.now(); const response = await f.request('/v1/bootstrap?actorId=200');
    const elapsed = Math.round(performance.now() - start);
    assert.equal(response.body.guilds.length, 12);
    assert.deepEqual(f.reads.counts, { user: 1, application: 1 }, 'identity only');
    t.diagnostic(`12 guilds from Gateway state: ${f.reads.total} reads (identity) in ${elapsed} ms`);
  });
  await t.test('a non-member guild is omitted and a failure stops the bootstrap', async t => {
    const f = await harness(t, { intent: false }); const [other] = addGuilds(f, 1);
    const fetch = f.guild.members.fetch;
    f.client.guilds.cache.get(other).members = { ...f.guild.members, fetch: async () => { throw Object.assign(new Error('Unknown member'), { code: 10007 }); } };
    assert.deepEqual((await f.request('/v1/bootstrap?actorId=200')).body.guilds.map(guild => guild.id), ['100']);
    f.guild.members.fetch = async () => { throw Object.assign(new Error('Discord down'), { status: 503 }); };
    assert.equal((await f.request('/v1/bootstrap?actorId=200')).status >= 500, true);
    f.guild.members.fetch = fetch;
  });
});
