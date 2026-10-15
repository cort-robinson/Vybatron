import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { startPortalBridge } from '../src/portal/index.js';
import { withGuildMutation } from '../src/utils/requests.js';
import { trackReference } from '../src/utils/library.js';
import { maintenanceStatus, setMaintenance } from '../src/utils/maintenance.js';
import { handleTrackStart } from '../src/lavalink.js';
import { track } from './fixtures.js';
import { safeImage, trackProjection } from '../src/portal/projection.js';

test('track projections reject signed/private media and unrestricted artwork without exposing encoded identities', () => {
  const candidate = track();
  candidate.info.uri = 'https://signed.invalid/audio?token=never-save';
  candidate.info.artworkUrl = 'https://evil.example/private.png?secret=never-save';
  const projected = trackProjection(candidate);
  assert.equal(projected.uri, null); assert.equal(projected.artworkUrl, null);
  assert.doesNotMatch(JSON.stringify(projected), /encoded-|never-save|signed\.invalid|evil\.example|pluginInfo|userData/);
  assert.equal(safeImage('https://cdn.discordapp.com/attachments/100/200/private.png'), null);
  assert.equal(safeImage('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg?token=private'), 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
});

test('bridge is opt-in, authenticated, bounded, rejects browser origins and contains request/bind failures', async t => {
  const disabled = startPortalBridge({}, { token: null });
  assert.equal(disabled.enabled, false); await disabled.close();
  const f = await portalFixture(t);
  for (const header of ['', 'Bearer wrong', `Bearer ${f.token}x`]) assert.equal((await f.request('/health', { headers: { Authorization: header } })).status, 401);
  assert.equal((await f.request('/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual((await f.request('/health')).body, { ready: true });
  const oversized = await fetch(`${f.origin}/v1/guilds/100/commands`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId: '200', command: 'play', options: { query: 'x'.repeat(20_000) } }) });
  assert.equal(oversized.status, 400);
  const invalid = await fetch(`${f.origin}/v1/guilds/100/commands`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  f.guild.channels.fetch = async () => { throw new Error('token=do-not-expose private upstream https://signed.invalid/audio'); };
  const failed = await f.request(); assert.equal(failed.status, 503); assert.doesNotMatch(JSON.stringify(failed.body), /do-not-expose|signed\.invalid|upstream/);
  const occupied = startPortalBridge(f.client, { token: f.token, port: f.bridge.server.address().port, logger: { error() {} } });
  await assert.rejects(occupied.ready, { code: 'EADDRINUSE' }); await occupied.close();
  assert.equal(f.manager.getPlayer('100'), f.player); assert.equal(f.player.playing, true);
});

test('bootstrap uses verified application owner, fresh membership and safe command/filter schemas', async t => {
  const f = await portalFixture(t);
  const initial = await f.request('/v1/bootstrap?actorId=200');
  assert.equal(initial.status, 200); assert.equal(initial.body.viewer.maintainer, false); assert.equal(initial.body.guilds[0].admin, false);
  assert.equal(initial.body.csrfToken, undefined);
  assert.ok(initial.body.commands.find(item => item.name === 'settings').options.some(item => item.name === 'musicchannel'));
  assert.equal(initial.body.commands.find(item => item.name === 'skipto').options[0].name, 'position');
  assert.equal(initial.body.commands.find(item => item.name === 'replay').options[0].name, 'index');
  assert.ok(initial.body.filters.some(item => item.id === 'warm'));
  assert.doesNotMatch(JSON.stringify(initial.body), /encoded-|token|clientData|size=/);
  assert.equal(initial.body.voiceGuildId, '100');
  const voice = f.members.get('200').voice.channel; f.members.get('200').voice.channel = null;
  assert.equal((await f.request('/v1/bootstrap?actorId=200')).body.voiceGuildId, null);
  f.members.get('200').voice.channel = voice;
  assert.equal((await f.request('/v1/bootstrap?actorId=900')).body.viewer.maintainer, true);
  f.members.delete('200');
  assert.equal((await f.request()).status, 404);
  assert.equal((await f.request('/v1/bootstrap?actorId=200')).body.guilds.length, 0);
  assert.ok(f.memberFetches >= 4);
});

test('team owner and explicit trusted operators have configuration/diagnostics access but no playback privilege', async t => {
  const f = await portalFixture(t, { owner: { id: '800', ownerId: '901' }, bridge: { operatorIds: ['900'] } });
  for (const id of ['900', '901']) {
    assert.equal((await f.request('/diagnostics', { actor: id })).status, 200);
    const snapshot = (await f.request('', { actor: id })).body;
    assert.equal(snapshot.guild.admin, true); assert.equal(snapshot.session.current, null); assert.equal(snapshot.session.canControl, false);
    assert.equal((await f.command({ command: 'settings', subcommand: 'volume', options: { value: 60 } }, { actor: id })).status, 200);
    assert.equal((await f.command({ command: 'volume', options: { level: 50 } }, { actor: id })).status, 403);
  }
  assert.equal((await f.request('/diagnostics')).status, 403);
  assert.equal((await f.command({ command: 'settings', subcommand: 'volume', options: { value: 55 } }, { actor: '202' })).status, 200, 'guild owner has config access without ManageGuild bit');
  f.members.get('202').voice.channel = f.channels.get('301');
  assert.equal((await f.command({ command: 'pause' }, { actor: '202' })).status, 403, 'guild owner still needs same voice');
  f.members.set('900', { ...f.members.get('200'), id: '900', user: f.users.get('900') });
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  assert.equal((await f.command({ command: 'pause' }, { actor: '900' })).status, 403, 'member maintainer still needs DJ');
});

test('projections conceal hidden live/saved channels, filter history and isolate global private favorites', async t => {
  const f = await portalFixture(t);
  await f.library.updateFavorites('200', list => list.push(trackReference(track('aaaaaaaaaaa'))));
  await f.library.updateFavorites('201', list => list.push(trackReference(track('bbbbbbbbbbb'))));
  await f.library.recordHistory(f.player, track());
  await f.library.recordHistory({ ...f.player, voiceChannelId: '301' }, track('ccccccccccc'));
  await f.library.updateGuild('100', guild => { guild.session = { voiceChannelId: '300', textChannelId: '400', savedAt: Date.now(), position: 1234, paused: true, volume: 75, repeatMode: 'queue', tracks: [trackReference(track())] }; });
  f.channels.get('301').hidden.add('200');
  const library = (await f.request('/library')).body;
  assert.equal(library.history.length, 1); assert.equal(library.favorites.length, 1);
  assert.doesNotMatch(JSON.stringify(library), /bbbbbbbbbbb|ccccccccccc|encoded-|never-save|userData|pluginInfo/);
  const visible = (await f.request()).body;
  assert.equal(visible.settings, null); assert.equal(visible.channels.length, 0); assert.ok(visible.session.current);
  f.channels.get('300').hidden.add('200');
  const hidden = (await f.request()).body;
  assert.equal(hidden.session.current, null); assert.equal(hidden.session.queue.length, 0); assert.equal(hidden.session.listeners.length, 0);
  assert.equal(hidden.session.voiceChannel, null); assert.equal(hidden.session.textChannel, null); assert.equal(hidden.savedSession.exists, false);
  assert.doesNotMatch(JSON.stringify(hidden), /abcdefghijk|General|Private voice|1234/);
  assert.equal((await f.request('/library')).body.history.length, 0);
  assert.equal((await f.command({ command: 'stop' })).status, 403);
});

test('actual commands enforce DJ/same-voice, strict options, maintenance leases and stale revisions', async t => {
  const f = await portalFixture(t);
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  const initial = (await f.request()).body;
  assert.equal((await f.command({ command: 'pause' })).status, 403);
  assert.equal((await f.command({ command: 'play', options: { query: 'file:///private.mp3' } })).status, 400);
  assert.equal((await f.command({ command: 'pause', maintainer: true })).status, 400);
  assert.equal((await f.command({ command: 'volume', options: { level: '50' } })).status, 400);
  assert.equal((await f.command({ command: 'play', options: { query: 'song', userId: '900' } })).status, 400);
  assert.equal((await f.command({ command: 'remove', options: { position: 1 } })).status, 400);
  f.members.get('200').roles.cache.set('500', f.roles.get('500'));
  const revision = (await f.request()).body.revision;
  f.player.position += 3000;
  assert.equal((await f.request()).body.revision, revision, 'interpolated position does not churn revisions');
  const removed = await f.command({ command: 'remove', options: { position: 1 }, expectedRevision: revision });
  assert.equal(removed.status, 200); assert.equal(f.player.queue.tracks.length, 1);
  assert.equal((await f.command({ command: 'remove', options: { position: 1 }, expectedRevision: revision })).status, 409);
  setMaintenance(f.client, true);
  const gated = await f.command({ command: 'play', options: { query: 'a song' } });
  assert.equal(gated.status, 503);
  setMaintenance(f.client, false);
  f.members.get('200').voice.channel = f.channels.get('301');
  assert.equal((await f.command({ command: 'pause' })).status, 403);
  assert.equal(maintenanceStatus(f.client).inFlight, 0);
  assert.equal(initial.session.canControl, false);
});

test('inside-lane conflicts include Discord edits and natural track-end events', async t => {
  const f = await portalFixture(t);
  for (const event of ['discord', 'trackEnd']) {
    const revision = (await f.request()).body.revision;
    const gate = deferred(); const entered = deferred();
    const held = withGuildMutation('100', async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    const response = f.command({ command: 'remove', options: { position: 1 }, expectedRevision: revision });
    await delay(50);
    if (event === 'discord') f.player.queue.tracks.reverse();
    else f.manager.emit('trackEnd', f.player);
    gate.resolve(); await held;
    assert.equal((await response).status, 409);
    assert.equal(f.player.queue.tracks.length, 2);
  }
});

test('explicit seeks change revision while natural time interpolation does not', async t => {
  const f = await portalFixture(t);
  const original = (await f.request()).body.revision;
  const sought = await f.command({ command: 'seek', options: { timestamp: '0:30' }, expectedRevision: original });
  assert.equal(sought.status, 200); assert.notEqual(sought.body.snapshot.revision, original);
  assert.equal((await f.command({ command: 'seek', options: { timestamp: '0:50' }, expectedRevision: original })).status, 409);
  f.player.position += 1000;
  assert.equal((await f.request()).body.revision, sought.body.snapshot.revision);
});

test('HTTP admission and response limits are bounded, and graceful close leaves active audio intact', async t => {
  const lookup = deferred(); const started = deferred();
  const f = await portalFixture(t, { search: () => { started.resolve(); return lookup.promise; }, bridge: { maxInFlight: 1 } });
  const search = f.request('/search?query=slow'); await started.promise;
  assert.equal((await f.request('/health')).status, 429);
  lookup.resolve({ tracks: [track()] }); assert.equal((await search).status, 200);
  await f.bridge.close(); assert.equal(f.bridge.server.listening, false); assert.equal(f.player.playing, true);
  const limited = startPortalBridge(f.client, { token: f.token, port: 0, maxRequestsPerMinute: 1, logger: { error() {} } }); await limited.ready;
  const endpoint = `http://127.0.0.1:${limited.server.address().port}/health`;
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${f.token}` } })).status, 200);
  assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${f.token}` } })).status, 429);
  await limited.close();
  const small = startPortalBridge(f.client, { token: f.token, port: 0, maxResponseBytes: 1024, logger: { error() {} } }); await small.ready;
  const response = await fetch(`http://127.0.0.1:${small.server.address().port}/v1/guilds/100?actorId=200`, { headers: { Authorization: `Bearer ${f.token}` } });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'projection_limit'); await small.close();
});

