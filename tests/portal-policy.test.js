import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createPortalPolicy, requirePlayback } from '../src/portal/policy.js';
import { trackReference } from '../src/utils/library.js';
import { track } from './fixtures.js';

function delayedDiscord(f, latencyMs) {
  for (const [target, method] of [
    [f.client.users, 'fetch'], [f.client.application, 'fetch'], [f.client.rest, 'get'],
    [f.guild.members, 'fetch'], [f.guild.channels, 'fetch'],
    [f.guild.members, 'fetchMe'],
  ]) {
    const fetch = target[method].bind(target);
    target[method] = async (...args) => { await delay(latencyMs); return fetch(...args); };
  }
}

test('authenticated snapshots and library stay within the real portal transport deadline when every Discord route is slow', { timeout: 35_000 }, async t => {
  const f = await portalFixture(t, { owner: { id: '202' } });
  f.player.paused = true; f.player.playing = false;
  await f.library.updateGuild('100', guild => { guild.session = { voiceChannelId: '301', textChannelId: '401', savedAt: Date.now(),
    position: 12000, paused: true, volume: 70, repeatMode: 'off', tracks: [trackReference(track())] }; });
  let revision;
  // Every route responds inside its five-second authority deadline, but the
  // Identity plus raw guild/member-pair/channel stages and library disclosure
  // fit the transport deadline without completed authority caching.
  delayedDiscord(f, 1600);
  for (let round = 0; round < 3; round++) {
    const startedAt = performance.now();
    const results = await Promise.allSettled([
      f.request('', { actor: '202', signal: AbortSignal.timeout(10_000) }),
      f.request('/library', { actor: '202', signal: AbortSignal.timeout(10_000) }),
      f.request('/diagnostics', { actor: '202', signal: AbortSignal.timeout(10_000) }),
    ]);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'Discord verification exceeded the portal ten-second read deadline');
    const responses = results.map(result => result.value);
    t.diagnostic(`read round ${round + 1}: ${Math.round(performance.now() - startedAt)} ms with four distinct individual channel IDs`);
    assert.ok(responses.every(response => response.status === 200));
    assert.ok(responses[0].body.session.current);
    assert.equal(responses[0].body.session.status, 'paused');
    assert.equal(responses[0].body.session.positionMs, f.player.lastPosition);
    assert.equal(responses[0].body.session.canControl, true);
    assert.equal(responses[0].body.guild.admin, true);
    revision ??= responses[0].body.revision;
    assert.equal(responses[0].body.revision, revision);
    assert.equal(f.manager.getPlayer('100'), f.player);
    assert.equal(f.player.paused, true);
    assert.equal(f.player.playing, false);
    assert.deepEqual(f.calls, []);
  }
});

test('overlapping slow authorization waits for current channel and role results before returning protected state', { timeout: 5000 }, async t => {
  const f = await portalFixture(t);
  const release = deferred(); const started = deferred();
  const fetchMember = f.guild.members.fetch.bind(f.guild.members);
  // Revoke before the fresh membership response settles; later cache patches
  // cannot rewrite an already captured response in this stage.
  f.guild.members.fetch = async (...args) => { started.resolve(); await release.promise; return fetchMember(...args); };
  t.after(() => release.resolve());
  f.members.get('201').permissions = new PermissionsBitField([P.ManageGuild]);
  const reading = f.request('', { actor: '201' });
  await started.promise;
  f.members.get('201').permissions = new PermissionsBitField();
  f.channels.get('400').hidden.add('201');
  release.resolve();
  const response = await reading;
  assert.equal(response.status, 200);
  assert.equal(response.body.guild.admin, false);
  assert.equal(response.body.settings, null);
  assert.equal(response.body.session.current, null);
  assert.equal((await f.command({ command: 'pause' }, { actor: '201' })).status, 403);
  assert.deepEqual(f.calls, []);
});

test('a delayed bot permission check cannot configure a text channel that became unwritable', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const started = deferred(); const release = deferred();
  const fetchMe = f.guild.members.fetchMe.bind(f.guild.members);
  f.guild.members.fetchMe = async () => { started.resolve(); await release.promise; return fetchMe(); };
  t.after(() => release.resolve());
  const configuring = f.command({ command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } }, { actor: '201' });
  await started.promise;
  f.channels.get('401').botWritable = false; release.resolve();
  const response = await configuring;
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_channel');
  assert.equal(f.library.settings('100').musicTextChannelId, '400');
  assert.deepEqual(f.calls, []);
});

