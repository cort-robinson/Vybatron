import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, Guild, GuildMember, Role, VoiceChannel, ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createPortalPolicy, requirePlayback, visible, writable } from '../src/portal/policy.js';
import { configurationProjection, createRevisions, libraryProjection, snapshotProjection } from '../src/portal/projection.js';
import { executePortalCommand } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';
import { mixVersion } from '../src/portal/selections.js';
import { trackReference } from '../src/utils/library.js';
import { track } from './fixtures.js';

const botAccess = P.ViewChannel | P.Connect | P.Speak | P.SendMessages | P.EmbedLinks;
// Real discord.js managers patch the same cached Guild/Member/Role/channel
// instances as production. Only the external HTTP response transport is fake.
async function realFixture(t, options = {}) {
  const f = await portalFixture(t, options);
  const discord = new Client({ intents: [] }); t.after(() => discord.destroy());
  discord.rest.setToken('synthetic-only-not-a-credential');
  discord.user = discord.users._add({ id: '999', username: 'Synthetic bot', discriminator: '0', bot: true });
  const state = {
    ownerId: '202', roles: new Map([['100', 0n], ['500', P.ViewChannel], ['501', botAccess], ['502', P.Administrator]]),
    members: new Map([['200', ['500']], ['900', ['500']], ['999', ['501']]]),
    overwrites: new Map(), beforeResponse: async () => {}, applicationReads: 0, guildResponse: data => data,
  };
  const roleData = () => [...state.roles].map(([id, permissions]) => ({ id, name: `Role ${id}`, permissions: String(permissions), position: 1 }));
  const userData = id => ({ id, username: `Synthetic ${id}`, discriminator: '0', bot: id === '999' });
  const guildData = () => ({ id: '100', name: 'Authority server', owner_id: state.ownerId, roles: roleData() });
  const channelData = id => ({ id, guild_id: '100', type: ['300', '301'].includes(id) ? ChannelType.GuildVoice : ChannelType.GuildText,
    name: `Private channel ${id}`, user_limit: 0, permission_overwrites: state.overwrites.get(id) || [] });
  const guild = discord.guilds._add(guildData());
  for (const [id, roles] of state.members) guild.members._add({ user: userData(id), roles, communication_disabled_until: null });
  guild.voiceStates._add({ user_id: '200', channel_id: '300' });
  guild.voiceStates._add({ user_id: '900', channel_id: '300' });
  const requests = [];
  discord.rest.options.makeRequest = async url => {
    const path = new URL(url).pathname; requests.push(path);
    await state.beforeResponse(path);
    let data, status = 200;
    const id = path.split('/').at(-1);
    if (/^\/api\/v10\/users\/\d+$/.test(path)) data = userData(id);
    else if (path === '/api/v10/guilds/100') data = state.guildResponse(guildData());
    else if (path === '/api/v10/guilds/100/roles') data = roleData();
    else if (/^\/api\/v10\/guilds\/100\/members\/\d+$/.test(path)) {
      if (state.members.has(id)) data = { user: userData(id), roles: state.members.get(id), communication_disabled_until: null };
      else { status = 404; data = { code: 10007, message: 'Unknown Member' }; }
    } else if (/^\/api\/v10\/channels\/(300|301|400|401)$/.test(path)) data = channelData(id);
    else if (path === '/api/v10/guilds/100/channels') data = ['300', '301', '400', '401'].map(channelData);
    else assert.fail(`Unexpected synthetic external request: ${path}`);
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  };
  f.client.guilds = discord.guilds; f.client.users = discord.users; f.client.channels = discord.channels;
  f.client.rest = discord.rest;
  f.client.application.fetch = async () => { state.applicationReads++; return { owner: { id: '900' } }; };
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  return { ...f, discord, guild, state, requests, policy };
}
function holdText(t, f) {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  f.state.beforeResponse = async path => { if (path === '/api/v10/channels/400') { entered.resolve(); await release.promise; } };
  return { entered, release };
}
const project = (f, context) => snapshotProjection(f.client, context, 'a'.repeat(32));