test('slow lookups recheck trusted membership/DJ state and Stop bypasses the lane without reviving audio', async t => {
  for (const scenario of ['left', 'DJ revoked', 'track ended', 'stop']) await t.test(scenario, async t => {
    const lookup = deferred(); const started = deferred();
    const f = await portalFixture(t, { search: () => { started.resolve(); return lookup.promise; } });
    const revision = (await f.request()).body.revision;
    if (scenario === 'DJ revoked') { await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; }); f.members.get('200').roles.cache.set('500', f.roles.get('500')); }
    const freshRevision = (await f.request()).body.revision;
    const running = f.command({ command: scenario === 'left' || scenario === 'stop' ? 'play' : 'playnext', options: { query: 'slow song' }, expectedRevision: freshRevision });
    await started.promise;
    if (scenario === 'left') f.members.delete('200');
    if (scenario === 'DJ revoked') f.members.get('200').roles.cache.delete('500');
    if (scenario === 'track ended') f.manager.emit('trackEnd', f.player);
    if (scenario === 'stop') {
      const stopping = await Promise.race([f.command({ command: 'stop', expectedRevision: revision }), delay(1000).then(() => assert.fail('Stop waited for lookup'))]);
      assert.equal(stopping.status, 200); assert.equal(f.manager.getPlayer('100'), undefined);
    }
    const count = f.calls.length;
    lookup.resolve({ loadType: 'track', tracks: [track('aaaaaaaaaaa')] });
    const response = await running;
    assert.ok([403, 404, 409].includes(response.status));
    assert.equal(f.calls.slice(count).includes('add'), false);
    assert.equal(f.calls.slice(count).includes('connect'), false);
    assert.equal(maintenanceStatus(f.client).inFlight, 0);
    if (scenario === 'stop') { await f.library.pending; assert.equal(f.library.readGuild('100').session, null); }
  });
});

