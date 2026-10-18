import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { LIBRARY_LIMITS, trackReference } from '../src/utils/library.js';
import { collectionPayload } from '../src/utils/library-actions.js';
import { friendlyInteractionError } from '../src/commands/index.js';
import { execute as favorite } from '../src/commands/favorite.js';
import { execute as mix } from '../src/commands/mix.js';

const slash = (f, command, action, values = {}, userId = '200') => ({
  client: f.client, guildId: '100', channelId: '400', guild: f.guild, user: f.users.get(userId), member: f.members.get(userId), commandName: command,
  options: { getSubcommand: () => action, getInteger: key => values[key] ?? null, getString: key => values[key] ?? null, getBoolean: key => values[key] ?? null },
  isMessageComponent: () => false, replies: [], deferred: false, replied: false,
  async reply(payload) { this.replied = true; this.replies.push(payload); },
  async deferReply() { this.deferred = true; }, async editReply(payload) { this.replies.push(payload); },
});
const lastText = interaction => { const payload = interaction.replies.at(-1); return payload.content ?? JSON.stringify(payload); };
const refs = (prefix, count) => Array.from({ length: count }, (_, i) => trackReference(track(`${prefix}${String(i).padStart(11 - prefix.length, '0')}`)));

test('favorite add saves the current song once and tells the listener when it is already saved', async t => {
  const f = await portalFixture(t);
  const first = slash(f, 'favorite', 'add'); await favorite(first);
  assert.match(lastText(first), /Saved \*\*Song abcdefghijk\*\* to your favorites/);
  const again = slash(f, 'favorite', 'add'); await favorite(again);
  assert.match(lastText(again), /already in your favorites/);
  assert.deepEqual(f.library.favorites('200').map(item => item.identifier), ['abcdefghijk']);
});

test('favorite add refuses a 1,001st favorite, and refuses while migrated overflow waits for space', async t => {
  const f = await portalFixture(t);
  await f.library.updateDocument(document => { document.favorites['200'] = refs('full', LIBRARY_LIMITS.favorites); });
  const error = await favorite(slash(f, 'favorite', 'add')).then(() => null, caught => caught);
  assert.match(error?.message, /favorites hold at most 1000 tracks\. Remove one first/);
  assert.equal(friendlyInteractionError(error, '/favorite add'), error.message, 'the limit reaches the listener as written');
  assert.equal(f.library.favorites('200').length, LIBRARY_LIMITS.favorites);

  // Migrated overflow is promoted as space opens, so a new save must not take that space.
  await f.library.updateDocument(document => { document.favorites['200'] = refs('kept', 10); document.favoriteOverflow['200'] = refs('over', 1); });
  await assert.rejects(favorite(slash(f, 'favorite', 'add')), /Remove one first/);
  assert.equal(f.library.favorites('200').length, 10);
  assert.ok(!f.library.favorites('200').some(item => item.identifier === 'abcdefghijk'));
});

test('favorite clear needs confirmation, then removes saved and overflow favorites', async t => {
  const f = await portalFixture(t);
  await f.library.updateDocument(document => { document.favorites['200'] = refs('kept', 3); document.favoriteOverflow['200'] = refs('over', 2); document.favorites['201'] = refs('other', 1); });
  const unconfirmed = slash(f, 'favorite', 'clear'); await favorite(unconfirmed);
  assert.match(lastText(unconfirmed), /still saved/);
  assert.equal(f.library.favorites('200').length, 3);
  await favorite(slash(f, 'favorite', 'clear', { confirm: true }));
  assert.equal(f.library.favorites('200').length, 0); assert.equal(f.library.favoriteOverflowCount('200'), 0);
  assert.equal(f.library.favorites('201').length, 1, 'another listener’s favorites are untouched');
});

