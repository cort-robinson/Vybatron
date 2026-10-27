import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { GatewayIntentBits, IntentsBitField, PermissionsBitField, Status } from 'discord.js';
import { deferred, portalFixture } from './portal-fixtures.js';
import { createPortalPolicy } from '../src/portal/policy.js';
import { createRevisions } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';
import { withGuildMutation } from '../src/utils/requests.js';

const found = id => ({ loadType: 'track', tracks: [{ encoded: `QAAA${id}`, info: { title: `Song ${id}`, author: 'Artist', identifier: id,
  uri: `https://www.youtube.com/watch?v=${id}`, sourceName: 'youtube', duration: 180_000, isSeekable: true } }] });

async function harness(t, fixture) {
  const lookups = new Map();
  const f = await portalFixture(t, { search: query => (lookups.get(query) || (() => found('fastfastfas')))(), ...fixture });
  f.client.options = { intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]) };
  f.guild.shard = { status: Status.Ready }; f.guild.members.me = f.me;
  f.guild.roles.cache.set('100', { id: '100', name: '@everyone', permissions: new PermissionsBitField(0n), rawPosition: 0 });
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  const commands = new Map(await loadCommandsData());
  // A lookup that waits until the test releases it.
  const slow = (query, id) => {
    const started = deferred(), release = deferred();
    lookups.set(query, () => { started.resolve(); return release.promise.then(() => found(id)); });
    return { started: started.promise, release: () => release.resolve() };
  };
  // The browser sends additions without a revision: they don't depend on what the queue shows.
  return { ...f, slow, play: query => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId: '200', command: 'play', options: { query } }),
    run: body => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId: '200', expectedRevision: revisions.revision('100'), ...body }) };
}

test('Pause, Volume and Skip are not held behind a slow song lookup in a running session', async t => {
  const f = await harness(t);
  const lookup = f.slow('slow song', 'slowslowslo');
  const adding = f.play('slow song');
  await lookup.started;
  const start = performance.now();
  assert.equal((await f.run({ command: 'pause' })).ok, true);
  assert.equal((await f.run({ command: 'volume', options: { level: 40 } })).ok, true);
  assert.equal((await f.run({ command: 'skip' })).ok, true);
  const controlsMs = Math.round(performance.now() - start);
  assert.equal(f.player.paused, true); assert.equal(f.player.volume, 40);
  lookup.release();
  const added = await adding;
  assert.equal(added.ok, true);
  assert.equal(f.player.queue.tracks.at(-1).info.identifier, 'slowslowslo', 'the song is still added, after the controls');
  t.diagnostic(`three controls finished in ${controlsMs} ms while the lookup was still pending (previously held until it finished)`);
});

test('song additions keep their order even when the first lookup is slower', async t => {
  const f = await harness(t);
  const lookup = f.slow('slow song', 'slowslowslo');
  const first = f.play('slow song');
  await lookup.started;
  const second = f.play('fast song');
  await delay(20);
  assert.equal(f.player.queue.tracks.some(track => track.info.identifier === 'fastfastfas'), false, 'the later addition waits its turn');
  lookup.release(); await Promise.all([first, second]);
  assert.deepEqual(f.player.queue.tracks.slice(-2).map(track => track.info.identifier), ['slowslowslo', 'fastfastfas']);
});

test('a lookup that loses voice or the session while outside the lane adds nothing', async t => {
  const cases = {
    'left voice': f => { f.members.get('200').voice.channel = null; },
    'controller channel hidden': f => { f.channels.get('400').hidden.add('200'); },
    stopped: f => f.run({ command: 'stop' }),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = await harness(t);
    const lookup = f.slow('slow song', 'slowslowslo');
    const adding = f.play('slow song');
    await lookup.started; await change(f); lookup.release();
    await assert.rejects(adding, error => [403, 409, 503].includes(error.status) || /cancelled by Stop|stopping/.test(error.message));
    assert.equal(f.player.queue.tracks.some(track => track.info.identifier === 'slowslowslo'), false);
  });
});

test('starting a new session keeps the lane through its lookup', async t => {
  const f = await harness(t, { idle: true });
  const lookup = f.slow('slow song', 'slowslowslo');
  const adding = f.play('slow song');
  await lookup.started;
  let ran = false; const other = withGuildMutation('100', async () => { ran = true; });
  await delay(20); assert.equal(ran, false, 'nothing else runs on the half-created session');
  lookup.release(); await adding; await other; assert.equal(ran, true);
});
