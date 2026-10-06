import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createCommandTimings, commandTimingSpan, commandReadyForMutation, commandAuthorityPhase, commandAuthorityInput } from '../src/portal/timing.js';
import { createPortalPolicy } from '../src/portal/policy.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { createRevisions } from '../src/portal/projection.js';
import { loadCommandsData } from '../src/commands/index.js';
import { deferred, portalFixture } from './portal-fixtures.js';

function gate(width = 1) {
  const entered = deferred(), release = deferred(); let calls = 0;
  return { entered: entered.promise, release: release.resolve, async wait() {
    if (++calls === width) entered.resolve();
    await release.promise;
  } };
}

async function timedPolicy(t) {
  const f = await portalFixture(t); const policy = createPortalPolicy(f.client);
  t.after(() => policy.close());
  let elapsed = 0, now = 100;
  const timing = createCommandTimings({ clock: () => elapsed, wallClock: () => now });
  t.after(() => timing.close());
  return { ...f, policy, timing, advance(ms) { elapsed += ms; }, age(ms) { now += ms; },
    measure(name, operation, phase = 'native') {
      return timing.run(name, () => commandAuthorityPhase(phase, () => commandTimingSpan('authorization', operation)));
    } };
}

test('real direct handler separates slow final inputs from native readiness and parallel wait sums', async t => {
  const f = await timedPolicy(t); const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const commands = await loadCommandsData();
  // Identity, raw guild, both members and the two session channels of an actor
  // already in voice are one round per authority.
  const rounds = Array.from({ length: 2 }, () => [gate(7)]);
  t.after(() => rounds.flat().forEach(value => value.release()));
  for (const [target, method, stage] of [[f.client.users, 'fetch', 0], [f.client.application, 'fetch', 0],
    [f.client.rest, 'get', 0], [f.guild.members, 'fetch', 0], [f.guild.members, 'fetchMe', 0], [f.guild.channels, 'fetch', 0]]) {
    const original = target[method].bind(target); let calls = 0;
    target[method] = async (...args) => {
      const round = method === 'fetch' && target === f.guild.channels ? Math.floor(calls++ / 2) : calls++;
      await rounds[round][stage].wait(); return original(...args);
    };
  }
  const pause = f.player.pause.bind(f.player);
  f.player.pause = async () => { f.advance(5); return pause(); };
  const measuredPolicy = { guild: (...args) => commandTimingSpan('authorization', () => f.policy.guild(...args)) };
  let replied = false;
  const result = f.timing.run('pause', () => executePortalCommand(f.client, measuredPolicy, revisions, commands, '100',
    { actorId: '200', command: 'pause' })).then(value => { replied = true; return value; });
  for (let round = 0; round < 2; round++) for (let stage = 0; stage < 1; stage++) {
    await rounds[round][stage].entered;
    assert.equal(replied, false, 'reply still waits for the final fresh authority');
    if (round === 1) assert.deepEqual(f.calls, ['pause']);
    f.advance([[100], [300]][round][stage]); rounds[round][stage].release();
  }
  assert.equal((await result).ok, true); assert.deepEqual(f.calls, ['pause']);
  const record = f.timing.snapshot().records[0];
  assert.equal(record.readyForMutationMs, 100); assert.equal(record.totalMs, 405);
  assert.deepEqual(record.authorization, { count: 2, ms: 400 });
  assert.deepEqual(record.playback, { count: 1, ms: 5 });
  assert.deepEqual(record.presentation, { count: 0, ms: 0 });
  for (const [phase, waits, wallMs] of [['native', [100, 100, 100, 100, 100, 200], 100],
    ['finalDisclosure', [300, 300, 300, 300, 300, 600], 300]]) {
    const value = record.authority[phase]; assert.equal(value.count, 1); assert.equal(value.wallMs, wallMs);
    assert.deepEqual(Object.values(value.inputs).map(input => input.waitMs), waits);
    assert.ok(waits.reduce((sum, wait) => sum + wait, 0) > wallMs, 'overlapping waits are not reported as phase wall time');
    assert.equal(value.inputs.channels.count, 2); assert.equal(value.inputs.channels.maxMs, waits[5] / 2);
  }
  record.authority.native.inputs.user.waitMs = 999;
  assert.equal(f.timing.snapshot().records[0].authority.native.inputs.user.waitMs, 100, 'nested DTO is defensively cloned');
});