test('fresh playback verification retains reserved Stop capacity while ordinary Discord requests are stalled', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const release = deferred();
  await f.library.updateGuild('100', guild => { guild.session = { voiceChannelId: '301', textChannelId: '401', savedAt: Date.now(),
    position: 0, paused: true, volume: 70, repeatMode: 'off', tracks: [trackReference(track())] }; });
  let channelsActive = 0, channelsMaximum = 0;
  const fetchChannel = f.guild.channels.fetch.bind(f.guild.channels);
  f.guild.channels.fetch = async (...args) => {
    channelsActive++; channelsMaximum = Math.max(channelsMaximum, channelsActive);
    try { await delay(10); return await fetchChannel(...args); } finally { channelsActive--; }
  };
  const fetchUser = f.client.users.fetch.bind(f.client.users);
  f.client.users.fetch = async id => {
    if (Number(id) >= 1000) { await release.promise; return { id, bot: false }; }
    return fetchUser(id);
  };
  // Each configured fixture operator holds exactly one underlying user read.
  // The real Stop actor stays non-operator and must fit both identity inputs
  // and every following fresh guild stage inside the two reserved admissions.
  const actors = Array.from({ length: 128 }, (_, index) => String(1000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: actors });
  t.after(() => { release.resolve(); policy.close(); });
  const ordinary = actors.map(actor => policy.identity(actor));
  const settled = Promise.allSettled(ordinary);
  await assert.rejects(policy.guild('200', '100', undefined, { fresh: true }), { status: 429 });
  const context = await policy.guild('200', '100', undefined, { fresh: true, urgent: true });
  requirePlayback(context, f.client);
  assert.equal(context.member.id, '200');
  assert.equal(context.channels.size, 4); assert.equal(channelsMaximum, 2, 'Stop uses only its two reserved admissions for channel work');
  assert.deepEqual(f.calls, []);
  release.resolve(); assert.ok((await settled).every(result => result.status === 'fulfilled'));
});

test('partial permission-read admission fails safely and recovers after rate pressure releases', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const release = deferred(); const memberStarted = deferred();
  const fetchUser = f.client.users.fetch.bind(f.client.users);
  const fetchMember = f.guild.members.fetch.bind(f.guild.members);
  f.client.users.fetch = async id => {
    if (Number(id) >= 1000) { await release.promise; return { id, bot: false }; }
    return fetchUser(id);
  };
  f.guild.members.fetch = async () => { memberStarted.resolve(); await release.promise; throw new Error('Discord read failed behind a saturated route'); };
  // Hold 127 exact user-read slots and leave one for the verification actor.
  // Its explicit operator identity uses one read, so the first width-two
  // actor/bot member stage exercises partial admission rather than failing earlier.
  const actors = Array.from({ length: 127 }, (_, index) => String(1000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: [...actors, '200'] });
  t.after(() => { release.resolve(); policy.close(); });
  const ordinary = actors.map(actor => policy.identity(actor));
  const settled = Promise.allSettled(ordinary);
  await assert.rejects(policy.guild('200', '100', undefined, { fresh: true }), { status: 429 });
  await memberStarted.promise;
  release.resolve(); assert.ok((await settled).every(result => result.status === 'fulfilled'));
  f.guild.members.fetch = fetchMember;
  const context = await policy.guild('200', '100', undefined, { fresh: true });
  requirePlayback(context, f.client);
  assert.equal(context.member.id, '200');
  assert.deepEqual(f.calls, []);
});

test('a command queued behind a rate-limited channel read checks new visibility instead of reusing the earlier response', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const started = deferred(); const queued = deferred(); const release = deferred();
  const previousChannels = new Map([...f.channels].map(([id, channel]) => [id, { ...channel, hidden: new Set(channel.hidden) }]));
  let tail = Promise.resolve(); let calls = 0;
  f.guild.channels.fetch = id => {
    const call = ++calls;
    if (call === 2) queued.resolve();
    // Discord serializes requests for an exhausted route bucket. The first
    // response represents permissions before the owner revokes visibility.
    const read = tail.then(async () => {
      if (call === 1) { started.resolve(); await release.promise; return previousChannels.get(id); }
      return f.channels.get(id);
    });
    tail = read.catch(() => {});
    return read;
  };
  t.after(() => release.resolve());
  const snapshot = f.request(); await started.promise;
  const pausing = f.command({ command: 'pause' }); await queued.promise;
  f.channels.get('400').hidden.add('200');
  assert.deepEqual(f.calls, []);
  release.resolve();
  assert.equal((await snapshot).status, 200);
  assert.equal((await pausing).status, 403);
  assert.equal(f.player.paused, false);
  assert.deepEqual(f.calls, []);
  assert.equal((await f.request()).body.session.current, null);
});

test('gateway loss during a slow permission check fails closed without affecting the active player', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const started = deferred(); const release = deferred();
  const fetchGuild = f.client.rest.get.bind(f.client.rest);
  f.client.rest.get = async (...args) => { started.resolve(); await release.promise; return fetchGuild(...args); };
  t.after(() => release.resolve());
  const snapshot = f.request(); await started.promise;
  f.client.isReady = () => false; release.resolve();
  assert.equal((await snapshot).status, 503);
  assert.equal(f.manager.getPlayer('100'), f.player);
  assert.equal(f.player.playing, true);
  assert.deepEqual(f.calls, []);
});
