import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { createPortalPolicy, requirePlayback } from '../src/portal/policy.js';
import { portalFixture, deferred } from './portal-fixtures.js';

function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function identityFixture(t, options = {}) {
  const user = { id: '200', bot: false, username: 'Fresh user' };
  const owner = { id: '900' };
  const counts = { user: 0, application: 0 };
  const client = { isReady: () => true, library: {}, runtimeState: { draining: false },
    users: { async fetch(id, options) { counts.user++; assert.equal(options.force, true); return id === user.id ? user : { id, bot: false }; } },
    application: { async fetch() { counts.application++; return { owner }; } },
    guilds: { cache: new Map([['100', {}]]), fetch: () => assert.fail('failed identity must not start guild work') },
  };
  const policy = createPortalPolicy(client, options); t.after(() => policy.close());
  return { client, policy, user, owner, counts };
}

// Load the actual module with only its identity body restored to the reviewed
// sequential baseline. All admission, guild and channel code stays identical.
async function serialPolicy() {
  const url = new URL('../src/portal/policy.js', import.meta.url);
  const source = await readFile(url, 'utf8');
  const start = source.indexOf('  const identity = async');
  const end = source.indexOf('  const guild = async', start);
  assert.ok(start >= 0 && end > start);
  const baseline = `  const identity = async (actorId, { fresh = false, urgent = false } = {}) => {
    ready();
    if (!validId(actorId)) fail(400, 'invalid_actor', 'A valid session actor is required.');
    const user = await read(\`user:\${actorId}\`, async () => detachUser(await client.users.fetch(actorId, { force: true })), fresh, urgent);
    if (!user || user.id !== actorId || user.bot) fail(403, 'forbidden', 'This account cannot use the portal.');
    let maintainer = operators.has(actorId);
    if (!maintainer) {
      const ownerId = await read('application', async () => {
        const { owner } = await client.application.fetch();
        return owner?.ownerId || owner?.id;
      }, fresh, urgent);
      maintainer = actorId === ownerId;
    }
    return { user, maintainer };
  };
`;
  // Resolve package imports through this test; data URLs have no package base.
  const resolved = (source.slice(0, start) + baseline + source.slice(end)).replace(/from '([^']+)'/g, (match, specifier) =>
    `from '${specifier.startsWith('.') ? new URL(specifier, url).href : import.meta.resolve(specifier)}'`);
  return (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).createPortalPolicy;
}

test('actual policy removes one injected identity round with identical fetch counts and width two', async t => {
  const sequential = await serialPolicy();
  const results = [];
  for (const factory of [sequential, createPortalPolicy]) {
    const f = await portalFixture(t); let active = 0, maximum = 0;
    const events = [], counts = {};
    for (const [target, method, label] of [
      [f.client.users, 'fetch', 'user'], [f.client.application, 'fetch', 'application'],
      [f.client.guilds, 'fetch', 'guild'], [f.guild.members, 'fetch', 'member'],
      [f.guild.roles, 'fetch', 'roles'], [f.guild.members, 'fetchMe', 'bot'], [f.guild.channels, 'fetch', 'channel'],
    ]) {
      const original = target[method].bind(target);
      target[method] = async (...args) => {
        counts[label] = (counts[label] || 0) + 1; events.push(`start:${label}`);
        maximum = Math.max(maximum, ++active);
        try { await delay(35); return await original(...args); }
        finally { active--; events.push(`end:${label}`); }
      };
    }
    const policy = factory(f.client); t.after(() => policy.close());
    const start = performance.now(); const context = await policy.guild('200', '100', undefined, { fresh: true });
    const elapsed = Math.round(performance.now() - start);
    requirePlayback(context, f.client); assert.equal(context.admin, false); assert.notEqual(context.user, f.users.get('200'));
    assert.equal(maximum, 2); assert.equal(active, 0);
    results.push({ counts, events, elapsed });
  }
  assert.deepEqual(results[0].counts, { user: 1, application: 1, guild: 1, member: 1, roles: 1, bot: 1, channel: 2 });
  assert.deepEqual(results[1].counts, results[0].counts);
  assert.ok(results[0].events.indexOf('start:application') > results[0].events.indexOf('end:user'));
  assert.ok(results[1].events.indexOf('start:application') < results[1].events.indexOf('end:user'));
  for (const result of results) assert.ok(result.events.indexOf('start:guild') > result.events.indexOf('end:application'));
  t.diagnostic(`35 ms injected routes: sequential ${results[0].elapsed} ms / six rounds; overlap ${results[1].elapsed} ms / five rounds; eight fetches each, maximum width two`);
});

test('readiness and actor-ID validation reject before either identity read starts', async t => {
  const f = identityFixture(t);
  await assert.rejects(f.policy.identity('invalid'), { status: 400, code: 'invalid_actor' });
  f.client.isReady = () => false;
  await assert.rejects(f.policy.identity('200'), { status: 503 });
  f.client.isReady = () => true; f.client.runtimeState.draining = true;
  await assert.rejects(f.policy.identity('200'), { status: 503 });
  assert.deepEqual(f.counts, { user: 0, application: 0 });
});