test('interleaved authority phases remain isolated while native readiness stays on each parent trace', async () => {
  let elapsed = 0; const timing = createCommandTimings({ clock: () => elapsed, wallClock: () => 0 });
  const first = deferred(), second = deferred();
  const pause = timing.run('pause', async () => {
    await commandAuthorityPhase('native', () => commandAuthorityInput('user', first.promise)); commandReadyForMutation();
  });
  elapsed = 10;
  const seek = timing.run('seek', async () => {
    await commandAuthorityPhase('finalDisclosure', () => commandAuthorityInput('botMember', second.promise)); commandReadyForMutation();
  });
  elapsed = 30; second.resolve(); await seek;
  elapsed = 50; first.resolve(); await pause;
  const [seekRecord, pauseRecord] = timing.snapshot().records;
  assert.equal(seekRecord.readyForMutationMs, 20); assert.equal(pauseRecord.readyForMutationMs, 50);
  assert.equal(seekRecord.authority.native.count, 0); assert.equal(pauseRecord.authority.finalDisclosure.count, 0);
  assert.equal(seekRecord.authority.finalDisclosure.inputs.botMember.waitMs, 20);
  assert.equal(seekRecord.authority.finalDisclosure.inputs.user.count, 0);
  assert.equal(pauseRecord.authority.native.inputs.user.waitMs, 50);
  assert.equal(pauseRecord.authority.native.inputs.botMember.count, 0);
});

test('overlapping policy callers measure their own waits without duplicating shared authority reads', async t => {
  const f = await timedPolicy(t); const release = gate(); t.after(() => release.release());
  const userFetch = f.client.users.fetch.bind(f.client.users); let users = 0;
  const memberFetch = f.guild.members.fetch.bind(f.guild.members); let members = 0;
  f.guild.members.fetch = (...args) => { members++; return memberFetch(...args); };
  f.client.users.fetch = async (...args) => { users++; await release.wait(); return userFetch(...args); };
  const first = f.measure('pause', () => f.policy.guild('200', '100')); await release.entered;
  f.advance(10);
  const second = f.measure('resume', () => f.policy.guild('200', '100')); await turn();
  f.advance(20); release.release(); await Promise.all([first, second]);
  assert.equal(users, 1); assert.equal(members, 1); assert.equal(f.channelReads.length, 2);
  const records = f.timing.snapshot().records;
  assert.equal(records.find(record => record.command === 'pause').authority.native.inputs.user.waitMs, 30);
  assert.equal(records.find(record => record.command === 'resume').authority.native.inputs.user.waitMs, 20);
  for (const record of records) {
    assert.equal(record.authority.native.inputs.channels.count, 2);
    assert.equal(record.authority.native.inputs.actorMember.count, 1);
  }
});

test('channel caller waits include time queued behind the unchanged four-slot ordinary pool', async t => {
  const f = await timedPolicy(t); const occupying = gate(4), queued = gate(2);
  t.after(() => { occupying.release(); queued.release(); });
  const original = f.guild.channels.fetch.bind(f.guild.channels); let calls = 0, active = 0, maximum = 0;
  f.guild.channels.fetch = async (...args) => {
    const slot = ++calls; active++; maximum = Math.max(maximum, active);
    try { await (slot <= 4 ? occupying : queued).wait(); return original(...args); } finally { active--; }
  };
  const blockers = Promise.all([f.policy.guild('200', '100', undefined, { fresh: true }), f.policy.guild('201', '100', undefined, { fresh: true })]);
  await occupying.entered;
  const command = f.measure('pause', () => f.policy.guild('200', '100', undefined, { fresh: true })); await turn();
  assert.equal(calls, 4); f.advance(40); occupying.release(); await queued.entered;
  f.advance(30); queued.release(); await Promise.all([blockers, command]);
  assert.equal(maximum, 4);
  const phase = f.timing.snapshot().records[0].authority.native;
  assert.equal(phase.wallMs, 70);
  assert.deepEqual(phase.inputs.channels, { count: 2, waitMs: 140, maxMs: 70, timeouts: 0 });
});

