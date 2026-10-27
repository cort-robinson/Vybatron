import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, VoiceChannel, TextChannel, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { trackReference } from '../src/utils/library.js';
import { execute as favorite } from '../src/commands/favorite.js';
import { execute as mix } from '../src/commands/mix.js';
import { execute as session } from '../src/commands/session.js';
import { execute as queue } from '../src/commands/queue.js';
import { execute as nowplaying } from '../src/commands/nowplaying.js';
import { execute as history } from '../src/commands/history.js';
import { withGuildMutation } from '../src/utils/requests.js';
import { createPortalPolicy, IDENTITY_CACHE, READ_ADMISSIONS } from '../src/portal/policy.js';

const slash = (f, command, action, values = {}) => ({
  client: f.client, guildId: '100', guild: f.guild, user: f.users.get('200'), member: f.members.get('200'), commandName: command,
  options: { getSubcommand: () => action, getInteger: key => values[key] ?? null, getString: key => values[key] ?? null, getBoolean: key => values[key] ?? null },
  isMessageComponent: () => false, replies: [], async reply(payload) { this.replies.push(payload); },
});

test('clear is revision fenced and removes only upcoming tracks, retaining paused audio and recording successful activity', async t => {
  const f = await portalFixture(t);
  f.player.paused = true; f.player.playing = false;
  const current = f.player.queue.current;
  const revision = (await f.request()).body.revision;
  const schema = (await f.request('/v1/bootstrap?actorId=200')).body.commands;
  assert.ok(schema.some(command => command.name === 'clear'));
  assert.equal((await f.command({ command: 'clear' })).status, 400);
  const cleared = await f.command({ command: 'clear', expectedRevision: revision });
  assert.equal(cleared.status, 200); assert.notEqual(cleared.body.snapshot.revision, revision);
  assert.equal(f.player.queue.current, current); assert.equal(f.player.queue.tracks.length, 0);
  assert.equal(f.player.paused, true); assert.equal(f.player.playing, false);
  assert.equal(f.player.position, 8000); assert.equal(f.player.lastPosition, 8000);
  assert.equal(f.player.connected, true); assert.equal(f.player.voiceChannelId, '300'); assert.equal(f.player.textChannelId, '400');
  assert.deepEqual(f.calls, ['splice']);
  assert.equal(f.library.readGuild('100').activity.length, 1);
  assert.equal((await f.command({ command: 'clear', expectedRevision: revision })).status, 409);
  assert.equal((await f.command({ command: 'clear', expectedRevision: cleared.body.snapshot.revision })).status, 200);
  assert.equal(f.library.readGuild('100').activity.length, 1, 'empty clear does not record a successful edit');
});