test('Gateway voice movement during pending channel reads still denies native same-voice control', async t => {
  const f = await realFixture(t); const held = holdText(t, f);
  const pause = f.command({ command: 'pause' }); await held.entered.promise;
  f.guild.voiceStates._add({ user_id: '200', channel_id: '301' }); held.release.resolve();
  assert.equal((await pause).status, 403); assert.deepEqual(f.calls, []);
  f.state.beforeResponse = async () => {};
  f.guild.voiceStates._add({ user_id: '200', channel_id: '300' });
  assert.equal((await f.command({ command: 'pause' })).status, 200); assert.deepEqual(f.calls, ['pause']);
});

test('one raw guild inventory replaces role-list authority and actor/bot members overlap only after capture', async t => {
  const f = await realFixture(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  let active = 0, maximum = 0, membersStarted = 0;
  f.state.beforeResponse = async path => {
    if (path.startsWith('/api/v10/guilds/100/members/')) {
      assert.equal(f.requests.filter(path => path === '/api/v10/guilds/100').length, 1);
      maximum = Math.max(maximum, ++active);
      if (++membersStarted === 2) entered.resolve();
      try { await release.promise; } finally { active--; }
    }
  };
  f.client.guilds.fetch = () => assert.fail('SDK guild fetch cannot supply raw authority');
  f.guild.roles.fetch = () => assert.fail('no redundant role inventory request');
  const reading = f.policy.guild('200', '100', undefined, { fresh: true });
  await entered.promise; assert.equal(maximum, 2); assert.equal(active, 2); release.resolve();
  const context = await reading; requirePlayback(context, f.client);
  assert.equal(f.requests.length, 6, 'user + raw guild + actor/bot + two channels; owner uses the explicit synthetic application seam');
  assert.equal(f.requests.some(path => path.endsWith('/roles')), false);
  assert.ok(context.member instanceof GuildMember); assert.ok(context.me instanceof GuildMember);
  assert.ok(context.guild.roles.everyone instanceof Role);
  const rolePermissions = context.guild.roles.cache.get('500').permissions;
  assert.notEqual(rolePermissions.add(P.Administrator), rolePermissions,
    'owned role definitions remain immutable across shared pending readers');
  assert.equal(context.member.permissions.has(P.Administrator), false);
  f.state.beforeResponse = async () => {};
  await f.policy.guild('200', '100', undefined, { fresh: true, channelScope: 'none' });
  assert.equal(f.requests.filter(path => path === '/api/v10/guilds/100').length, 2, 'a completed inventory never becomes a cached grant');
});

test('raw deleted/edited actor and bot roles defeat intact stale Gateway grants in native permission getters and controls', async t => {
  for (const kind of ['deleted actor', 'edited actor', 'deleted DJ', 'deleted bot']) await t.test(kind, async t => {
    const f = await realFixture(t);
    if (kind === 'deleted actor') f.state.roles.delete('500');
    if (kind === 'edited actor') f.state.roles.set('500', 0n);
    if (kind === 'deleted DJ') {
      f.state.roles.set('100', P.ViewChannel); f.state.roles.delete('500');
      await f.library.updateGuild('100', data => { data.settings.djRoleId = '500'; });
    }
    if (kind === 'deleted bot') f.state.roles.delete('501');
    const context = await f.policy.guild('200', '100', undefined, { fresh: true });
    assert.equal(f.guild.roles.cache.get('500').permissions.has(P.ViewChannel), true, 'Gateway deletion/edit remains late');
    assert.equal(context.guildAdmin, false);
    if (kind === 'deleted bot') {
      assert.equal(f.guild.members.me.permissions.has(P.Connect), true);
      assert.equal(context.channels.get('300').joinable, false); assert.equal(context.channels.get('300').speakable, false);
      assert.equal(writable(context, context.channels.get('400')), false);
      assert.equal((await f.command({ command: 'play', options: { query: 'safe' } })).status, 403);
    } else {
      if (kind === 'deleted DJ') assert.equal(visible(context, context.channels.get('300')), true);
      else assert.equal(project(f, context).session.current, null);
      assert.throws(() => requirePlayback(context, f.client), { status: 403, code: kind === 'deleted DJ' ? 'dj_required' : 'hidden_channel' });
      assert.equal((await f.command({ command: 'pause' })).status, 403);
      assert.equal((await f.command({ command: 'stop' })).status, 403);
    }
    assert.deepEqual(f.calls, []);
  });
});

test('raw owner transfer replaces a stale cached guild owner and only the next fresh stage receives a new grant', async t => {
  const f = await realFixture(t); f.state.roles.set('500', 0n);
  f.guild._patch({ id: '100', owner_id: '200' });
  const denied = await f.policy.guild('200', '100', undefined, { fresh: true });
  assert.equal(f.guild.members.cache.get('200').permissions.has(P.ManageGuild), true);
  assert.equal(denied.guild.ownerId, '202'); assert.equal(denied.guildAdmin, false);
  assert.throws(() => requirePlayback(denied, f.client), { status: 403 });
  f.state.ownerId = '200';
  const allowed = await f.policy.guild('200', '100', undefined, { fresh: true });
  assert.equal(allowed.guildAdmin, true); requirePlayback(allowed, f.client);
  assert.equal(denied.guildAdmin, false); assert.equal(visible(denied, denied.channels.get('300')), false);
  f.state.ownerId = '202'; assert.equal((await f.command({ command: 'stop' })).status, 403); assert.deepEqual(f.calls, []);
});

test('native direct execution and disclosure use separate raw inventories; final role deletion hides state after exactly one write', async t => {
  const f = await realFixture(t); const pause = f.player.pause.bind(f.player);
  f.player.pause = async () => { await pause(); f.state.roles.delete('500'); };
  const response = await f.command({ command: 'pause' });
  assert.equal(response.status, 200); assert.equal(response.body.message, 'Request completed.');
  assert.equal(response.body.snapshot.session.current, null); assert.deepEqual(response.body.snapshot.session.listeners, []);
  assert.doesNotMatch(JSON.stringify(response.body), /Private channel|Song |abcdefghijk/);
  assert.equal(f.requests.filter(path => path === '/api/v10/guilds/100').length, 2);
  assert.equal(f.requests.some(path => path.endsWith('/roles')), false);
  assert.equal(f.guild.roles.cache.get('500').permissions.has(P.ViewChannel), true, 'the Gateway grant is still late');
  assert.deepEqual(f.calls, ['pause']);
});

test('malformed raw guild/role inventory fails closed without any grant despite valid cached grants', async t => {
  const cases = {
    'missing body': () => null,
    'wrong guild': data => ({ ...data, id: '101' }),
    'missing owner': data => ({ ...data, owner_id: undefined }),
    'numeric owner': data => ({ ...data, owner_id: 200 }),
    'unavailable guild': data => ({ ...data, unavailable: true }),
    'missing roles': data => ({ ...data, roles: undefined }),
    'map roles': data => ({ ...data, roles: {} }),
    'empty roles': data => ({ ...data, roles: [] }),
    'missing everyone': data => ({ ...data, roles: data.roles.filter(role => role.id !== '100') }),
    'duplicate role': data => ({ ...data, roles: [...data.roles, data.roles[1]] }),
    'null role': data => ({ ...data, roles: [...data.roles, null] }),
    'missing permissions': data => ({ ...data, roles: data.roles.map(role => ({ ...role, permissions: undefined })) }),
    'numeric permissions': data => ({ ...data, roles: data.roles.map(role => ({ ...role, permissions: 8 })) }),
    'negative permissions': data => ({ ...data, roles: data.roles.map(role => ({ ...role, permissions: '-1' })) }),
    'malformed permissions': data => ({ ...data, roles: data.roles.map(role => ({ ...role, permissions: '0x8' })) }),
    'invalid role id': data => ({ ...data, roles: [...data.roles, { ...data.roles[1], id: 'bad' }] }),
    'missing role name': data => ({ ...data, roles: data.roles.map(role => ({ ...role, name: undefined })) }),
    'missing position': data => ({ ...data, roles: data.roles.map(role => ({ ...role, position: undefined })) }),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async t => {
    const f = await realFixture(t); f.state.guildResponse = change;
    await assert.rejects(f.policy.guild('900', '100', undefined, { fresh: true, channelScope: 'configuration' }), { status: 503, code: 'discord_unavailable' });
    // Member reads share the inventory's round, but no grant or channel
    // discovery follows a malformed inventory, and Stop writes nothing.
    assert.equal(f.requests.some(path => path.endsWith('/channels')), false);
    assert.equal((await f.command({ command: 'stop' })).status, 503); assert.deepEqual(f.calls, []);
    assert.equal(f.guild.roles.cache.get('500').permissions.has(P.ViewChannel), true);
  });
});

test('native Stop actor/bot timeouts hold urgent admissions while 128 ordinary native reads remain unsettled', { timeout: 16_000 }, async t => {
  const f = await realFixture(t); const ordinaryRelease = deferred(), memberRelease = deferred(), membersEntered = deferred();
  t.after(() => { ordinaryRelease.resolve(); memberRelease.resolve(); });
  const operators = Array.from({ length: 128 }, (_, index) => String(1000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: operators }); t.after(() => policy.close());
  const revisions = createRevisions(f.client); t.after(() => revisions.close()); const commands = await loadCommandsData();
  let memberReads = 0;
  f.state.beforeResponse = async path => {
    if (operators.includes(path.split('/').at(-1))) await ordinaryRelease.promise;
    if (path.startsWith('/api/v10/guilds/100/members/')) {
      if (++memberReads === 2) membersEntered.resolve();
      await memberRelease.promise;
    }
  };
  const ordinary = Promise.allSettled(operators.map(actor => policy.identity(actor)));
  await delay(10);
  await assert.rejects(policy.guild('200', '100', undefined, { fresh: true }), { status: 429 });
  const stop = () => executePortalCommand(f.client, policy, revisions, commands, '100', { actorId: '200', command: 'stop' });
  const firstStop = stop(); const denied = assert.rejects(firstStop, /too long/);
  await membersEntered.promise;
  // Two held member reads leave too little reserve for another whole round;
  // it is refused before any of its Discord requests start.
  await assert.rejects(stop(), { status: 429 });
  const timedOut = await ordinary; await denied;
  assert.ok(timedOut.every(result => result.status === 'rejected' && /too long/.test(result.reason.message)));
  await assert.rejects(policy.identity(operators[0], { fresh: true }), { status: 429 });
  await assert.rejects(stop(), { status: 429 }, 'timed-out underlying member requests still hold their urgent admissions');
  assert.equal(memberReads, 2); assert.deepEqual(f.calls, []); assert.equal(f.manager.getPlayer('100'), f.player);
  memberRelease.resolve(); await delay(20);
  assert.equal((await stop()).ok, true, 'Stop recovers after actual settlement while the ordinary pool stays occupied');
  assert.deepEqual(f.calls, ['stopPlaying', 'destroy']); assert.equal(f.manager.getPlayer('100'), undefined);
  ordinaryRelease.resolve();
});

test('pending shared channel responses bind separately to each actor authority without sharing grants', async t => {
  const f = await realFixture(t); const entered = deferred(), release = deferred(); t.after(() => release.resolve());
  f.state.members.set('200', []);
  let channelReads = 0;
  f.state.beforeResponse = async path => { if (path.startsWith('/api/v10/channels/')) { if (++channelReads === 2) entered.resolve(); await release.promise; } };
  const pending = [f.policy.guild('200', '100'), f.policy.guild('900', '100')];
  await entered.promise; await delay(20); assert.equal(channelReads, 2);
  f.guild.members.cache.get('200')._patch({ roles: ['500'] }); release.resolve();
  const [denied, allowed] = await Promise.all(pending);
  assert.equal(project(f, denied).session.current, null); assert.ok(project(f, allowed).session.current);
  assert.notEqual(denied.channels.get('300'), allowed.channels.get('300'));
  assert.notEqual(denied.channels.get('300').guild, allowed.channels.get('300').guild);
  assert.throws(() => requirePlayback(denied, f.client), { status: 403 }); requirePlayback(allowed, f.client);
  assert.equal(channelReads, 2, 'only actually pending external reads are shared');
});

test('stage-local actor role bits, membership role IDs and guild owner defeat stale grants during individual reads', async t => {
  for (const kind of ['role bits', 'member role IDs', 'guild owner']) await t.test(kind, async t => {
    const f = await realFixture(t);
    if (kind === 'member role IDs') f.state.members.set('200', []);
    else f.state.roles.set('500', 0n);
    await f.library.recordHistory(f.player, track());
    await f.library.updateGuild('100', data => { data.session = { voiceChannelId: '300', textChannelId: '400', savedAt: Date.now(),
      position: 12000, paused: true, volume: 70, repeatMode: 'off', tracks: [trackReference(track())] }; });
    const held = holdText(t, f);
    const pending = f.policy.guild('200', '100', undefined, { fresh: true, channelScope: 'history' });
    await held.entered.promise;
    const actor = f.guild.members.cache.get('200');
    const staleGrant = () => {
      if (kind === 'role bits') f.guild.roles.cache.get('500')._patch({ id: '500', permissions: String(P.ViewChannel | P.ManageGuild) });
      if (kind === 'member role IDs') actor._patch({ roles: ['500', '502'] });
      if (kind === 'guild owner') f.guild._patch({ id: '100', owner_id: '200' });
    };
    staleGrant(); assert.equal(actor.permissions.has(P.ViewChannel), true, 'the shared cache really regained a stale grant');
    held.release.resolve(); const context = await pending;
    assert.ok(context.guild instanceof Guild); assert.ok(context.member instanceof GuildMember);
    assert.ok(context.guild.roles.cache.get('500') instanceof Role);
    assert.ok(context.channels.get('300') instanceof VoiceChannel);
    assert.equal(context.channels.get('300').permissionsFor, VoiceChannel.prototype.permissionsFor, 'use the installed permission implementation');
    assert.notEqual(context.guild, f.guild); assert.notEqual(context.member, actor);
    assert.equal(context.guild.ownerId, '202'); assert.equal(context.guildAdmin, false);
    assert.equal(visible(context, context.channels.get('300')), false);
    assert.throws(() => requirePlayback(context, f.client), { status: 403, code: 'hidden_channel' });
    const snapshot = project(f, context);
    assert.equal(snapshot.session.current, null); assert.deepEqual(snapshot.session.queue, []);
    assert.deepEqual(snapshot.session.listeners, []); assert.equal(snapshot.savedSession.exists, false);
    assert.deepEqual(libraryProjection(f.client, context).history, []);
    assert.doesNotMatch(JSON.stringify(snapshot), /Private channel|Song |abcdefghijk|12000/);
    // Exercise the real native dispatch too, injecting the late cache grant at
    // every command stage instead of relying on the policy-only assertion.
    f.state.beforeResponse = async path => { if (path === '/api/v10/channels/400') staleGrant(); };
    assert.equal((await f.command({ command: 'pause' })).status, 403); assert.deepEqual(f.calls, []);
    f.state.beforeResponse = async () => {};
    f.state.roles.set('500', P.ViewChannel | P.ManageGuild); f.state.members.set('200', ['500']);
    const next = await f.policy.guild('200', '100', undefined, { fresh: true, channelScope: 'history' });
    requirePlayback(next, f.client); assert.ok(project(f, next).session.current);
    assert.equal(libraryProjection(f.client, next).history.length, 1);
    assert.equal((await f.command({ command: 'pause' })).status, 200); assert.deepEqual(f.calls, ['pause']);
    assert.equal(visible(context, context.channels.get('300')), false, 'a later fresh grant must not change the old stage');
  });
});

test('raw guild roles/owner and both member responses detach before still-pending sibling inputs', async t => {
  for (const kind of ['roles before member', 'member before bot', 'bot before member', 'owner before bot']) await t.test(kind, async t => {
    const f = await realFixture(t); const held = deferred(), release = deferred(); t.after(() => release.resolve());
    if (kind === 'roles before member') f.state.roles.set('500', 0n);
    else if (kind === 'member before bot') f.state.members.set('200', []);
    else if (kind === 'bot before member') f.state.members.set('999', []);
    else f.state.roles.set('500', 0n);
    f.state.beforeResponse = async path => {
      if (path === (['roles before member', 'bot before member'].includes(kind) ? '/api/v10/guilds/100/members/200' : '/api/v10/guilds/100/members/999')) { held.resolve(); await release.promise; }
    };
    const pending = f.policy.guild('200', '100', undefined, { fresh: true }); await held.promise;
    await delay(20); // The other installed REST manager has settled and patched.
    if (kind === 'roles before member') f.guild.roles.cache.get('500')._patch({ id: '500', permissions: String(P.ViewChannel) });
    if (kind === 'member before bot') f.guild.members.cache.get('200')._patch({ roles: ['500'] });
    if (kind === 'bot before member') f.guild.members.cache.get('999')._patch({ roles: ['501'] });
    if (kind === 'owner before bot') f.guild._patch({ id: '100', owner_id: '200' });
    assert.equal(f.guild.members.cache.get('200').permissions.has(P.ViewChannel), true);
    release.resolve(); const context = await pending;
    assert.equal(context.guildAdmin, false);
    if (kind === 'bot before member') {
      assert.equal(context.channels.get('300').joinable, false); assert.equal(context.channels.get('300').speakable, false);
      assert.equal(writable(context, context.channels.get('400')), false);
    } else {
      assert.equal(project(f, context).session.current, null);
      assert.throws(() => requirePlayback(context, f.client), { status: 403 });
    }
  });
});

test('native bot join/speak/writability use stage-local role bits, member role IDs and owner despite late grants', async t => {
  for (const kind of ['role bits', 'member role IDs', 'guild owner']) await t.test(kind, async t => {
    const f = await realFixture(t);
    f.state.roles.set('501', P.ViewChannel);
    const held = holdText(t, f);
    const pending = f.policy.guild('200', '100', undefined, { fresh: true }); await held.entered.promise;
    const bot = f.guild.members.cache.get('999');
    const staleGrant = () => {
      if (kind === 'role bits') f.guild.roles.cache.get('501')._patch({ id: '501', permissions: String(P.Administrator) });
      if (kind === 'member role IDs') bot._patch({ roles: ['501', '502'] });
      if (kind === 'guild owner') f.guild._patch({ id: '100', owner_id: '999' });
    };
    staleGrant(); assert.equal(bot.permissions.has(P.Connect), true);
    held.release.resolve(); const context = await pending;
    const voice = context.channels.get('300');
    assert.equal(context.guild.members.me, context.me);
    assert.equal(context.me.guild, context.guild); assert.equal(context.member.guild, context.guild);
    assert.equal(voice.guild, context.guild); assert.equal(context.guild.ownerId, '202');
    assert.equal(voice.joinable, false); assert.equal(voice.speakable, false);
    assert.equal(voice.permissionsFor(f.discord.user).has(P.Connect), false);
    assert.equal(voice.permissionsFor(bot).has(P.Connect), false, 'native resolution cannot smuggle a cached member into the stage');
    assert.equal(writable(context, context.channels.get('400')), false);
    assert.equal(project(f, context).session.canAdd, false);
    f.state.beforeResponse = async path => { if (path === '/api/v10/channels/400') staleGrant(); };
    const joined = await f.command({ command: 'play', options: { query: 'safe' } });
    assert.equal(joined.status, 403); assert.match(joined.body.error.message, /join that voice channel/);
    // A distinct fresh input permits Connect while withholding Speak. Native
    // speech denial must survive the same cache grant on this next stage.
    f.state.roles.set('501', P.ViewChannel | P.Connect);
    const speaking = await f.command({ command: 'play', options: { query: 'safe' } });
    assert.equal(speaking.status, 403); assert.match(speaking.body.error.message, /Speak permission/);
    const configured = await f.command({ command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } }, { actor: '900' });
    assert.equal(configured.status, 400); assert.equal(configured.body.error.code, 'invalid_channel');
    assert.equal(f.library.settings('100').musicTextChannelId, '400'); assert.deepEqual(f.calls, []);
    f.state.beforeResponse = async () => {}; f.state.roles.set('501', botAccess);
    const next = await f.policy.guild('200', '100', undefined, { fresh: true });
    assert.equal(next.channels.get('300').joinable, true); assert.equal(next.channels.get('300').speakable, true);
    assert.equal(writable(next, next.channels.get('400')), true);
    assert.equal((await f.command({ command: 'play', options: { query: 'safe' } })).status, 200);
    assert.deepEqual(f.calls, ['add']); assert.equal(voice.joinable, false); assert.equal(voice.speakable, false);
  });
});

