import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { portalFixture, deferred } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { trackReference } from '../src/utils/library.js';
import { execute as favorite } from '../src/commands/favorite.js';
import { execute as mix } from '../src/commands/mix.js';
import { execute as replay } from '../src/commands/replay.js';
import { openLibrary, closeLibraries } from './library-fixture.js';

const A = 'aaaaaaaaaaa', B = 'bbbbbbbbbbb', C = 'ccccccccccc';
const reference = id => trackReference(track(id));
const favoriteIds = f => f.library.favorites('200').map(item => item.identifier);
const favorites = f => f.request('/library').then(result => result.body.favorites);
const history = f => f.request('/library').then(result => result.body.history);
const mixes = f => f.request('/library').then(result => result.body.mixes);
async function seedFavorites(f) { await f.library.updateFavorites('200', list => list.push(reference(A), reference(B), reference(C))); }
async function seedHistory(f) {
  await f.library.updateGuild('100', guild => {
    guild.history = [
      { id: 'history-a', playedAt: Date.now(), voiceChannelId: '301', track: reference(A) },
      { id: 'history-b', playedAt: Date.now() - 1, voiceChannelId: '300', track: reference(B) },
    ];
  });
}
async function seedMix(f) {
  await f.library.updateGuild('100', guild => { guild.mixes.night = { ownerId: '200', tracks: [reference(A), reference(B)], savedAt: 12345 }; });
}
function secondGuild(f) {
  const channels = new Map([...f.channels].map(([id, channel]) => [id, { ...channel, guildId: '101' }]));
  const guild = { ...f.guild, id: '101', channels: { cache: channels, async fetch() { return channels; } } };
  f.client.guilds.cache.set('101', guild);
  f.client.guilds.fetch = async ({ guild }) => f.client.guilds.cache.get(guild);
  return body => f.request('/v1/guilds/101/commands', { body });
}