test('missing, mismatched and bot actors gain no authority even when application owner matches', async t => {
  for (const user of [null, { id: '201', bot: false }, { id: '200', bot: true }]) await t.test(String(user?.id || 'missing') + ':' + Boolean(user?.bot), async t => {
    const f = identityFixture(t); f.owner.id = '200';
    f.client.users.fetch = async () => { f.counts.user++; return user; };
    await assert.rejects(f.policy.guild('200', '100'), { status: 403, code: 'forbidden' });
    assert.deepEqual(f.counts, { user: 1, application: 1 });
  });
});

test('both identity promises remain observed when user or owner fails first and its sibling fails later', async t => {
  for (const first of ['user', 'owner']) await t.test(first, async t => {
    const f = identityFixture(t), user = gate(), owner = gate();
    t.after(() => { user.resolve(f.user); owner.resolve({ owner: f.owner }); });
    f.client.users.fetch = () => user.promise; f.client.application.fetch = () => owner.promise;
    const reading = f.policy.identity('200'); const failed = assert.rejects(reading, new RegExp(`${first} failed`));
    await tick(); (first === 'user' ? user : owner).reject(new Error(`${first} failed`)); await failed;
    (first === 'user' ? owner : user).reject(new Error('sibling failed later'));
    // The test runner treats an unobserved late rejection as a test failure.
    await tick(); await tick();
  });
});

test('owner failure denies valid non-operators even on a private noncommercial application', async t => {
  const f = identityFixture(t); f.client.application.botPublic = false;
  f.client.application.fetch = async () => { throw new Error('owner unavailable'); };
  await assert.rejects(f.policy.guild('200', '100'), /owner unavailable/);
});

test('user response detaches inside its read before the application-owner wait finishes', async t => {
  const f = identityFixture(t), owner = deferred(); t.after(() => owner.resolve({ owner: f.owner }));
  f.client.application.fetch = () => owner.promise;
  const reading = f.policy.identity('200'); let settled = false; void reading.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  f.user.id = '201'; f.user.bot = true; f.user.username = 'Gateway patch';
  owner.resolve({ owner: { id: '200' } }); const result = await reading;
  assert.deepEqual(result.user, { id: '200', bot: false, username: 'Fresh user' }); assert.equal(result.maintainer, true);
});

test('owner scalar detaches before user wait; ownership transfers are fresh and team members get no grant', async t => {
  for (const team of [false, true]) await t.test(team ? 'team owner' : 'user owner', async t => {
    const f = identityFixture(t), user = deferred(); t.after(() => user.resolve(f.user));
    if (team) { f.owner.ownerId = '900'; f.owner.id = '700'; f.owner.members = new Map([['200', f.user]]); }
    f.client.users.fetch = () => user.promise;
    const reading = f.policy.identity('200'); await tick();
    if (team) f.owner.ownerId = '200'; else f.owner.id = '200';
    user.resolve(f.user); assert.equal((await reading).maintainer, false);
    assert.equal((await f.policy.identity('200')).maintainer, true);
    if (team) f.owner.ownerId = '901'; else f.owner.id = '901';
    assert.equal((await f.policy.identity('200')).maintainer, false);
    assert.equal(f.counts.application, 3);
  });
});

test('explicit trusted operators skip application reads but still require a valid non-bot user', async t => {
  const f = identityFixture(t, { operatorIds: ['200'] });
  f.client.application.fetch = () => assert.fail('operators must not read application ownership');
  assert.equal((await f.policy.identity('200', { fresh: true })).maintainer, true);
  f.user.bot = true; await assert.rejects(f.policy.identity('200'), { status: 403 });
  assert.deepEqual(f.counts, { user: 2, application: 0 });
});

test('overlapping ordinary identities share pending inputs; fresh identities and settled reads never share', async t => {
  const f = identityFixture(t), release = deferred(); t.after(() => release.resolve());
  const user = f.client.users.fetch.bind(f.client.users), owner = f.client.application.fetch.bind(f.client.application);
  f.client.users.fetch = async (...args) => { const result = await user(...args); await release.promise; return result; };
  f.client.application.fetch = async () => { const result = await owner(); await release.promise; return result; };
  const ordinary = [f.policy.identity('200'), f.policy.identity('200')];
  await tick(); assert.deepEqual(f.counts, { user: 1, application: 1 });
  const fresh = [f.policy.identity('200', { fresh: true }), f.policy.identity('200', { fresh: true })];
  await tick(); assert.deepEqual(f.counts, { user: 3, application: 3 });
  release.resolve(); await Promise.all([...ordinary, ...fresh]);
  f.owner.id = '200'; assert.equal((await f.policy.identity('200')).maintainer, true);
  assert.deepEqual(f.counts, { user: 4, application: 4 });
});