test('clear retains same-voice, DJ, source visibility and inside-lane conflict protection', async t => {
  const f = await portalFixture(t);
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  const revision = (await f.request()).body.revision;
  assert.equal((await f.command({ command: 'clear', expectedRevision: revision })).status, 403);
  f.members.get('200').roles.cache.set('500', f.roles.get('500'));
  f.members.get('200').voice.channel = f.channels.get('301');
  assert.equal((await f.command({ command: 'clear', expectedRevision: revision })).status, 403);
  f.members.get('200').voice.channel = f.channels.get('300');
  f.channels.get('400').hidden.add('200');
  assert.equal((await f.command({ command: 'clear', expectedRevision: revision })).status, 403);
  f.channels.get('400').hidden.delete('200');
  const entered = deferred(); const release = deferred();
  const held = withGuildMutation('100', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const clearing = f.command({ command: 'clear', expectedRevision: revision });
  await delay(30); f.manager.emit('trackEnd', f.player); release.resolve(); await held;
  assert.equal((await clearing).status, 409); assert.equal(f.player.queue.tracks.length, 2);
});

test('favorite add selects a fresh one-based upcoming entry outside voice using the unchanged session revision', async t => {
  const f = await portalFixture(t); f.members.get('200').voice.channel = null;
  const revision = (await f.request()).body.revision;
  const command = { command: 'favorite', subcommand: 'add', expectedRevision: revision };
  assert.equal((await f.command({ ...command, expectedRevision: undefined, options: { position: 1 } })).status, 400);
  for (const position of [0, 3, 501, 1.5, '1']) assert.equal((await f.command({ ...command, options: { position } })).status, 400);
  const added = await f.command({ ...command, options: { position: 2 } });
  assert.equal(added.status, 200); assert.equal(added.body.snapshot.revision, revision);
  assert.equal(f.library.favorites('200')[0].identifier, '01234567890');
  assert.equal((await f.command(command)).status, 200);
  assert.equal(f.library.favorites('200')[1].identifier, 'abcdefghijk');
  assert.equal(f.library.readGuild('100').activity.length, 0);
  assert.equal((await f.request('/library', { actor: '201' })).body.favorites.length, 0);
  const schema = (await f.request('/v1/bootstrap?actorId=200')).body.commands.find(item => item.name === 'favorite');
  assert.equal(schema.options.find(item => item.name === 'add').options[0].max_value, 500);
  assert.equal(schema.options.find(item => item.name === 'remove').options[0].max_value, 1000);
  f.player.queue.current = null;
  const queuedRevision = (await f.request()).body.revision;
  assert.equal((await f.command({ ...command, expectedRevision: queuedRevision, options: { position: 1 } })).status, 200, 'a queued reference remains saveable during a current-track gap');
  assert.equal((await f.command({ ...command, expectedRevision: queuedRevision })).status, 409);
  f.player.queue.current = track();
  f.channels.get('400').hidden.add('200');
  assert.equal((await f.command({ ...command, options: { position: 1 } })).status, 403);
});

test('Discord read handlers cannot expose live queue/history or original saved channels through another visible text channel', async t => {
  const f = await portalFixture(t); f.members.get('200').voice.channel = null;
  await f.library.updateGuild('100', guild => { guild.session = { voiceChannelId: '300', textChannelId: '400', savedAt: Date.now(), position: 12_000, paused: true, volume: 70, repeatMode: 'off', tracks: [trackReference(track())] }; });
  for (const channel of ['300', '400']) {
    f.channels.get(channel).hidden.add('200');
    for (const [handler, name] of [[queue, 'queue'], [nowplaying, 'nowplaying'], [history, 'history'], [session, 'session']]) {
      const interaction = slash(f, name, 'show'); interaction.channelId = '401';
      await handler(interaction);
      assert.match(interaction.replies[0].content, /not visible/);
      assert.doesNotMatch(JSON.stringify(interaction.replies), /abcdefghijk|General|12000/);
    }
    f.channels.get(channel).hidden.delete('200');
  }
  const interaction = slash(f, 'queue', 'show');
  await queue(interaction); assert.match(JSON.stringify(interaction.replies), /lmnopqrstuv/);
});

test('slash favorite/mix saves require both original source channels and preserve source binding behind the global library transaction', async t => {
  const f = await portalFixture(t); f.members.get('200').voice.channel = null;
  for (const channel of ['300', '400']) {
    f.channels.get(channel).hidden.add('200');
    for (const [handler, command, values] of [[favorite, 'favorite', { position: 1 }], [mix, 'mix', { name: 'private' }]]) {
      const interaction = slash(f, command, command === 'favorite' ? 'add' : 'save', values);
      await handler(interaction); assert.match(interaction.replies[0].content, /not visible/);
    }
    f.channels.get(channel).hidden.delete('200');
  }
  assert.equal(f.library.favorites('200').length, 0); assert.equal(Object.keys(f.library.readGuild('100').mixes).length, 0);
  const entered = deferred(); const release = deferred(); const saving = deferred();
  const held = f.library.updateDocument(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const original = f.library.updateFavorites.bind(f.library);
  f.library.updateFavorites = (...args) => { saving.resolve(); return original(...args); };
  const pending = favorite(slash(f, 'favorite', 'add', { position: 1 }));
  const rejected = assert.rejects(pending, /favorites changed/);
  await saving.promise; f.player.queue.tracks.reverse(); release.resolve(); await held; await rejected;
  assert.equal(f.library.favorites('200').length, 0);
  await favorite(slash(f, 'favorite', 'add', { position: 1 }));
  assert.equal(f.library.favorites('200')[0].identifier, '01234567890');
});

test('all 1000 favorites remain addressable and migrated overflow is promoted through actual HTTP removal', async t => {
  const f = await portalFixture(t);
  await f.library.updateDocument(document => {
    document.favorites['200'] = Array.from({ length: 1000 }, (_, i) => trackReference(track(String(i).padStart(11, '0'))));
    document.favoriteOverflow['200'] = [trackReference(track('00000001000'))];
  });
  const displayed = (await f.request('/library')).body.favorites;
  assert.equal(displayed.length, 1000);
  assert.equal((await f.command({ command: 'favorite', subcommand: 'remove', options: { index: 1001 }, expectedTrackId: displayed[999].id })).status, 400);
  assert.equal((await f.command({ command: 'favorite', subcommand: 'remove', options: { index: 1000 }, expectedTrackId: displayed[999].id })).status, 200);
  assert.equal(f.library.favorites('200').length, 1000); assert.equal(f.library.favoriteOverflowCount('200'), 0);
  assert.equal(f.library.favorites('200')[999].identifier, '00000001000');
  const promotedId = (await f.request('/library')).body.favorites[999].id;
  assert.equal((await f.command({ command: 'favorite', subcommand: 'play', options: { index: 1000 }, expectedTrackId: promotedId })).status, 200);
  assert.equal(f.player.queue.tracks.at(-1).info.identifier, '00000001000');
  assert.equal((await f.command({ command: 'favorite', subcommand: 'clear', options: { confirm: true } })).status, 200);
  assert.equal(f.library.favorites('200').length, 0); assert.equal(f.library.favoriteOverflowCount('200'), 0);
});

test('mix source visibility is checked again at the actual durable write after a queued global library save', async t => {
  const f = await portalFixture(t); f.members.get('200').voice.channel = null;
  const entered = deferred(); const release = deferred(); const saving = deferred();
  const held = f.library.updateDocument(async () => { entered.resolve(); await release.promise; }); await entered.promise;
  const original = f.library.updateGuild.bind(f.library);
  f.library.updateGuild = (...args) => { saving.resolve(); return original(...args); };
  const interaction = slash(f, 'mix', 'save', { name: 'private' });
  const pending = mix(interaction); await saving.promise;
  f.channels.get('400').hidden.add('200'); release.resolve(); await held; await pending;
  assert.equal(Object.keys(f.library.readGuild('100').mixes).length, 0);
  assert.match(interaction.replies[0].content, /not visible/); assert.equal(interaction.replies.length, 1);
});

test('four overlapping HTTP snapshots coalesce fresh individual Discord reads without retaining permission results', async t => {
  const f = await portalFixture(t); const counts = {};
  for (const [key, target, name] of [['user', f.client.users, 'fetch'], ['application', f.client.application, 'fetch'], ['guild', f.client.rest, 'get'], ['member', f.guild.members, 'fetch'], ['channels', f.guild.channels, 'fetch'], ['me', f.guild.members, 'fetchMe']]) {
    const original = target[name].bind(target);
    target[name] = async (...args) => { counts[key] = (counts[key] || 0) + 1; await delay(30); return original(...args); };
  }
  const snapshots = await Promise.all(Array.from({ length: 4 }, () => f.request()));
  assert.ok(snapshots.every(response => response.status === 200));
  assert.deepEqual(counts, { user: 1, application: 1, guild: 1, member: 1, me: 1, channels: 2 });
  assert.ok(f.channelReads.every(read => read.id && read.force === true && read.cache !== false));
  f.channels.get('400').hidden.add('200');
  assert.equal((await f.request()).body.session.current, null);
  assert.equal(counts.channels, 4); assert.equal(counts.guild, 2);
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 200);
  // The application owner is remembered for five minutes (ADR-0011), then read again.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  f.client.application.fetch = async () => ({ owner: f.users.get('901') });
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 200);
  t.mock.timers.tick(IDENTITY_CACHE.applicationMs + 1);
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 404);
  f.members.delete('200'); assert.equal((await f.request()).status, 404);
});