test('ordinary additions serialize, use the configured text channel and retain the active controller channel', async t => {
  const lookups = []; const firstStarted = deferred(); const first = deferred();
  const f = await portalFixture(t, { idle: true, search: query => { lookups.push(query); if (lookups.length === 1) { firstStarted.resolve(); return first.promise; } return { loadType: 'track', tracks: [track('lmnopqrstuv')] }; } });
  await f.library.updateGuild('100', guild => { guild.settings.musicTextChannelId = '401'; });
  const adding = f.command({ command: 'play', options: { query: 'first song' } }); await firstStarted.promise;
  const second = f.command({ command: 'play', options: { query: 'second song' } }); await delay(30);
  assert.deepEqual(lookups, ['first song']);
  first.resolve({ loadType: 'track', tracks: [track()] });
  assert.equal((await adding).status, 200); assert.equal((await second).status, 200);
  assert.deepEqual(lookups, ['first song', 'second song']);
  const player = f.manager.getPlayer('100'); assert.equal(player.textChannelId, '401'); assert.equal(player.queue.tracks.length, 1);
  await f.library.updateGuild('100', guild => { guild.settings.musicTextChannelId = '400'; });
  assert.equal((await f.command({ command: 'play', options: { query: 'third song' } })).status, 200);
  assert.equal(player.textChannelId, '401');
});

