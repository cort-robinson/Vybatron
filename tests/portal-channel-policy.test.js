import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, TextChannel, VoiceChannel, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createPortalPolicy, requirePlayback } from '../src/portal/policy.js';
import { trackReference } from '../src/utils/library.js';
import { track } from './fixtures.js';

const checkpoint = f => ({ voiceChannelId: '301', textChannelId: '401', savedAt: Date.now(), position: 12000,
  paused: true, volume: 70, repeatMode: 'off', tracks: [trackReference(track())] });
const replaceChannel = (f, id, changes) => f.channels.set(id, { ...f.channels.get(id), hidden: new Set(), ...changes });

test('an exhausted list route never affects hot snapshots, search, library or native controls', async t => {
  const f = await portalFixture(t, { channelFetch(id) { assert.ok(id, 'hot paths must never submit complete discovery'); } });
  await f.library.recordHistory({ ...f.player, voiceChannelId: '301' }, track('aaaaaaaaaaa'));
  for (let round = 0; round < 3; round++) {
    const responses = await Promise.all([f.request(), f.request(), f.command({ command: 'queue' })]);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal(responses[2].body.message, 'Request completed.');
  }
  assert.equal((await f.request('/library')).body.history.length, 1);
  assert.equal((await f.request('/search?query=safe')).status, 200);
  assert.equal((await f.command({ command: 'pause' })).status, 200);
  assert.equal((await f.command({ command: 'resume' })).status, 200);
  assert.equal((await f.command({ command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } }, { actor: '201' })).status, 200);
  const revision = (await f.request()).body.revision;
  const historyId = (await f.request('/library')).body.history[0].id;
  assert.equal((await f.command({ command: 'replay', expectedRevision: revision, expectedHistoryId: historyId })).status, 200);
  assert.equal((await f.command({ command: 'stop' })).status, 200);
  assert.equal(f.channelReads.filter(read => !read.id).length, 0);
  assert.ok(f.channelReads.every(read => read.force === true && read.cache !== false));
  assert.ok(f.channelReads.some(read => read.id === '301'));
  assert.ok(f.channelReads.some(read => read.id === '401'));
});

test('directory and admin infrastructure/activity read no channels; configuration denies basics before discovery', async t => {
  const f = await portalFixture(t, { channelFetch() { assert.fail('no channel work is authorized for these requests'); } });
  assert.equal((await f.request('/v1/bootstrap?actorId=200')).status, 200);
  assert.equal((await f.request('/diagnostics', { actor: '201' })).status, 200);
  assert.equal((await f.request('/activity', { actor: '900' })).status, 200);
  assert.equal((await f.request('/configuration')).status, 403);
  assert.equal((await f.request('/activity')).status, 403);
  assert.equal(f.channelReads.length, 0);
  f.roles.delete('500');
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 200);
  assert.equal(f.guild.roles.cache.has('500'), true, 'verification does not mutate the late Gateway cache');
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  assert.equal((await policy.guild('900', '100', undefined, { channelScope: 'none', fresh: true })).roleIds.has('500'), false);
  f.client.application.fetch = async () => ({ owner: f.users.get('901') });
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 404);
});

test('application and team owner changes revoke settings authority between stages without granting team members playback', async t => {
  const f = await portalFixture(t); let applicationReads = 0;
  f.client.application.fetch = async () => ({ owner: { id: '800', ownerId: ++applicationReads === 1 ? '900' : '901' } });
  const oldOwner = await f.command({ command: 'settings', subcommand: 'volume', options: { value: 60 } }, { actor: '900' });
  assert.equal(oldOwner.status, 404); assert.equal(applicationReads, 2);
  assert.equal(f.library.settings('100').volume, 100);
  assert.equal((await f.command({ command: 'settings', subcommand: 'volume', options: { value: 60 } }, { actor: '901' })).status, 200);
  assert.equal(f.library.settings('100').volume, 60);
  assert.equal((await f.command({ command: 'pause' }, { actor: '901' })).status, 403);
  assert.equal((await f.request('/configuration', { actor: '900' })).status, 404);
});