test('commands start new membership verification rather than joining an earlier in-flight read', async t => {
  const f = await portalFixture(t); const started = deferred(); const release = deferred(); let calls = 0;
  f.guild.members.fetch = async () => {
    const member = f.members.get('200');
    if (++calls === 1) { started.resolve(); await release.promise; }
    if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 });
    return member;
  };
  const snapshot = f.request(); await started.promise; f.members.delete('200');
  assert.equal((await f.command({ command: 'pause' })).status, 404);
  assert.equal(f.calls.includes('pause'), false); release.resolve(); await snapshot;
});

test('fresh role inventory removes a deleted cached role from real Discord member and channel permission calculations', async t => {
  const f = await portalFixture(t); const discord = new Client({ intents: [] });
  const guild = discord.guilds._add({ id: '100', name: 'Role verification', owner_id: '202', roles: [
    { id: '100', name: '@everyone', permissions: '0' },
    { id: '500', name: 'Deleted manager', permissions: String(P.ManageGuild | P.ViewChannel) },
  ] });
  const member = guild.members._add({ user: { id: '200', username: 'Listener', discriminator: '0' }, roles: ['500'] });
  assert.equal(member.permissions.has(P.ManageGuild), true, 'simulate a delayed gateway deletion');
  guild.channels.cache.set('300', new VoiceChannel(guild, { id: '300', name: 'Restricted voice', permission_overwrites: [] }, discord));
  guild.channels.cache.set('400', new TextChannel(guild, { id: '400', name: 'Restricted music', permission_overwrites: [] }, discord));
  guild.members.fetch = async () => member; guild.members.fetchMe = async () => f.me;
  guild.channels.fetch = async (id, options) => { assert.equal(options.force, true); return guild.channels.cache.get(id); };
  f.client.guilds.cache.set('100', guild); f.client.guilds.fetch = async () => guild;
  f.client.rest.get = async route => { assert.equal(route, '/guilds/100'); return { id: '100', name: guild.name, owner_id: '202',
    roles: [{ id: '100', name: '@everyone', permissions: '0', position: 0 }] }; };
  const snapshot = (await f.request()).body;
  assert.equal(snapshot.guild.admin, false); assert.equal(snapshot.settings, null);
  assert.equal(snapshot.session.current, null); assert.deepEqual(snapshot.channels, []);
  assert.equal((await f.request('/diagnostics')).status, 403);
  await discord.destroy();
});

