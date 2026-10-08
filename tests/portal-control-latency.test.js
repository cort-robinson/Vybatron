import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { FilterManager } from 'lavalink-client';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createPortalPolicy } from '../src/portal/policy.js';
import { createRevisions } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';
import { withGuildMutation } from '../src/utils/requests.js';
import { setMaintenance } from '../src/utils/maintenance.js';

async function harness(t) {
  const f = await portalFixture(t);
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  const revisions = createRevisions(f.client);
  t.after(() => revisions.close());
  const commands = new Map(await loadCommandsData());
  const phases = [];
  const measuredPolicy = { async guild(...args) {
    const phase = { start: performance.now(), options: args[3] }; phases.push(phase);
    const context = await policy.guild(...args); phase.end = performance.now(); return context;
  } };
  return { ...f, phases, policy, commands, revisions,
    run: body => executePortalCommand(f.client, measuredPolicy, revisions, commands, '100', { actorId: '200', ...body }),
  };
}

test('actual direct handlers reduce full policy latency before playback and retain fresh disclosure', async t => {
  for (const name of ['pause', 'resume', 'seek', 'filter', 'volume']) await t.test(name, async t => {
    const f = await harness(t);
    if (name === 'resume') { f.player.paused = true; f.player.playing = false; }
    let fetches = 0;
    for (const [owner, key] of [[f.client.users, 'fetch'], [f.client.application, 'fetch'], [f.client.rest, 'get'],
      [f.guild.members, 'fetch'], [f.guild.members, 'fetchMe'], [f.guild.channels, 'fetch']]) {
      const original = owner[key].bind(owner);
      owner[key] = async (...args) => { fetches++; await delay(20); return original(...args); };
    }
    let firstWrite, phasesAtWrite;
    const write = () => { firstWrite ??= performance.now(); phasesAtWrite ??= f.phases.length; };
    const method = { pause: 'pause', resume: 'resume', seek: 'seek', volume: 'setVolume' }[name];
    if (method) {
      const original = f.player[method].bind(f.player);
      f.player[method] = async (...args) => { write(); return original(...args); };
    } else {
      f.player.filterManager = new FilterManager(f.player);
      f.player.filterManager.applyPlayerFilters = async () => { write(); f.calls.push('filter'); };
    }
    const options = { seek: { timestamp: '00:20' }, filter: { preset: 'warm' }, volume: { level: 40 } }[name];
    const started = performance.now();
    const result = await f.run({ command: name, options, expectedRevision: f.revisions.revision('100') });
    const elapsed = performance.now() - started;
    t.diagnostic(JSON.stringify({ command: name, phases: f.phases.length, fetches, phasesAtWrite,
      firstWriteMs: Math.round(firstWrite - started), replyMs: Math.round(elapsed) }));
    assert.equal(result.ok, true); assert.ok(firstWrite, 'real handler reached the mocked playback transport');
    assert.equal(f.phases.length, 2); assert.equal(phasesAtWrite, 1); assert.equal(fetches, 14);
    assert.ok(f.phases.every(phase => phase.options.fresh === true));
    assert.ok(f.phases[0].start >= started && f.phases[0].end <= firstWrite && f.phases[1].start >= firstWrite);
    const measuredPolicyMs = f.phases.reduce((sum, phase) => sum + phase.end - phase.start, 0);
    assert.ok(f.phases.every(phase => phase.end - phase.start >= 19), 'each phase awaited injected network latency (1 ms timer tolerance)');
    assert.ok(f.phases[1].end <= started + elapsed && elapsed >= measuredPolicyMs, 'reply waited for fresh disclosure');
  });
});

