import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { trackReference } from '../src/utils/library.js';
import { importLink, planImport, resetImportPreviews, resolveImport } from '../src/utils/playlist-import.js';
import { handleMessageComponent } from '../src/utils/components.js';
import { execute as favorite } from '../src/commands/favorite.js';

const LIST = 'https://www.youtube.com/playlist?list=PLroadtrip';
const id = index => `song${String(index).padStart(7, '0')}`;
const songs = (count, start = 0) => Array.from({ length: count }, (_, index) => track(id(start + index)));
const playlist = (tracks, name = 'Road trip') => ({ loadType: 'playlist', playlist: { name }, tracks });
const preview = (command, link = LIST, options = {}) => ({ command, subcommand: 'import', options: { ...(command === 'mix' && { name: 'road trip' }), link, ...options } });

async function fixture(t, result = playlist(songs(3))) {
  resetImportPreviews();
  const f = await portalFixture(t, { search: () => result });
  return f;
}

test('import links accept public catalog hosts only', () => {
  assert.equal(importLink(LIST), LIST);
  assert.equal(importLink('https://music.youtube.com/playlist?list=PL1#top'), 'https://music.youtube.com/playlist?list=PL1');
  assert.ok(importLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
  assert.ok(importLink('https://soundcloud.com/artist/sets/tour'));
  for (const link of ['http://www.youtube.com/playlist?list=PL1', 'https://example.com/list', 'https://user:pw@youtube.com/playlist?list=PL1', 'https://youtube.com:8443/playlist', 'road trip songs']) {
    assert.equal(importLink(link), null, link);
  }
});

test('planning skips saved and repeated songs, then stops at the free space', () => {
  const references = [...songs(4), track(id(1))].map(trackReference);
  const plan = planImport([references[0]], references, 2);
  assert.deepEqual(plan.add.map(item => item.identifier), [id(1), id(2)]);
  assert.equal(plan.duplicates, 2);
  assert.equal(plan.overLimit, 1);
});

test('lookups keep at most 100 public references and count what could not be saved', async () => {
  const unsaved = { ...track('privatesong'), info: { ...track('privatesong').info, uri: 'https://cdn.example.com/signed?sig=secret' } };
  const big = await resolveImport({}, LIST, {}, { search: async () => playlist([unsaved, ...songs(120)]) });
  assert.equal(big.references.length, 99);
  assert.equal(big.unmatched, 1);
  assert.equal(big.capped, true);
  assert.equal(big.title, 'Road trip');
  assert.ok(big.references.every(reference => !('encoded' in reference) && !/token|sig=/.test(reference.uri)));
  const spotify = await resolveImport({}, 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', {}, { search: async () => ({
    ...playlist(songs(7), 'Mix'), spotifyImport: { unavailableCount: 2, remainingCount: 1, capped: false, partial: true } }) });
  assert.equal(spotify.references.length, 7); assert.equal(spotify.unmatched, 3); assert.equal(spotify.partial, true);
  assert.match((await resolveImport({}, LIST, {}, { search: async () => ({ loadType: 'empty', tracks: [] }) })).error, /No matches/);
});

test('favorite import previews counts, saves only on confirmation and stores public references', async t => {
  const f = await fixture(t, playlist([...songs(6), track(id(2))]));
  await f.library.updateFavorites('200', list => { list.push(...songs(996, 1000).map(trackReference), trackReference(track(id(0)))); });
  const shown = await f.command(preview('favorite'));
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  const { preview: counts } = shown.body;
  assert.deepEqual({ found: counts.found, toAdd: counts.toAdd, duplicates: counts.duplicates, overLimit: counts.overLimit, unmatched: counts.unmatched, limit: counts.limit },
    { found: 7, toAdd: 3, duplicates: 2, overLimit: 2, unmatched: 0, limit: 1000 });
  assert.match(counts.id, /^[a-f0-9]{32}$/);
  assert.deepEqual(counts.tracks.map(item => item.title), [`Song ${id(1)}`, `Song ${id(2)}`, `Song ${id(3)}`]);
  assert.equal(f.library.favorites('200').length, 997, 'a preview writes nothing');

  const saved = await f.command({ ...preview('favorite'), expectedImportId: counts.id });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.message, /Added 3 tracks to your favorites\. 2 tracks are already saved\. 2 tracks won’t fit: favorites hold 1,000 tracks\./);
  assert.equal(saved.body.preview, undefined);
  assert.equal(f.library.favorites('200').length, 1000);
  const file = await fs.readFile(path.join(f.dir, 'library.json'), 'utf8');
  assert.doesNotMatch(file, /encoded-|never-save|requester/);

  const replay = await f.command({ ...preview('favorite'), expectedImportId: counts.id });
  assert.match(replay.body.message, /expired or changed/, 'a preview saves once');
  assert.equal(f.library.favorites('200').length, 1000);
});