test('outside-guild maintainer receives settings/diagnostics without channel metadata or session access', async t => {
  const f = await portalFixture(t);
  const snapshot = (await f.request('', { actor: '900' })).body;
  assert.ok(snapshot.settings); assert.equal(snapshot.guild.admin, true);
  assert.deepEqual(snapshot.channels, []); assert.equal(snapshot.session.current, null); assert.equal(snapshot.session.voiceChannel, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /General|Private voice|alternate music|Song /);
  assert.equal((await f.request('/diagnostics', { actor: '900' })).status, 200);
});

test('replay cannot enqueue a previously visible historical recording after its original channel becomes hidden during lookup', async t => {
  const started = deferred(); const release = deferred();
  const f = await portalFixture(t, { search: () => { started.resolve(); return release.promise; } });
  await f.library.recordHistory(f.player, track());
  await f.library.recordHistory({ ...f.player, voiceChannelId: '301' }, track('aaaaaaaaaaa'));
  const revision = (await f.request()).body.revision;
  const historyId = (await f.request('/library')).body.history[0].id;
  const replaying = f.command({ command: 'replay', options: { index: 1 }, expectedRevision: revision, expectedHistoryId: historyId });
  await started.promise; f.channels.get('301').hidden.add('200');
  release.resolve({ loadType: 'track', tracks: [track('aaaaaaaaaaa')] });
  assert.equal((await replaying).status, 409);
  assert.equal(f.calls.includes('splice'), false); assert.equal(f.player.queue.tracks.length, 2);
});