test('queue and transport controls authorize once at their native guard and once for disclosure', async t => {
  const cases = {
    skip: [{}, 'skip'], skipto: [{ position: 2 }, 'skip'], loop: [{ mode: 'track' }, 'loop'], shuffle: [{}, 'shuffle'],
    remove: [{ position: 1 }, 'splice'], move: [{ from: 1, to: 2 }, 'splice'], clear: [{}, 'splice'],
  };
  for (const [name, [options, write]] of Object.entries(cases)) await t.test(name, async t => {
    const f = await harness(t);
    let phasesAtWrite;
    const before = f.calls.length;
    const push = f.calls.push.bind(f.calls);
    f.calls.push = (...items) => { if (items.includes(write)) phasesAtWrite ??= f.phases.length; return push(...items); };
    const result = await f.run({ command: name, options, expectedRevision: f.revisions.revision('100') });
    assert.equal(result.ok, true); assert.ok(f.calls.length > before, 'the real handler wrote playback state');
    assert.equal(phasesAtWrite, 1, 'one fresh authority precedes the write');
    assert.equal(f.phases.length, 2); assert.ok(f.phases.every(phase => phase.options.fresh === true));
  });
});

test('lane wait retires authority and denies membership, visibility, and DJ revocation before any write', async t => {
  for (const kind of ['membership', 'visibility', 'DJ']) await t.test(kind, async t => {
    const f = await harness(t);
    if (kind === 'DJ') {
      await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
      f.members.get('200').roles.cache.set('500', f.roles.get('500'));
    }
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const lane = withGuildMutation('100', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const pending = f.run({ command: 'pause' });
    await delay(15);
    assert.equal(f.phases.length, 0, 'no authority collected before the lane');
    if (kind === 'membership') f.members.delete('200');
    if (kind === 'visibility') f.channels.get('400').hidden.add('200');
    if (kind === 'DJ') f.members.get('200').roles.cache.delete('500');
    const denied = assert.rejects(pending, error => [403, 404].includes(error.status));
    release.resolve(); await Promise.all([lane, denied]); assert.deepEqual(f.calls, []);
  });
});

test('unauthorized direct requests remain bounded by the twelve-entry lane before Discord work', async t => {
  const f = await harness(t); f.members.delete('200');
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const lane = withGuildMutation('100', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const waiting = Array.from({ length: 11 }, () => assert.rejects(f.run({ command: 'pause' }), { status: 404 }));
  await delay(10);
  await assert.rejects(f.run({ command: 'pause' }), /queue is busy/);
  assert.equal(f.phases.length, 0);
  release.resolve(); await Promise.all([lane, ...waiting]); assert.deepEqual(f.calls, []);
});

test('native initial guard stays fresh even when dispatch gains a hidden asynchronous wait', async t => {
  for (const name of ['pause', 'resume', 'seek', 'filter', 'volume']) {
    for (const kind of ['membership', 'visibility', 'DJ']) await t.test(`${name}: ${kind}`, async t => {
      const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
      if (name === 'resume') f.player.paused = true;
      if (kind === 'DJ') {
        await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
        f.members.get('200').roles.cache.set('500', f.roles.get('500'));
      }
      const original = f.commands.get(name);
      f.commands.set(name, { ...original, async execute(interaction) {
        assert.equal(interaction.deferred, true, 'deferred proxy works before any authority exists');
        for (const key of ['user', 'member', 'guild', 'memberPermissions']) assert.equal(interaction[key], undefined);
        assert.equal(f.phases.length, 0, 'dispatch cannot reuse any earlier authority');
        entered.resolve(); await release.promise; return original.execute(interaction);
      } });
      const options = { seek: { timestamp: '00:20' }, filter: { preset: 'warm' }, volume: { level: 40 } }[name];
      const pending = f.run({ command: name, options, expectedRevision: f.revisions.revision('100') }); await entered.promise;
      if (kind === 'membership') f.members.delete('200');
      if (kind === 'visibility') f.channels.get('400').hidden.add('200');
      if (kind === 'DJ') f.members.get('200').roles.cache.delete('500');
      const denied = assert.rejects(pending, { status: kind === 'membership' ? 404 : 403 }); release.resolve(); await denied;
      assert.equal(f.phases.length, 1); assert.deepEqual(f.calls, []);
    });
  }
});

test('target validation, recovery, and revisions still reject without playback writes', async t => {
  for (const kind of ['invalid seek', 'invalid option', 'recovery', 'stale revision', 'ended session']) await t.test(kind, async t => {
    const f = await harness(t); let body = { command: 'pause' };
    if (kind === 'invalid seek') body = { command: 'seek', options: { timestamp: '99:59' }, expectedRevision: f.revisions.revision('100') };
    if (kind === 'invalid option') body = { command: 'volume', options: { level: 101 } };
    if (kind === 'recovery') { f.player.LavalinkManager = f.manager; f.manager.playbackRecovery = { isRecovering: () => true }; }
    if (kind === 'stale revision') { body.expectedRevision = f.revisions.revision('100'); f.player.queue.tracks.pop(); }
    if (kind === 'ended session') f.manager.players.delete('100');
    await assert.rejects(f.run(body), error => [400, 403, 409].includes(error.status)); assert.deepEqual(f.calls, []);
  });
});

test('gateway voice movement during the native policy phase rejects same-voice control', async t => {
  const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const original = f.guild.channels.fetch.bind(f.guild.channels);
  f.guild.channels.fetch = async (...args) => {
    if (f.phases.length === 1 && args[0] === '400') { entered.resolve(); await release.promise; }
    return original(...args);
  };
  const pending = f.run({ command: 'pause' }); await entered.promise;
  f.members.get('200').voice.channel = f.channels.get('301');
  const denied = assert.rejects(pending, { status: 403 }); release.resolve(); await denied; assert.deepEqual(f.calls, []);
});

test('player replacement, track end, and gateway loss during native verification cannot authorize the old intent', async t => {
  for (const kind of ['player replacement', 'track end', 'gateway loss']) await t.test(kind, async t => {
    const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    const original = f.guild.channels.fetch.bind(f.guild.channels);
    f.guild.channels.fetch = async (...args) => {
      if (f.phases.length === 1 && args[0] === '400') { entered.resolve(); await release.promise; }
      return original(...args);
    };
    const pending = f.run({ command: 'pause', expectedRevision: f.revisions.revision('100') }); await entered.promise;
    if (kind === 'player replacement') f.manager.createPlayer({});
    if (kind === 'track end') { f.player.queue.current = f.player.queue.tracks.shift(); f.manager.emit('trackEnd', f.player); }
    if (kind === 'gateway loss') f.client.isReady = () => false;
    const denied = assert.rejects(pending, { status: kind === 'gateway loss' ? 503 : 409 });
    release.resolve(); await denied; assert.deepEqual(f.calls, []);
  });
});

test('final visibility and membership revocations suppress protected disclosure after exactly one write', async t => {
  for (const kind of ['visibility', 'membership']) await t.test(kind, async t => {
    const f = await harness(t); const original = f.player.pause.bind(f.player);
    f.player.pause = async () => {
      await original();
      if (kind === 'visibility') f.channels.get('400').hidden.add('200');
      else f.members.delete('200');
    };
    if (kind === 'membership') await assert.rejects(f.run({ command: 'pause' }), { status: 404 });
    else {
      const result = await f.run({ command: 'pause' });
      assert.equal(result.snapshot.session.current, null); assert.equal(result.message, 'Request completed.');
    }
    assert.deepEqual(f.calls, ['pause']); assert.equal(f.phases.length, 2);
  });
});

test('Stop takes over a waiting direct control without reviving the old player', async t => {
  const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const lane = withGuildMutation('100', async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const pending = assert.rejects(f.run({ command: 'pause' }), /cancelled by Stop/); await delay(10);
  const stopped = await Promise.race([f.run({ command: 'stop', expectedRevision: 'a'.repeat(32) }),
    delay(1000).then(() => assert.fail('Stop waited for the direct-control lane'))]);
  assert.equal(stopped.ok, true); assert.equal(f.manager.getPlayer('100'), undefined);
  release.resolve(); await Promise.all([lane, pending]);
  assert.deepEqual(f.calls, ['stopPlaying', 'destroy']); assert.equal(f.phases.length, 2, 'Stop authorizes at its native guard and again for final disclosure');
});

test('catalog commands retain fresh authority after a real asynchronous lookup', async t => {
  const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const original = f.node.search.bind(f.node);
  f.node.search = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const pending = f.run({ command: 'play', options: { query: 'a song' } }); await entered.promise;
  f.members.delete('200');
  const denied = assert.rejects(pending, { status: 404 }); release.resolve(); await denied;
  assert.ok(f.phases.length >= 4, 'post-lookup authorization was retained'); assert.deepEqual(f.calls, []);
});

test('Filter without a preset retains full preflight before its unguarded read path', async t => {
  const f = await harness(t); let dispatched = false;
  const original = f.commands.get('filter');
  f.commands.set('filter', { ...original, async execute(interaction) {
    dispatched = true;
    assert.equal(f.phases.length, 1); assert.equal(interaction.user.id, '200');
    assert.ok(interaction.guild.channels.cache.get('400'));
    return original.execute(interaction);
  } });
  const result = await f.run({ command: 'filter' });
  assert.equal(result.ok, true); assert.match(result.message, /Current audio/);
  assert.equal(f.phases.length, 2); assert.deepEqual(f.calls, []); assert.equal(dispatched, true);
  f.channels.get('400').hidden.add('200'); dispatched = false;
  await assert.rejects(f.run({ command: 'filter' }), { status: 403 }); assert.equal(dispatched, false);
});

test('stale Seek intent takes precedence over an invalid target in local and native preflight', async t => {
  for (const stage of ['lane', 'native read']) await t.test(stage, async t => {
    const f = await harness(t); const expectedRevision = f.revisions.revision('100');
    const entered = deferred(), release = deferred(); t.after(() => release.resolve());
    let lane;
    if (stage === 'lane') {
      lane = withGuildMutation('100', async () => { entered.resolve(); await release.promise; });
      await entered.promise;
    } else {
      const original = f.guild.channels.fetch.bind(f.guild.channels);
      f.guild.channels.fetch = async (...args) => {
        if (args[0] === '400') { entered.resolve(); await release.promise; }
        return original(...args);
      };
    }
    const pending = f.run({ command: 'seek', options: { timestamp: '99:59' }, expectedRevision });
    if (stage === 'native read') await entered.promise;
    f.player.queue.tracks.pop();
    const denied = assert.rejects(pending, { status: 409, code: 'stale_revision' });
    release.resolve(); await Promise.all([denied, lane]);
    assert.equal(f.phases.length, stage === 'lane' ? 0 : 1); assert.deepEqual(f.calls, []);
  });
});

test('maintenance denies direct controls before dispatch or Discord work', async t => {
  const f = await harness(t); setMaintenance(f.client, true);
  let dispatched = false; const original = f.commands.get('pause');
  f.commands.set('pause', { ...original, async execute(interaction) { dispatched = true; return original.execute(interaction); } });
  await assert.rejects(f.run({ command: 'pause' }), { status: 503, code: 'maintenance' });
  assert.equal(dispatched, false); assert.equal(f.phases.length, 0); assert.deepEqual(f.calls, []);
});

test('Stop during the first native fresh read denies the old direct intent without resurrection', async t => {
  const f = await harness(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  const original = f.guild.channels.fetch.bind(f.guild.channels); let held = false;
  f.guild.channels.fetch = async (...args) => {
    if (!held && args[0] === '400') { held = true; entered.resolve(); await release.promise; }
    return original(...args);
  };
  const pending = f.run({ command: 'pause', expectedRevision: f.revisions.revision('100') }); await entered.promise;
  const stopped = await f.run({ command: 'stop', expectedRevision: 'a'.repeat(32) });
  assert.equal(stopped.ok, true); assert.equal(f.manager.getPlayer('100'), undefined);
  const denied = assert.rejects(pending, { status: 409, code: 'stale_revision' }); release.resolve(); await denied;
  assert.deepEqual(f.calls, ['stopPlaying', 'destroy']);
});