test('a preview belongs to the listener and link that made it', async t => {
  const f = await fixture(t);
  const { preview: counts } = (await f.command(preview('favorite'))).body;
  const other = await f.command({ ...preview('favorite'), expectedImportId: counts.id }, { actor: '201' });
  assert.match(other.body.message, /expired or changed/);
  const changed = await f.command({ ...preview('favorite', 'https://www.youtube.com/playlist?list=PLother'), expectedImportId: counts.id });
  assert.match(changed.body.message, /expired or changed/);
  assert.equal(f.library.favorites('200').length, 0);
  assert.equal(f.library.favorites('201').length, 0);
});

test('migrated favorite overflow leaves no room for imports', async t => {
  const f = await fixture(t);
  await f.library.updateDocument(draft => { draft.favoriteOverflow['200'] = [trackReference(track('overflowsng'))]; });
  const { preview: counts, message } = (await f.command(preview('favorite'))).body;
  assert.equal(counts.id, null); assert.equal(counts.toAdd, 0); assert.equal(counts.overLimit, 3);
  assert.match(message, /Nothing new to add/);
});

test('mix import creates or extends a mix within its 100-track limit', async t => {
  const f = await fixture(t, playlist(songs(30)));
  await f.library.updateGuild('100', guild => { guild.mixes['road trip'] = { ownerId: '200', tracks: songs(80, 500).map(trackReference), savedAt: 1 }; });
  const { preview: counts } = (await f.command(preview('mix'))).body;
  assert.equal(counts.target, 'mix'); assert.equal(counts.name, 'road trip');
  assert.equal(counts.toAdd, 20); assert.equal(counts.overLimit, 10); assert.equal(counts.limit, 100);
  const saved = await f.command({ ...preview('mix'), expectedImportId: counts.id });
  assert.match(saved.body.message, /Added 20 tracks to \*\*road trip\*\*\. 10 tracks won’t fit: a mix holds 100 tracks\./);
  const mix = f.library.readGuild('100').mixes['road trip'];
  assert.equal(mix.tracks.length, 100); assert.equal(mix.ownerId, '200'); assert.ok(mix.savedAt > 1);

  const fresh = (await f.command(preview('mix', LIST, { name: 'New Songs' }))).body.preview;
  await f.command({ ...preview('mix', LIST, { name: 'New Songs' }), expectedImportId: fresh.id });
  assert.equal(f.library.readGuild('100').mixes['new songs'].tracks.length, 30);
  assert.equal(f.library.readGuild('100').mixes['new songs'].ownerId, '200');
});

test('only a mix owner or server manager can import into it', async t => {
  const f = await fixture(t);
  await f.library.updateGuild('100', guild => { guild.mixes['road trip'] = { ownerId: '202', tracks: [trackReference(track('ownersong01'))], savedAt: 1 }; });
  const refused = await f.command(preview('mix'));
  assert.equal(refused.body.preview, undefined);
  assert.match(refused.body.message, /belongs to another listener/);
  const manager = (await f.command(preview('mix'), { actor: '201' })).body.preview;
  assert.equal(manager.toAdd, 3);
  // Losing Manage Server between preview and confirmation refuses the write.
  f.members.get('201').permissions = new PermissionsBitField([]);
  const denied = await f.command({ ...preview('mix'), expectedImportId: manager.id }, { actor: '201' });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(f.library.readGuild('100').mixes['road trip'].tracks.length, 1);
});