test('caller timeout retains all original read admissions and late settlement cannot alter or resurrect the record', async t => {
  const f = await portalFixture(t); const release = deferred(); t.after(() => release.resolve());
  const actors = Array.from({ length: 128 }, (_, index) => String(1000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: [...actors, '200'] }); t.after(() => policy.close());
  let now = 0; const timing = createCommandTimings({ clock: () => now, wallClock: () => now });
  const userFetch = f.client.users.fetch.bind(f.client.users); let started = 0;
  f.client.users.fetch = async id => {
    if (actors.includes(id)) { started++; await release.promise; return { id, bot: false }; }
    return userFetch(id);
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tracked = timing.run('pause', () => commandAuthorityPhase('native', () => policy.identity(actors[0], { fresh: true })));
  const rejected = assert.rejects(tracked, /too long/);
  const otherCallers = Promise.allSettled(actors.slice(1).map(actor => policy.identity(actor, { fresh: true })));
  await turn(); assert.equal(started, 128);
  now = 5000; t.mock.timers.tick(5000); await rejected; await otherCallers;
  const published = timing.snapshot(); const input = published.records[0].authority.native.inputs.user;
  assert.deepEqual(input, { count: 1, waitMs: 5000, maxMs: 5000, timeouts: 1 });
  await assert.rejects(policy.identity('200', { fresh: true }), { status: 429 });
  assert.equal((await policy.identity('200', { fresh: true, urgent: true })).user.id, '200', 'reserved Stop admission remains available');
  now = 6000; release.resolve(); await turn();
  assert.deepEqual(timing.snapshot(), published, 'underlying late settlement changes no published numeric fields');
  assert.equal((await policy.identity('200', { fresh: true })).user.id, '200', 'admission releases only at underlying settlement');
  now = 905_001; assert.equal(timing.snapshot().records.length, 0); await turn();
  assert.equal(timing.snapshot().records.length, 0);
  t.mock.timers.reset(); timing.close();
});

test('timed-out channel jobs retain their pool slots and queued work cannot mutate a published trace', async t => {
  const f = await timedPolicy(t); const occupying = gate(4), urgentGate = gate(2);
  t.after(() => { occupying.release(); urgentGate.release(); });
  const original = f.guild.channels.fetch.bind(f.guild.channels); let calls = 0, active = 0, maximum = 0;
  f.guild.channels.fetch = async (...args) => {
    const slot = ++calls; active++; maximum = Math.max(maximum, active);
    try {
      if (slot <= 4) await occupying.wait();
      else if (slot <= 6) await urgentGate.wait();
      return original(...args);
    } finally { active--; }
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const blockers = Promise.allSettled([f.policy.guild('200', '100', undefined, { fresh: true }), f.policy.guild('201', '100', undefined, { fresh: true })]);
  await occupying.entered;
  const pending = f.measure('pause', () => f.policy.guild('200', '100', undefined, { fresh: true }));
  const denied = assert.rejects(pending, /too long/); await turn();
  assert.equal(calls, 4); f.advance(5000); t.mock.timers.tick(5000); await denied; await blockers;
  const published = f.timing.snapshot(); assert.equal(calls, 4); assert.equal(active, 4);
  assert.equal(published.records[0].authority.native.inputs.channels.timeouts, 2);
  const urgentRead = f.policy.guild('200', '100', undefined, { fresh: true, urgent: true });
  await urgentGate.entered; assert.equal(maximum, 6); urgentGate.release();
  const urgent = await urgentRead;
  assert.equal(urgent.channels.size, 2); assert.equal(calls, 6); assert.equal(maximum, 6, 'only the existing two urgent slots supplement the ordinary four');
  f.advance(200); occupying.release(); await turn();
  assert.equal(calls, 8, 'queued underlying jobs remain admitted and finish after the pool releases');
  assert.deepEqual(f.timing.snapshot(), published);
  t.mock.timers.reset();
});

test('arbitrary phase/input labels and private upstream errors never enter timing DTOs', async () => {
  const timing = createCommandTimings({ wallClock: () => 1 }); const secret = 'private-user-guild-channel-role-grant-label';
  const failure = Object.assign(new Error(secret), { code: secret, roles: [secret], grants: { [secret]: true } });
  await assert.rejects(timing.run('pause', () => commandAuthorityPhase('native', () => commandAuthorityInput(secret, Promise.reject(failure)))), error => error === failure);
  await assert.rejects(timing.run('resume', () => commandAuthorityPhase('finalDisclosure', () => commandAuthorityInput('user',
    Promise.reject(new Error('The audio source took too long to respond. Try again in a moment.'))))), /too long/);
  await timing.run('volume', () => commandAuthorityPhase(secret, () => commandAuthorityInput('user', Promise.resolve(secret))));
  await timing.run(secret, () => commandAuthorityPhase('native', () => commandAuthorityInput('user', Promise.resolve(secret))));
  const records = timing.snapshot().records; assert.equal(records.length, 3);
  assert.ok(!JSON.stringify(records).includes(secret));
  assert.equal(records[0].authority.native.inputs.user.count, 0);
  assert.equal(records[1].authority.finalDisclosure.inputs.user.timeouts, 0, 'upstream error text is not a caller timeout');
  assert.equal(records[2].authority.native.count, 0); assert.equal(records[2].authority.finalDisclosure.count, 0);
});

test('failed parallel authority and detached aggregate spans cannot update the sealed parent trace', async () => {
  let elapsed = 0; const timing = createCommandTimings({ clock: () => elapsed, wallClock: () => 0 });
  const late = deferred(); const failure = new Error('private authority failure'); let detached;
  await assert.rejects(timing.run('pause', () => {
    detached = commandTimingSpan('presentation', async () => { await late.promise; commandReadyForMutation(); });
    return commandAuthorityPhase('native', () => Promise.all([
      commandAuthorityInput('user', Promise.reject(failure)), commandAuthorityInput('application', late.promise),
    ]));
  }), error => error === failure);
  const published = timing.snapshot(); elapsed = 900; late.resolve(); await detached; await turn();
  assert.deepEqual(timing.snapshot(), published);
  assert.equal(published.records[0].readyForMutationMs, null);
  assert.equal(published.records[0].authority.native.inputs.application.count, 1);
  assert.equal(published.records[0].authority.native.inputs.application.waitMs, 0, 'outstanding sibling waits are frozen at phase failure');
});

test('expired active traces and closed timing collectors cannot reappear after late authority settlement', async () => {
  for (const kind of ['expiry', 'close']) {
    let now = 0; const timing = createCommandTimings({ wallClock: () => now, clock: () => now }); const late = deferred();
    await timing.run('volume', () => 1);
    const pending = timing.run('pause', () => commandAuthorityPhase('native', () => commandAuthorityInput('user', late.promise)));
    if (kind === 'expiry') now = 900_001; else timing.close();
    assert.equal(timing.snapshot().records.length, 0);
    late.resolve(); await pending;
    assert.equal(timing.snapshot().records.length, 0);
    if (kind === 'close') { await timing.run('resume', () => 1); assert.equal(timing.snapshot().records.length, 0); }
  }
});