test('explicit fresh configuration filters visible same-guild text/voice inventory and preserves DTO bounds', async t => {
  const f = await portalFixture(t);
  f.channels.get('301').hidden.add('201');
  f.channels.set('600', { ...f.channels.get('400'), id: '600', type: ChannelType.GuildCategory, name: 'category' });
  f.channels.set('601', { ...f.channels.get('400'), id: '601', guildId: '101', name: 'foreign' });
  const configuration = await f.request('/configuration', { actor: '201' });
  assert.equal(configuration.status, 200);
  assert.deepEqual(configuration.body, { guildId: '100', channels: [
    { id: '300', name: 'General', type: 'voice' }, { id: '400', name: 'music', type: 'text' },
    { id: '401', name: 'alternate music', type: 'text' },
  ], roles: [{ id: '500', name: 'DJ' }, { id: '100', name: '@everyone' }] });
  assert.deepEqual(f.channelReads, [{ id: undefined }]);
  replaceChannel(f, '401', { name: 'Renamed by REST' });
  assert.equal((await f.request('/configuration', { actor: '201' })).body.channels.at(-1).name, 'Renamed by REST');
  const subset = (await f.request('', { actor: '201' })).body.channels;
  assert.deepEqual(subset.map(channel => channel.id), ['300', '400']);
  assert.deepEqual((await f.request('/configuration', { actor: '900' })).body.channels, []);
  for (let i = 0; i < 550; i++) f.channels.set(String(1000 + i), { ...f.channels.get('400'), id: String(1000 + i) });
  for (let i = 0; i < 300; i++) f.roles.set(String(2000 + i), { id: String(2000 + i), name: 'role' });
  const bounded = (await f.request('/configuration', { actor: '201' })).body;
  assert.equal(bounded.channels.length, 500); assert.equal(bounded.roles.length, 250);
  f.members.get('201').permissions.remove(P.ManageGuild);
  const listReads = f.channelReads.filter(read => !read.id).length;
  assert.equal((await f.request('/configuration', { actor: '201' })).status, 403);
  assert.equal(f.channelReads.filter(read => !read.id).length, listReads);
});

test('fresh channel responses control privacy and native guards even when Gateway objects disagree', async t => {
  const f = await portalFixture(t);
  replaceChannel(f, '400', { hidden: new Set(['200']) });
  assert.equal(f.channelCache.get('400').hidden.has('200'), false);
  assert.equal((await f.request()).body.session.current, null);
  assert.equal((await f.command({ command: 'pause' })).status, 403);
  assert.deepEqual(f.calls, []);
  f.channelCache.get('400').hidden.add('200');
  replaceChannel(f, '400', {});
  f.channelCache.delete('300'); // Cold voice cache: Gateway voice ID still exists.
  f.members.get('200').voice.channelId = '300';
  const fresh = await f.request();
  assert.ok(fresh.body.session.current); assert.equal(fresh.body.session.canControl, true);
  assert.equal((await f.command({ command: 'pause' })).status, 200, 'native cache guard must see this stage\'s REST channels');
  assert.equal(f.player.paused, true);
  assert.ok(f.channelReads.every(read => read.force === true), 'Gateway permission state never substitutes for a fresh fetch');
});

test('deleted, missing and foreign current, actor, configured and checkpoint channels fail closed', async t => {
  for (const kind of ['deleted', 'foreign', 'mismatched', 'wrong type']) await t.test(kind, async t => {
    const f = await portalFixture(t);
    for (const id of ['300', '400']) {
      const original = f.channels.get(id);
      if (kind === 'deleted') f.channels.delete(id);
      else replaceChannel(f, id, kind === 'foreign' ? { guildId: '101' } : kind === 'wrong type' ? { type: id === '300' ? ChannelType.GuildText : ChannelType.GuildVoice } : { id: '777' });
      const snapshot = (await f.request()).body;
      assert.equal(snapshot.session.current, null); assert.deepEqual(snapshot.session.queue, []);
      assert.equal((await f.command({ command: 'stop' })).status, 403);
      f.channels.set(id, original);
    }
    f.members.get('200').voice.channel = { id: '399' };
    assert.equal((await f.request()).body.session.canControl, false);
    assert.equal((await f.command({ command: 'pause' })).status, 403);
    f.members.get('200').voice.channel = f.channels.get('301');
    await f.library.updateGuild('100', guild => { guild.session = checkpoint(f); });
    f.manager.players.delete('100');
    f.channels.delete('401');
    const snapshot = (await f.request()).body;
    assert.equal(snapshot.savedSession.exists, false);
    assert.equal((await f.command({ command: 'session', subcommand: 'resume', expectedRevision: snapshot.revision })).status, 403);
    f.channels.delete('400');
    assert.equal((await f.request()).body.session.canAdd, false);
    assert.equal((await f.command({ command: 'play', options: { query: 'safe' } })).body.error.code, 'music_channel_required');
    assert.deepEqual(f.calls, []);
  });
});