test('mix names are normalized, and invalid names reach the listener as the naming rule', async t => {
  const f = await portalFixture(t);
  await mix(slash(f, 'mix', 'save', { name: '  Late   NIGHT_drive-2 ' }));
  assert.deepEqual(Object.keys(f.library.readGuild('100').mixes), ['late night_drive-2']);
  const load = slash(f, 'mix', 'load', { name: 'LATE NIGHT_DRIVE-2' }); await mix(load);
  assert.match(lastText(load), /from \*\*late night\\_drive-2\*\*/);

  for (const name of ['', '   ', '-leading', 'emoji 🎵', 'semi;colon', 'x'.repeat(41)]) {
    const error = await mix(slash(f, 'mix', 'save', { name })).then(() => null, caught => caught);
    assert.ok(error, `${JSON.stringify(name)} is rejected`);
    assert.equal(friendlyInteractionError(error, '/mix save'), 'Name your mix with 1–40 letters, numbers, spaces, hyphens or underscores.');
  }
  assert.equal(Object.keys(f.library.readGuild('100').mixes).length, 1);
});

test('only the mix owner or a server manager can delete a mix', async t => {
  const f = await portalFixture(t);
  await f.library.updateGuild('100', guild => {
    for (const name of ['owned', 'managed']) guild.mixes[name] = { ownerId: '202', tracks: [trackReference(track())], savedAt: 1 };
  });
  const stranger = slash(f, 'mix', 'delete', { name: 'owned' }, '200'); await mix(stranger);
  assert.match(lastText(stranger), /Only the mix owner or a server manager/);
  assert.ok(f.library.readGuild('100').mixes.owned);
  await mix(slash(f, 'mix', 'delete', { name: 'owned' }, '202'));
  await mix(slash(f, 'mix', 'delete', { name: 'managed' }, '201'));
  assert.deepEqual(f.library.readGuild('100').mixes, {});
  const missing = slash(f, 'mix', 'delete', { name: 'owned' }); await mix(missing);
  assert.match(lastText(missing), /does not exist/);
});

test('loading a mix queues what is still available and names how many were left out', async t => {
  const f = await portalFixture(t, { search: query => /gone/.test(query) ? { loadType: 'empty', tracks: [] } : { loadType: 'track', tracks: [track(new URL(query).searchParams.get('v'))] } });
  await f.library.updateGuild('100', guild => { guild.mixes.partial = { ownerId: '200', tracks: [...refs('keep', 2), ...refs('gone', 1)], savedAt: 1 }; });
  const before = f.player.queue.tracks.length;
  const load = slash(f, 'mix', 'load', { name: 'partial' }); await mix(load);
  assert.match(lastText(load), /Added 2 tracks from \*\*partial\*\*\. 1 unavailable tracks were left out\./);
  assert.deepEqual(f.player.queue.tracks.slice(before).map(item => item.info.identifier), ['keep0000000', 'keep0000001']);
});

test('a mix with nothing available leaves no new player behind', async t => {
  const f = await portalFixture(t, { idle: true, search: () => ({ loadType: 'empty', tracks: [] }) });
  await f.library.updateGuild('100', guild => { guild.mixes.gone = { ownerId: '200', tracks: refs('gone', 2), savedAt: 1 }; });
  const load = slash(f, 'mix', 'load', { name: 'gone' }); await mix(load);
  assert.match(lastText(load), /currently unavailable/);
  assert.equal(f.manager.getPlayer('100'), undefined);
  assert.ok(f.calls.includes('destroy'));
});

test('collection pages show ten tracks with absolute numbers and clamp out-of-range pages', () => {
  const tracks = Array.from({ length: 23 }, (_, i) => ({ title: `Title ${i + 1}`, author: 'Artist' }));
  const page = (number, footer) => collectionPayload('Shelf', tracks, number, footer).embeds[0].toJSON();
  const last = page(3, 'Only you');
  assert.deepEqual(last.description.split('\n'), ['**21.** Title 21 — Artist', '**22.** Title 22 — Artist', '**23.** Title 23 — Artist']);
  assert.equal(last.footer.text, 'Page 3/3 · 23 tracks · Only you');
  assert.equal(page(99).footer.text, 'Page 3/3 · 23 tracks');
  assert.match(page(0).description, /^\*\*1\.\*\* Title 1/);
  const empty = collectionPayload('Shelf', []).embeds[0].toJSON();
  assert.match(empty.description, /Nothing saved yet/); assert.equal(empty.footer.text, 'Page 1/1 · 0 tracks');
});