test('a new mix import respects the 25 mixes per server limit', async t => {
  const f = await fixture(t);
  await f.library.updateGuild('100', guild => { for (let index = 0; index < 25; index++) guild.mixes[`mix ${index}`] = { ownerId: '200', tracks: [trackReference(track())], savedAt: 1 }; });
  const full = await f.command(preview('mix'));
  assert.equal(full.body.preview, undefined);
  assert.match(full.body.message, /can save 25 mixes/);
  assert.equal((await f.command(preview('mix', LIST, { name: 'mix 3' }))).body.preview.toAdd, 3, 'an existing mix still has room');
});

test('import confirmations are only accepted for import commands', async t => {
  const f = await fixture(t);
  const token = 'a'.repeat(32);
  assert.equal((await f.command({ command: 'favorite', subcommand: 'list', expectedImportId: token })).status, 400);
  assert.equal((await f.command({ ...preview('favorite'), expectedImportId: 'not-a-token' })).status, 400);
  assert.equal((await f.command(preview('favorite', 'http://example.com/list'))).body.preview, undefined);
});

test('Discord previews with buttons, and only the confirm button saves', async t => {
  const f = await fixture(t);
  const replies = [];
  const base = { client: f.client, guildId: '100', user: { id: '200' }, member: f.members.get('200'), guild: f.guild,
    memberPermissions: new PermissionsBitField([]), isMessageComponent: () => false };
  const command = { ...base, deferred: false, replied: false,
    options: { getSubcommand: () => 'import', getString: () => LIST, getInteger: () => null, getBoolean: () => null },
    async deferReply() { this.deferred = true; }, async reply(payload) { replies.push(payload); }, async editReply(payload) { replies.push(payload); } };
  await favorite(command);
  const shown = replies.at(-1);
  assert.match(shown.embeds[0].data.description, /3 tracks found\. 3 tracks will be added to your favorites\./);
  const [confirm, cancel] = shown.components[0].components.map(button => button.data.custom_id);
  assert.match(confirm, /^import:v1:confirm:[a-f0-9]{32}$/);
  assert.equal(f.library.favorites('200').length, 0);

  const updates = [];
  const button = customId => ({ ...base, customId, isButton: () => true, isMessageComponent: () => true, async update(payload) { updates.push(payload); } });
  await handleMessageComponent({ ...button(confirm), user: { id: '201' } });
  assert.match(updates.at(-1).content, /expired or changed/);
  await handleMessageComponent(button(confirm));
  assert.match(updates.at(-1).content, /Added 3 tracks to your favorites\./);
  assert.deepEqual(updates.at(-1).components, []);
  assert.equal(f.library.favorites('200').length, 3);
  await handleMessageComponent(button(cancel));
  assert.match(updates.at(-1).content, /Import cancelled/);
});

test('Manage Server lets a Discord member import into another listener’s mix', async t => {
  const f = await fixture(t);
  await f.library.updateGuild('100', guild => { guild.mixes['road trip'] = { ownerId: '202', tracks: [trackReference(track('ownersong01'))], savedAt: 1 }; });
  const { execute: mix } = await import('../src/commands/mix.js');
  const replies = [];
  const interaction = permissions => ({ client: f.client, guildId: '100', user: { id: '200' }, guild: f.guild, memberPermissions: new PermissionsBitField(permissions),
    options: { getSubcommand: () => 'import', getString: key => key === 'name' ? 'road trip' : LIST },
    async deferReply() {}, async reply(payload) { replies.push(payload); }, async editReply(payload) { replies.push(payload); } });
  await mix(interaction([]));
  assert.match(replies.at(-1).content, /belongs to another listener/);
  await mix(interaction([P.ManageGuild]));
  assert.ok(replies.at(-1).components[0], 'a server manager gets a confirmable preview');
});