test('no guild work starts while identity is pending; fresh role revocation and Gateway voice movement still deny playback', async t => {
  const f = await portalFixture(t), owner = deferred(), channels = deferred(), entered = deferred();
  t.after(() => { owner.resolve({ owner: { id: '900' } }); channels.resolve(); });
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  await f.library.updateGuild('100', data => { data.settings.djRoleId = '500'; });
  f.members.get('200').roles.cache.set('500', f.roles.get('500'));
  f.client.application.fetch = () => owner.promise;
  const fetchGuild = f.client.guilds.fetch.bind(f.client.guilds); let guildReads = 0;
  f.client.guilds.fetch = async (...args) => { guildReads++; return fetchGuild(...args); };
  const fetchChannel = f.guild.channels.fetch.bind(f.guild.channels);
  f.guild.channels.fetch = async (...args) => { entered.resolve(); await channels.promise; return fetchChannel(...args); };
  const reading = policy.guild('200', '100', undefined, { fresh: true }); await tick();
  assert.equal(guildReads, 0); assert.equal(f.memberFetches, 0); assert.equal(f.channelReads.length, 0);
  f.roles.delete('500'); owner.resolve({ owner: { id: '900' } }); await entered.promise;
  f.members.get('200').permissions = new PermissionsBitField([P.ManageGuild]);
  f.members.get('200').roles.cache.set('500', { id: '500' });
  f.members.get('200').voice.channel = f.channels.get('301'); channels.resolve();
  const context = await reading; assert.equal(context.guildAdmin, false); assert.equal(context.roleIds.has('500'), false);
  assert.throws(() => requirePlayback(context, f.client), { status: 403, code: 'wrong_voice' });
  f.members.get('200').voice.channel = f.channels.get('300');
  assert.throws(() => requirePlayback(context, f.client), { status: 403, code: 'dj_required' });
  assert.deepEqual(f.calls, []);
});

test('128 underlying ordinary reads retain admissions after five-second timeouts; urgent identity and guild work fit two reserved slots', { timeout: 9000 }, async t => {
  const f = await portalFixture(t), release = deferred(), urgentRelease = deferred();
  t.after(() => { release.resolve(); urgentRelease.resolve(); });
  const operators = Array.from({ length: 128 }, (_, index) => String(1000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: operators }); t.after(() => policy.close());
  const fetchUser = f.client.users.fetch.bind(f.client.users), fetchOwner = f.client.application.fetch.bind(f.client.application);
  let heldCalls = 0, urgentUsers = 0, urgentOwners = 0;
  f.client.users.fetch = async (id, options) => {
    if (operators.includes(id)) { heldCalls++; await release.promise; return { id, bot: false }; }
    if (id === '200') { urgentUsers++; await urgentRelease.promise; }
    return fetchUser(id, options);
  };
  f.client.application.fetch = async () => { urgentOwners++; await urgentRelease.promise; return fetchOwner(); };
  // These real operator reads consume exactly one admission each and bypass
  // owner reads by the existing explicit operator contract, without a grant shortcut.
  const ordinary = operators.map(id => policy.identity(id));
  const timedOut = Promise.allSettled(ordinary); await tick(); assert.equal(heldCalls, 128);
  await assert.rejects(policy.identity('200', { fresh: true }), { status: 429 });
  const urgent = policy.identity('200', { fresh: true, urgent: true });
  const urgentTimeout = assert.rejects(urgent, /too long/); await tick();
  assert.equal(urgentUsers, 1); assert.equal(urgentOwners, 1);
  await assert.rejects(policy.identity('201', { fresh: true, urgent: true }), { status: 429 }, 'both reserved admissions are held');
  const outcomes = await timedOut;
  await urgentTimeout;
  assert.ok(outcomes.every(result => result.status === 'rejected' && /too long/.test(result.reason.message)));
  await assert.rejects(policy.identity('200', { fresh: true }), { status: 429 }, 'timeouts must not release underlying admissions');
  const shared = policy.identity(operators[0]); const sharedOutcome = Promise.allSettled([shared]); await tick();
  assert.equal(heldCalls, 128, 'a timed-out pending read still coalesces');
  await assert.rejects(policy.identity(operators[0], { fresh: true }), { status: 429 });
  await assert.rejects(policy.identity('201', { fresh: true, urgent: true }), { status: 429 }, 'urgent timeouts must retain both underlying admissions');
  urgentRelease.resolve(); await tick();
  let active = 0, maximum = 0;
  for (const [target, method] of [[f.client.users, 'fetch'], [f.client.application, 'fetch'], [f.client.guilds, 'fetch'],
    [f.guild.members, 'fetch'], [f.guild.roles, 'fetch'], [f.guild.members, 'fetchMe'], [f.guild.channels, 'fetch']]) {
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      maximum = Math.max(maximum, ++active);
      try { await tick(); return await original(...args); } finally { active--; }
    };
  }
  const context = await policy.guild('200', '100', undefined, { fresh: true, urgent: true });
  requirePlayback(context, f.client); assert.equal(maximum, 2); assert.equal(context.channels.size, 2); assert.deepEqual(f.calls, []);
  release.resolve(); assert.equal((await sharedOutcome)[0].status, 'fulfilled');
  assert.equal((await policy.identity(operators[0], { fresh: true })).user.id, operators[0]); assert.equal(heldCalls, 129);
});