test('musicchannel checks fetch the newly selected ID at native and durable stages without using Gateway bot grants', async t => {
  const f = await portalFixture(t);
  replaceChannel(f, '401', { botWritable: false });
  assert.equal(f.channelCache.get('401').botWritable, true);
  const body = { command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } };
  assert.equal((await f.command(body, { actor: '201' })).status, 400);
  assert.equal(f.library.settings('100').musicTextChannelId, '400');
  f.channels.set('601', { ...f.channels.get('400'), id: '601', guildId: '101' });
  for (const channel of ['601', '777', '300']) assert.equal((await f.command({ ...body, options: { channel } }, { actor: '201' })).status, 400);
  replaceChannel(f, '401', { botWritable: true });
  let reads = 0;
  const fetchChannel = f.guild.channels.fetch.bind(f.guild.channels);
  f.guild.channels.fetch = async (id, options) => {
    if (id === '401' && ++reads === 5) replaceChannel(f, id, { botWritable: false });
    return fetchChannel(id, options);
  };
  // Initial, preflight, native read, native recheck, durable recheck.
  assert.equal((await f.command(body, { actor: '201' })).status, 400);
  assert.equal(reads, 5); assert.equal(f.library.settings('100').musicTextChannelId, '400');
  replaceChannel(f, '401', { botWritable: true });
  assert.equal((await f.command(body, { actor: '900' })).status, 200, 'fresh verified nonmember maintainer can configure by explicit ID');
  assert.equal(f.library.settings('100').musicTextChannelId, '401');
  assert.ok(f.channelReads.filter(read => read.id === '401').every(read => read.force === true && read.cache !== false));
});

test('library/history/replay select individually authorized source IDs rather than stale visible history objects', async t => {
  const f = await portalFixture(t);
  await f.library.recordHistory(f.player, track());
  await f.library.recordHistory({ ...f.player, voiceChannelId: '301' }, track('aaaaaaaaaaa'));
  const displayed = (await f.request('/library')).body.history;
  const revision = (await f.request()).body.revision;
  replaceChannel(f, '301', { hidden: new Set(['200']) });
  assert.equal(f.channelCache.get('301').hidden.has('200'), false);
  const library = (await f.request('/library')).body;
  assert.equal(library.history.length, 1); assert.doesNotMatch(JSON.stringify(library), /aaaaaaaaaaa|Private voice/);
  assert.equal((await f.command({ command: 'history' })).body.message, 'Request completed.');
  const stale = await f.command({ command: 'replay', expectedRevision: revision, expectedHistoryId: displayed[0].id, options: { index: 1 } });
  assert.equal(stale.status, 409); assert.equal(f.calls.includes('splice'), false);
  const replay = await f.command({ command: 'replay', expectedRevision: revision, expectedHistoryId: library.history[0].id, options: { index: 1 } });
  assert.equal(replay.status, 200); assert.equal(f.player.queue.tracks[0].info.identifier, 'abcdefghijk');
  assert.ok(f.channelReads.some(read => read.id === '301'));
});