test('selection tokens are required, bounded and allowed only on their matching portal commands', async t => {
  const f = await portalFixture(t);
  const revision = (await f.request()).body.revision;
  const selections = [
    [{ command: 'favorite', subcommand: 'play', options: { index: 1 } }, 'expectedTrackId', 'a'.repeat(24)],
    [{ command: 'favorite', subcommand: 'remove', options: { index: 1 } }, 'expectedTrackId', 'a'.repeat(24)],
    [{ command: 'replay', expectedRevision: revision }, 'expectedHistoryId', 'history-a'],
    [{ command: 'mix', subcommand: 'delete', options: { name: 'night' } }, 'expectedMixVersion', 'a'.repeat(32)],
  ];
  for (const [command, key, valid] of selections) {
    const malformed = key === 'expectedHistoryId' ? ['x'.repeat(41), 'id\n', '\u007f'] : [valid.toUpperCase(), valid.slice(1), `${valid}a`];
    for (const value of [undefined, null, '', 123, {}, ...malformed]) {
      const result = await f.command({ ...command, [key]: value });
      assert.equal(result.status, 400, `${command.command}/${command.subcommand || ''} accepted ${key}=${JSON.stringify(value)}`);
    }
    assert.equal((await f.command({ command: 'pause', [key]: valid })).status, 400);
    for (const [other, otherKey] of selections) if (otherKey !== key) {
      assert.equal((await f.command({ ...other, [otherKey]: selections.find(item => item[1] === otherKey)[2], [key]: valid })).status, 400);
    }
  }
  for (const [command, key, token] of [
    [{ command: 'favorite', subcommand: 'list' }, 'expectedTrackId', 'a'.repeat(24)],
    [{ command: 'favorite', subcommand: 'add', expectedRevision: revision }, 'expectedTrackId', 'a'.repeat(24)],
    [{ command: 'mix', subcommand: 'save', options: { name: 'night' }, expectedRevision: revision }, 'expectedMixVersion', 'a'.repeat(32)],
    [{ command: 'mix', subcommand: 'load', options: { name: 'night' } }, 'expectedMixVersion', 'a'.repeat(32)],
  ]) assert.equal((await f.command({ ...command, [key]: token })).status, 400);
  assert.equal((await f.command({ command: 'favorite', subcommand: 'remove', options: { index: 1, expectedTrackId: 'a'.repeat(24) } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('stale global favorite actions reject another guild/device edit before arrival, despite unchanged guild revision', async t => {
  for (const action of ['remove', 'play']) await t.test(action, async t => {
    const f = await portalFixture(t); await seedFavorites(f);
    const otherDevice = secondGuild(f);
    const displayed = await favorites(f);
    const revision = (await f.request()).body.revision;
    assert.equal((await otherDevice({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: displayed[0].id })).status, 200);
    assert.equal((await f.request()).body.revision, revision);
    const stale = await f.command({ command: 'favorite', subcommand: action, options: { index: 2 }, expectedRevision: revision, expectedTrackId: displayed[1].id });
    assert.equal(stale.status, 409);
    assert.deepEqual(favoriteIds(f), [B, C]); assert.equal(f.calls.includes('add'), false);
    const fresh = await favorites(f);
    assert.equal((await f.command({ command: 'favorite', subcommand: action, options: { index: 1 }, expectedTrackId: fresh[0].id })).status, 200);
    if (action === 'play') assert.equal(f.player.queue.tracks.at(-1).info.identifier, B);
    else assert.deepEqual(favoriteIds(f), [C]);
  });
});

test('favorite removal retains its selected ID and URI while another guild deletion waits for the global writer', async t => {
  const f = await portalFixture(t); await seedFavorites(f);
  const otherDevice = secondGuild(f), displayed = await favorites(f);
  const entered = deferred(), release = deferred(), firstWrite = deferred(), secondWrite = deferred();
  const blocker = f.library.updateGuild('101', async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const original = f.library.updateFavorites.bind(f.library); let writes = 0;
  f.library.updateFavorites = (...args) => { (++writes === 1 ? firstWrite : secondWrite).resolve(); return original(...args); };
  const first = otherDevice({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: displayed[0].id });
  await firstWrite.promise;
  const stale = f.command({ command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: displayed[1].id });
  try { await secondWrite.promise; } finally { release.resolve(); }
  await blocker; assert.equal((await first).status, 200); assert.equal((await stale).status, 409);
  assert.deepEqual(favoriteIds(f), [B, C]);
  assert.deepEqual((await openLibrary(f.library.filePath)).favorites('200').map(item => item.identifier), [B, C]);
});

test('favorite play keeps the captured ID through slow resolution and rejects a shifted or removed selection before enqueue', async t => {
  for (const change of ['shift', 'remove']) await t.test(change, async t => {
    const entered = deferred(), release = deferred();
    const f = await portalFixture(t, { search: query => { assert.equal(query, reference(B).uri); entered.resolve(); return release.promise; } });
    await seedFavorites(f);
    const displayed = await favorites(f);
    const playing = f.command({ command: 'favorite', subcommand: 'play', options: { index: 2 }, expectedTrackId: displayed[1].id });
    try {
      await entered.promise;
      await f.library.updateFavorites('200', list => list.splice(change === 'shift' ? 0 : 1, 1));
    } finally { release.resolve({ loadType: 'track', tracks: [track(B)] }); }
    assert.equal((await playing).status, 409); assert.equal(f.calls.includes('add'), false);
    assert.equal(f.player.queue.tracks.length, 2); assert.equal(f.player.playing, true);
  });
});

test('hidden earlier history cannot silently retarget replay before arrival, with unchanged guild revision', async t => {
  const f = await portalFixture(t); await seedHistory(f);
  const displayed = await history(f), revision = (await f.request()).body.revision;
  f.channels.get('301').hidden.add('200');
  assert.equal((await f.request()).body.revision, revision);
  const stale = await f.command({ command: 'replay', options: { index: 1 }, expectedRevision: revision, expectedHistoryId: displayed[0].id });
  assert.equal(stale.status, 409); assert.equal(f.calls.includes('splice'), false);
  assert.doesNotMatch(JSON.stringify(stale.body), /history-a|aaaaaaaaaaa|Private voice/);
  const fresh = await history(f);
  assert.equal((await f.command({ command: 'replay', expectedRevision: revision, expectedHistoryId: fresh[0].id })).status, 200, 'optional index still defaults to newest visible entry');
  assert.equal(f.player.queue.tracks[0].info.identifier, B);
});

test('replay retains exact selected history through slow lookup, including preceding visibility changes and DJ loss', async t => {
  for (const change of ['selected hidden', 'preceding hidden', 'DJ lost']) await t.test(change, async t => {
    const entered = deferred(), release = deferred();
    const f = await portalFixture(t, { search: () => { entered.resolve(); return release.promise; } });
    await seedHistory(f);
    if (change === 'DJ lost') {
      await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
      f.members.get('200').roles.cache.set('500', f.roles.get('500'));
    }
    const displayed = await history(f), index = change === 'preceding hidden' ? 2 : 1;
    const revision = (await f.request()).body.revision;
    const replaying = f.command({ command: 'replay', options: { index }, expectedRevision: revision, expectedHistoryId: displayed[index - 1].id });
    try {
      await entered.promise;
      if (change === 'DJ lost') f.members.get('200').roles.cache.delete('500');
      else f.channels.get('301').hidden.add('200');
    } finally { release.resolve({ loadType: 'track', tracks: [track(index === 1 ? A : B)] }); }
    assert.equal((await replaying).status, change === 'DJ lost' ? 403 : 409);
    assert.equal(f.calls.includes('splice'), false); assert.equal(f.player.queue.tracks.length, 2);
  });
});

test('mix deletion rejects the version captured at confirmation even when supplied a newer snapshot revision', async t => {
  const f = await portalFixture(t); await seedMix(f);
  const selected = (await mixes(f))[0]; assert.match(selected.version, /^[a-f0-9]{32}$/);
  const oldRevision = (await f.request()).body.revision;
  f.player.queue.tracks.push(track(C));
  const replacementRevision = (await f.request()).body.revision;
  assert.equal((await f.command({ command: 'mix', subcommand: 'save', options: { name: 'night', replace: true }, expectedRevision: replacementRevision }, { actor: '201' })).status, 200);
  const newerRevision = (await f.request()).body.revision;
  assert.notEqual(newerRevision, oldRevision);
  const replacement = (await mixes(f))[0]; assert.equal(replacement.ownerId, selected.ownerId); assert.notEqual(replacement.version, selected.version);
  const stale = await f.command({ command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedRevision: newerRevision, expectedMixVersion: selected.version });
  assert.equal(stale.status, 409); assert.equal(f.library.readGuild('100').mixes.night.tracks.length, 4);
  const fresh = await f.command({ command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: replacement.version });
  assert.equal(fresh.status, 200); assert.equal(f.library.readGuild('100').mixes.night, undefined);
});

test('mix deletion repeats version and ownership checks after waiting for the durable global transaction', async t => {
  for (const change of ['replacement', 'owner']) await t.test(change, async t => {
    const f = await portalFixture(t); await seedMix(f);
    const selected = (await mixes(f))[0], entered = deferred(), release = deferred(), deleting = deferred();
    const blocker = f.library.updateGuild('100', async guild => {
      entered.resolve(); await release.promise;
      if (change === 'owner') guild.mixes.night.ownerId = '201';
      else guild.mixes.night = { ...guild.mixes.night, tracks: [reference(C)], savedAt: 12346 };
    });
    await entered.promise;
    const original = f.library.updateGuild.bind(f.library);
    f.library.updateGuild = (...args) => { deleting.resolve(); return original(...args); };
    const pending = f.command({ command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: selected.version });
    try { await deleting.promise; } finally { release.resolve(); }
    await blocker; assert.equal((await pending).status, change === 'owner' ? 403 : 409);
    const durable = (await openLibrary(f.library.filePath)).readGuild('100').mixes.night;
    assert.ok(durable); assert.equal(durable.ownerId, change === 'owner' ? '201' : '200');
    if (change === 'replacement') assert.equal(durable.tracks[0].identifier, C);
  });
});

test('durable draft checks cannot be satisfied by an older in-memory favorite or mix', async t => {
  const f = await portalFixture(t); await seedFavorites(f); await seedMix(f);
  const selectedTrack = (await favorites(f))[1], selectedMix = (await mixes(f))[0];
  const updateFavorites = f.library.updateFavorites.bind(f.library);
  f.library.updateFavorites = (user, mutate, options) => updateFavorites(user, list => { list.splice(0, 1); return mutate(list); }, options);
  assert.equal((await f.command({ command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: selectedTrack.id })).status, 409);
  assert.deepEqual(favoriteIds(f), [A, B, C], 'rejected transaction must not publish even its pre-callback draft edits');
  const updateGuild = f.library.updateGuild.bind(f.library);
  f.library.updateGuild = (id, mutate) => updateGuild(id, guild => { guild.mixes.night.savedAt++; return mutate(guild); });
  assert.equal((await f.command({ command: 'mix', subcommand: 'delete', options: { name: 'night' }, expectedMixVersion: selectedMix.version })).status, 409);
  assert.equal(f.library.readGuild('100').mixes.night.savedAt, 12345);
});

test('mix version projects stable persisted content without migration and ignores unrelated changes', async t => {
  const f = await portalFixture(t); await seedMix(f);
  const selected = (await mixes(f))[0];
  assert.equal(f.library.readGuild('100').mixes.night.version, undefined);
  const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'library.json'), 'utf8'));
  assert.equal(disk.guilds['100'].mixes.night.version, undefined);
  await f.library.updateFavorites('201', list => list.push(reference(C)));
  await f.library.updateGuild('100', guild => { guild.settings.volume = 30; });
  assert.equal((await mixes(f))[0].version, selected.version);
  const original = f.library.readGuild('100').mixes.night;
  await f.library.updateGuild('100', guild => {
    guild.mixes.night.tracks = guild.mixes.night.tracks.map(item => Object.fromEntries(Object.entries(item).reverse()));
  });
  assert.equal((await mixes(f))[0].version, selected.version, 'property order is not reference content');
  for (const change of ['owner', 'order', 'content', 'savedAt']) {
    await f.library.updateGuild('100', guild => {
      guild.mixes.night = structuredClone(original);
      if (change === 'owner') guild.mixes.night.ownerId = '201';
      if (change === 'order') guild.mixes.night.tracks.reverse();
      if (change === 'content') guild.mixes.night.tracks[0].title = 'Updated metadata';
      if (change === 'savedAt') guild.mixes.night.savedAt++;
    });
    assert.notEqual((await mixes(f))[0].version, selected.version, change);
  }
});

test('native favorite/mix/replay numeric and name interfaces still succeed without portal selection fields', async t => {
  const f = await portalFixture(t); await seedFavorites(f); await seedMix(f);
  const interaction = (command, subcommand, options = {}) => ({
    client: f.client, guildId: '100', guild: f.guild, user: f.users.get('200'), member: f.members.get('200'), commandName: command,
    options: { getSubcommand: () => subcommand, getInteger: key => options[key] ?? null, getString: key => options[key] ?? null },
    replies: [], async reply(payload) { this.replies.push(payload); }, async deferReply() { this.deferred = true; }, async editReply(payload) { this.replies.push(payload); },
  });
  const playing = interaction('favorite', 'play', { index: 2 }); await favorite(playing);
  assert.equal(f.player.queue.tracks.at(-1).info.identifier, B);
  const removing = interaction('favorite', 'remove', { index: 2 }); await favorite(removing);
  assert.deepEqual(favoriteIds(f), [A, C]);
  const deleting = interaction('mix', 'delete', { name: 'night' }); await mix(deleting);
  assert.equal(f.library.readGuild('100').mixes.night, undefined);
  f.player.queue.previous = [track(A), track(C)];
  await replay(interaction('replay', undefined)); assert.equal(f.player.queue.tracks[0].info.identifier, A);
  await replay(interaction('replay', undefined, { position: 2 })); assert.equal(f.player.queue.tracks[0].info.identifier, C);
});