test('Stop retains reserved HTTP capacity and rate allowance during a saturated slow lookup', async t => {
  const started = deferred(); const release = deferred();
  const f = await portalFixture(t, { bridge: { maxInFlight: 1, maxRequestsPerMinute: 1 }, search: () => { started.resolve(); return release.promise; } });
  const pending = f.command({ command: 'play', options: { query: 'slow' } }); await started.promise;
  assert.equal((await f.request('/health')).status, 429);
  const stopping = await Promise.race([f.command({ command: 'stop' }), delay(1000).then(() => assert.fail('Stop lacked reserved bridge capacity'))]);
  assert.equal(stopping.status, 200); assert.equal(f.manager.getPlayer('100'), undefined);
  release.resolve({ loadType: 'track', tracks: [track()] });
  assert.ok([403, 409].includes((await pending).status));
  assert.equal(f.library.readGuild('100').session, null);
});

test('stalled Discord requests remain coalesced after individual deadlines instead of multiplying every poll', async t => {
  const f = await portalFixture(t); const release = deferred(); let calls = 0;
  f.client.users.fetch = () => { calls++; return release.promise; };
  const policy = createPortalPolicy(f.client);
  await assert.rejects(policy.identity('200'), /too long|timed out/);
  const second = policy.identity('200'); await delay(20); assert.equal(calls, 1);
  release.resolve(f.users.get('200')); assert.equal((await second).user.id, '200');
  // Only the validated answer is remembered, never the timeout.
  await policy.identity('200'); assert.equal(calls, 1, 'a validated identity is remembered briefly');
  await policy.identity('200', { fresh: true }); assert.equal(calls, 2, 'a fresh identity reads again'); policy.close();
});

test('underlying Discord read admission is bounded across snapshot and fresh command reads, with reserved urgent slots', async t => {
  const f = await portalFixture(t); const release = deferred(); let calls = 0;
  f.client.users.fetch = async id => { calls++; await release.promise; return { id, bot: false }; };
  // Fill exact underlying-read admissions, not identity invocation counts.
  // Operator identities use one user read; non-operator width-two identity
  // reservations are covered separately in portal-identity-latency.test.js.
  const actors = Array.from({ length: 128 }, (_, index) => String(1000 + index));
  const urgentActors = Array.from({ length: READ_ADMISSIONS.urgent }, (_, index) => String(2000 + index));
  const policy = createPortalPolicy(f.client, { operatorIds: [...actors, ...urgentActors, '200', '202'] });
  t.after(() => { release.resolve(); policy.close(); });
  const pending = actors.map((actor, index) => policy.identity(actor, { fresh: index % 2 === 0 }));
  const settled = Promise.allSettled(pending);
  await delay(20); assert.equal(calls, 128);
  await assert.rejects(policy.identity('200', { fresh: true }), { status: 429 });
  const urgent = urgentActors.map(actor => policy.identity(actor, { fresh: true, urgent: true }));
  await delay(20); assert.equal(calls, 128 + READ_ADMISSIONS.urgent);
  await assert.rejects(policy.identity('202', { fresh: true, urgent: true }), { status: 429 });
  release.resolve();
  assert.ok((await settled).every(result => result.status === 'fulfilled'));
  await Promise.all(urgent);
  assert.equal((await policy.identity('200')).user.id, '200'); policy.close();
});