test('native settings bot read uses the same stage inputs and a durable fresh stage rejects newly revoked writability', async t => {
  const f = await realFixture(t); const commands = await loadCommandsData(); const settings = commands.get('settings');
  const revisions = createRevisions(f.client); t.after(() => revisions.close());
  let nativeChecks = 0;
  commands.set('settings', { ...settings, async execute(interaction) {
    const channel = await interaction.guild.channels.fetch('401', { force: true });
    f.guild.roles.cache.get('501')._patch({ id: '501', permissions: '0' });
    f.guild.members.cache.get('999')._patch({ roles: [] }); f.guild._patch({ id: '100', owner_id: '999' });
    const me = await interaction.guild.members.fetchMe({ force: true });
    assert.equal(channel.guild.members.me, me); assert.equal(me.guild, channel.guild);
    assert.equal(channel.permissionsFor(me).has([P.ViewChannel, P.SendMessages, P.EmbedLinks]), true, 'a cache revoke cannot mutate an already captured stage either');
    nativeChecks++;
    return settings.execute(interaction);
  } });
  const update = f.library.updateGuild.bind(f.library); let transactions = 0;
  f.library.updateGuild = (...args) => { transactions++; f.state.roles.set('501', P.ViewChannel); return update(...args); };
  await assert.rejects(executePortalCommand(f.client, f.policy, revisions, commands, '100', {
    actorId: '900', command: 'settings', subcommand: 'musicchannel', options: { channel: '401' },
  }), { status: 400, code: 'invalid_channel' });
  assert.equal(nativeChecks, 1); assert.equal(transactions, 1); assert.equal(f.library.settings('100').musicTextChannelId, '400');
});