test('real discord.js REST ignores an exhausted list bucket, forces detached overwrites and supports cold native guard views', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const discord = new Client({ intents: [] }); t.after(() => discord.destroy());
  discord.rest.setToken('synthetic-only-not-a-credential');
  discord.user = discord.users._add({ id: '999', username: 'Synthetic bot', discriminator: '0', bot: true });
  const guild = discord.guilds._add({ id: '100', name: 'Real structure', owner_id: '202', roles: [
    { id: '100', name: '@everyone', permissions: String(P.ViewChannel) },
    { id: '501', name: 'Bot', permissions: String(P.Administrator) },
  ] });
  const member = guild.members._add({ user: { id: '200', username: 'Listener', discriminator: '0' }, roles: [] });
  const me = guild.members._add({ user: { id: '999', username: 'Synthetic bot', discriminator: '0', bot: true }, roles: ['501'] });
  guild.voiceStates.cache.set('200', { id: '200', channelId: '300' });
  const data = id => ({ id, guild_id: '100', type: id === '300' ? ChannelType.GuildVoice : ChannelType.GuildText, name: 'REST channel', permission_overwrites: [] });
  guild.channels.cache.set('300', new VoiceChannel(guild, data('300'), discord));
  guild.channels.cache.set('400', new TextChannel(guild, data('400'), discord));
  for (const [id, channel] of guild.channels.cache) discord.channels.cache.set(id, channel);
  let hidden = true; const requests = [];
  const voiceResponded = deferred(), releaseText = deferred(); let holdText = true;
  t.after(() => releaseText.resolve());
  discord.rest.options.makeRequest = async url => {
    const path = new URL(url).pathname; const id = path.split('/').at(-1); requests.push(path);
    if (path === '/api/v10/guilds/100/channels') return new Response(JSON.stringify([data('300'), data('400')]), {
      status: 200, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Limit': '10', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '60', 'X-RateLimit-Bucket': 'synthetic-exhausted-list' },
    });
    assert.ok(['300', '400'].includes(id));
    if (id === '300') voiceResponded.resolve();
    if (id === '400' && holdText) await releaseText.promise;
    return new Response(JSON.stringify({ ...data(id), permission_overwrites: hidden && id === '300' ? [{ id: '100', type: 0, allow: '0', deny: String(P.ViewChannel) }] : [] }), {
      status: 200, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': '999', 'X-RateLimit-Reset-After': '0.001', 'X-RateLimit-Bucket': `channel-${id}` },
    });
  };
  guild.members.fetch = async ({ force }) => { assert.equal(force, true); return member; };
  guild.members.fetchMe = async () => me;
  f.client.guilds.cache.set('100', guild); f.client.guilds.fetch = async () => guild;
  const roleInventory = [...guild.roles.cache.values()].map(role => ({ id: role.id, name: role.name, permissions: String(role.permissions.bitfield), position: 0 }));
  f.client.rest.get = async route => { assert.equal(route, '/guilds/100'); return { id: '100', name: guild.name, owner_id: '202', roles: roleInventory }; };
  // Seed the actual REST handler with an exhausted list response. Individual
  // channels keep independent ample synthetic budgets; no network is used.
  await guild.channels.fetch();
  assert.equal(guild.channels.cache.get('300').permissionsFor(member).has(P.ViewChannel), true, 'simulate a stale Gateway grant');
  const first = f.request(); await voiceResponded.promise; await delay(20);
  assert.equal(guild.channels.cache.get('300').permissionsFor(member).has(P.ViewChannel), false, 'fresh REST data must actually patch overwrites');
  guild.channels.cache.get('300')._patch({ permission_overwrites: [] });
  assert.equal(guild.channels.cache.get('300').permissionsFor(member).has(P.ViewChannel), true, 'simulate a delayed Gateway grant while the other read is pending');
  holdText = false; releaseText.resolve();
  assert.equal((await first).body.session.current, null, 'detached REST overwrites survive a later Gateway mutation');
  assert.equal(requests.filter(path => path.includes('/channels/')).length, 2);
  hidden = false; guild.channels.cache.clear(); discord.channels.cache.clear();
  assert.equal((await f.command({ command: 'pause' })).status, 200);
  assert.equal(f.player.paused, true);
  for (let round = 0; round < 3; round++) {
    const responses = await Promise.all([f.request(), f.request(), f.command({ command: 'queue' })]);
    assert.ok(responses.every(response => response.status === 200));
  }
  assert.equal(requests.filter(path => path === '/api/v10/guilds/100/channels').length, 1, 'only the deliberate seed reads the list bucket');
  assert.ok(requests.filter(path => path !== '/api/v10/guilds/100/channels').every(path => /^\/api\/v10\/channels\/(300|400)$/.test(path)));
});