test('library saves work outside voice, favorites remain private and activity records only successful queue/settings edits', async t => {
  const f = await portalFixture(t);
  f.members.get('200').voice.channel = null;
  const revision = (await f.request()).body.revision;
  assert.equal((await f.command({ command: 'favorite', subcommand: 'add', expectedRevision: revision })).status, 200);
  assert.equal(f.library.favorites('200').length, 1);
  assert.equal((await f.command({ command: 'mix', subcommand: 'save', options: { name: 'night mix' }, expectedRevision: revision })).status, 200);
  assert.equal(f.library.readGuild('100').activity.length, 0);
  const favoriteId = (await f.request('/library')).body.favorites[0].id;
  assert.equal((await f.command({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: favoriteId })).status, 200);
  assert.equal(f.library.favorites('200').length, 0);
  f.members.get('200').voice.channel = f.channels.get('300');
  const fresh = (await f.request()).body.revision;
  assert.equal((await f.command({ command: 'remove', options: { position: 99 }, expectedRevision: fresh })).status, 400);
  assert.equal((await f.command({ command: 'remove', options: { position: 1 }, expectedRevision: fresh })).status, 200);
  assert.equal((await f.command({ command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } }, { actor: '201' })).status, 200);
  const activity = (await f.request('/activity', { actor: '201' })).body.items;
  assert.equal(activity.length, 2); assert.deepEqual(activity.map(item => item.action), ['settings', 'queue']);
  assert.doesNotMatch(JSON.stringify(activity), /night mix|abcdefghijk|favorite/);
  assert.equal((await f.request('/activity')).status, 403);
  f.channels.get('401').botWritable = false;
  assert.equal((await f.command({ command: 'settings', subcommand: 'musicchannel', options: { channel: '401' } }, { actor: '201' })).status, 400);
});

test('saved restoration keeps original channels, paused position and history replays fresh public references', async t => {
  const f = await portalFixture(t, { idle: true });
  await f.library.updateGuild('100', guild => { guild.settings.musicTextChannelId = '401'; guild.session = { voiceChannelId: '300', textChannelId: '400', savedAt: Date.now(), position: 12_000, volume: 70, paused: true, repeatMode: 'queue', tracks: [trackReference(track()), trackReference(track('lmnopqrstuv'))] }; });
  const saved = (await f.request()).body;
  assert.equal(saved.savedSession.canResume, true);
  const resumed = await f.command({ command: 'session', subcommand: 'resume', expectedRevision: saved.revision });
  assert.equal(resumed.status, 200);
  const player = f.manager.getPlayer('100');
  assert.equal(player.voiceChannelId, '300'); assert.equal(player.textChannelId, '400'); assert.equal(player.paused, true); assert.equal(player.lastPosition, 12_000);
  const playCall = f.calls.find(item => Array.isArray(item) && item[0] === 'play'); assert.equal(playCall[1].paused, true); assert.equal(playCall[1].position, 12_000);
  await handleTrackStart(f.client, player, player.queue.current); await f.library.pending;
  const beforeReplay = (await f.request()).body;
  const historyId = (await f.request('/library')).body.history[0].id;
  const replayed = await f.command({ command: 'replay', options: { index: 1 }, expectedRevision: beforeReplay.revision, expectedHistoryId: historyId });
  assert.equal(replayed.status, 200); assert.equal(player.queue.tracks[0].info.identifier, 'abcdefghijk');
  assert.equal((await f.command({ command: 'stop' })).status, 200);
  assert.equal(f.library.readGuild('100').session, null);
});