test('permissions use the entire fresh role inventory while configuration keeps its 250-role projection bound', async t => {
  const f = await realFixture(t);
  for (let id = 1000; id < 1300; id++) f.state.roles.set(String(id), 0n);
  f.state.roles.set('1300', P.ViewChannel | P.ManageGuild); f.state.members.set('200', ['1300']);
  const context = await f.policy.guild('200', '100', undefined, { fresh: true, channelScope: 'configuration' });
  assert.equal(context.guildAdmin, true); assert.equal(context.roleIds.has('1300'), true);
  assert.equal(context.member.permissions.has(P.ManageGuild), true); requirePlayback(context, f.client);
  assert.equal(configurationProjection(context).roles.length, 250);
  assert.ok(project(f, context).session.current);
});

test('idle maintainer mix/list final membership loss exposes no captured guild-library name or count', async t => {
  const f = await realFixture(t, { idle: true }); const name = 'synthetic-private-mix';
  await f.library.updateGuild('100', data => { data.mixes[name] = { ownerId: '900', tracks: [trackReference(track())], savedAt: 12345 }; });
  // Match the review's zero-track in-memory reply exactly without weakening the
  // durable library's nonempty-mix invariant or persisting an invalid document.
  const readGuild = f.library.readGuild.bind(f.library);
  f.library.readGuild = id => { const data = readGuild(id); if (id === '100') data.mixes[name].tracks = []; return data; };
  await f.library.updateFavorites('200', list => list.push(trackReference(track('bbbbbbbbbbb'))));
  await f.library.updateFavorites('900', list => list.push(trackReference(track('aaaaaaaaaaa'))));
  let memberReads = 0;
  f.state.beforeResponse = async path => { if (path === '/api/v10/guilds/100/members/900' && ++memberReads === 3) f.state.members.delete('900'); };
  const response = await f.command({ command: 'mix', subcommand: 'list' }, { actor: '900' });
  assert.equal(response.status, 200); assert.equal(memberReads, 3); assert.equal(f.state.applicationReads, 3);
  assert.equal(response.body.snapshot.guild.admin, true); assert.deepEqual(response.body.snapshot.channels, []);
  assert.match(response.body.snapshot.session.reason, /Join this server/); assert.equal(response.body.message, 'Request completed.');
  assert.doesNotMatch(JSON.stringify(response.body), /synthetic-private-mix|0 tracks|bbbbbbbbbbb/);
  assert.equal(Object.keys(f.library.readGuild('100').mixes).length, 1); assert.deepEqual(f.calls, []);
  const finalContext = await f.policy.guild('900', '100', undefined, { fresh: true });
  assert.equal(finalContext.member, null); assert.equal(finalContext.guild.members.resolve(f.discord.users.cache.get('900')), null,
    'Gateway voice/listener data must not resurrect freshly absent membership');
  const library = await f.request('/library', { actor: '900' });
  assert.deepEqual(library.body.mixes, []); assert.match(JSON.stringify(library.body.favorites), /aaaaaaaaaaa/);
  assert.doesNotMatch(JSON.stringify(library.body), /bbbbbbbbbbb|synthetic-private-mix/);
  const settings = await f.command({ command: 'settings', subcommand: 'volume', options: { value: 65 } }, { actor: '900' });
  assert.equal(settings.status, 200); assert.match(settings.body.message, /65%/);
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 200);
});