test('ordinary channel work has a global four-read pool and Stop has a separate two-read pool', { timeout: 5000 }, async t => {
  const f = await portalFixture(t); const release = deferred(); const filled = deferred();
  const fetchChannel = f.guild.channels.fetch.bind(f.guild.channels);
  let calls = 0, active = 0, maximum = 0;
  f.guild.channels.fetch = async (...args) => {
    const call = ++calls; active++; maximum = Math.max(maximum, active);
    if (call === 4) filled.resolve();
    try { if (call <= 4) await release.promise; else await delay(10); return await fetchChannel(...args); }
    finally { active--; }
  };
  await f.library.updateGuild('100', guild => { guild.session = checkpoint(f); });
  const policy = createPortalPolicy(f.client); t.after(() => { release.resolve(); policy.close(); });
  const ordinary = [policy.guild('200', '100', undefined, { fresh: true }), policy.guild('201', '100', undefined, { fresh: true })];
  await filled.promise; await delay(20); assert.equal(calls, 4); assert.equal(active, 4);
  const urgent = await policy.guild('200', '100', undefined, { fresh: true, urgent: true });
  requirePlayback(urgent, f.client);
  assert.equal(maximum, 6); assert.equal(active, 4);
  release.resolve(); await Promise.all(ordinary); assert.equal(active, 0);
});

test('timed-out individual reads retain pool slots and share only pending ordinary work until settlement', { timeout: 8000 }, async t => {
  const f = await portalFixture(t); const release = deferred();
  const fetchChannel = f.guild.channels.fetch.bind(f.guild.channels); let calls = 0;
  f.guild.channels.fetch = async (id, options) => {
    if (id === '300') { calls++; await release.promise; }
    return fetchChannel(id, options);
  };
  t.after(() => release.resolve());
  const first = await f.request(); assert.equal(first.status, 503);
  const second = f.request(); await delay(30); assert.equal(calls, 1);
  replaceChannel(f, '300', { hidden: new Set(['200']) }); release.resolve();
  const response = await second; assert.equal(response.status, 200); assert.equal(response.body.session.current, null);
  await f.request(); assert.equal(calls, 2, 'settled channel authority is never cached');
});

test('final session revocation neutralizes protected readonly text and history source revocation cannot leak earlier titles', async t => {
  for (const command of ['queue', 'nowplaying', 'history']) await t.test(command, async t => {
    let f, rounds = 0;
    f = await portalFixture(t, { memberFetch(id) { if (id === '200' && ++rounds === 3) replaceChannel(f, '400', { hidden: new Set(['200']) }); } });
    f.player.queue.previous = [track('aaaaaaaaaaa')];
    const response = await f.command({ command });
    assert.equal(response.status, 200); assert.equal(rounds, 3);
    assert.equal(response.body.snapshot.session.current, null); assert.equal(response.body.message, 'Request completed.');
    assert.doesNotMatch(JSON.stringify(response.body), /Song |abcdefghijk|aaaaaaaaaaa|lmnopqrstuv/);
  });
  let f, rounds = 0;
  f = await portalFixture(t, { memberFetch(id) { if (id === '200' && ++rounds === 3) replaceChannel(f, '301', { hidden: new Set(['200']) }); } });
  await f.library.recordHistory({ ...f.player, voiceChannelId: '301' }, track('aaaaaaaaaaa'));
  f.player.queue.previous = [track('aaaaaaaaaaa')];
  const history = await f.command({ command: 'history' });
  assert.ok(history.body.snapshot.session.current); assert.equal(history.body.message, 'Request completed.');
  assert.doesNotMatch(JSON.stringify(history.body), /aaaaaaaaaaa|Private voice/);
});

test('final revocation never repeats a completed mutation and retains public help and useful native errors', async t => {
  const f = await portalFixture(t);
  const fetchUser = f.client.users.fetch.bind(f.client.users);
  f.client.users.fetch = async (...args) => { if (f.calls.includes('pause')) replaceChannel(f, '400', { hidden: new Set(['200']) }); return fetchUser(...args); };
  const paused = await f.command({ command: 'pause' });
  assert.equal(paused.status, 200); assert.equal(paused.body.snapshot.session.current, null);
  assert.equal(paused.body.message, 'Request completed.'); assert.deepEqual(f.calls, ['pause']);
  const help = await f.command({ command: 'help' });
  assert.equal(help.status, 200); assert.notEqual(help.body.message, 'Request completed.');
  replaceChannel(f, '400', {}); f.client.users.fetch = fetchUser;
  f.node.search = async () => ({ loadType: 'empty', tracks: [] });
  const missing = await f.command({ command: 'play', options: { query: 'absent' } });
  assert.equal(missing.status, 200); assert.match(missing.body.message, /No|found|match|result/i);
  assert.deepEqual(f.calls, ['pause']);
});