test('all guild mix acknowledgments fence final membership without reexecuting native reads or writes', async t => {
  for (const action of ['list', 'save', 'load', 'delete']) await t.test(action, async t => {
    const f = await realFixture(t, { idle: ['list', 'delete'].includes(action) }); const name = 'synthetic-private-mix';
    await f.library.updateGuild('100', data => { data.mixes[name] = { ownerId: '900', tracks: [trackReference(track())], savedAt: 12345 }; });
    const revisions = createRevisions(f.client); t.after(() => revisions.close());
    const commands = await loadCommandsData(); const mix = commands.get('mix'); let executions = 0, writes = 0;
    const update = f.library.updateGuild.bind(f.library); f.library.updateGuild = (...args) => { writes++; return update(...args); };
    commands.set('mix', { ...mix, async execute(interaction) { executions++; await mix.execute(interaction); f.state.members.delete('900'); } });
    // Loading an unavailable saved source gives a useful native error without
    // an enqueue; final membership still fences its guild-library reply.
    if (action === 'load') f.node.search = async () => ({ loadType: 'empty', tracks: [] });
    const body = { actorId: '900', command: 'mix', subcommand: action, options: action === 'list' ? {} : { name } };
    if (action === 'save') { body.options.replace = true; body.expectedRevision = revisions.revision('100'); }
    if (action === 'delete') body.expectedMixVersion = mixVersion(f.library.readGuild('100').mixes[name]);
    const response = await executePortalCommand(f.client, f.policy, revisions, commands, '100', body);
    assert.equal(response.message, 'Request completed.'); assert.equal(response.snapshot.guild.admin, true);
    assert.doesNotMatch(JSON.stringify(response), /synthetic-private-mix|\d+ tracks/);
    assert.equal(executions, 1); assert.equal(writes, ['save', 'delete'].includes(action) ? 1 : 0); assert.deepEqual(f.calls, []);
    if (action === 'delete') assert.equal(f.library.readGuild('100').mixes[name], undefined);
  });
});
