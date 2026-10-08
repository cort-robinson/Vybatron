import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';
import { refreshSuggestions, suggestions } from '../src/utils/radio.js';

// The mix answers with three fresh related songs for whichever seed is asked.
const related = ['rel00000001', 'rel00000002', 'rel00000003', 'rel00000004'];
async function autoplayFixture(t) {
  const f = await portalFixture(t, { search: query => query.includes('list=RD')
    ? { loadType: 'playlist', tracks: related.map(id => ({ ...track(id), info: { ...track(id).info, author: `Artist ${id}`, title: `Song ${id}` } })) }
    : { loadType: 'search', tracks: [] } });
  f.client.user = { id: '999', username: 'Vybertron', bot: true, displayAvatarURL: () => null };
  return f;
}

test('server managers set the autoplay mode; snapshots project it and older settings read as off', async t => {
  const f = await autoplayFixture(t);
  assert.equal((await f.request('', { actor: '201' })).body.settings.autoplay, 'off');
  assert.equal((await f.command({ command: 'settings', subcommand: 'autoplay', options: { mode: 'listening' } }, { actor: '200' })).status, 403);
  assert.equal((await f.command({ command: 'settings', subcommand: 'autoplay', options: { mode: 'always' } }, { actor: '201' })).status, 400);
  assert.equal((await f.command({ command: 'settings', subcommand: 'autoplay', options: { mode: 'listening' } }, { actor: '201' })).status, 200);
  const listener = (await f.request()).body;
  assert.equal(listener.settings, null, 'only managers receive settings');
  assert.equal(listener.session.autoplay, 'listening');
  assert.equal(listener.session.radio, true);
});

test('suggestions are projected after the queue as bot-requested picks and never enter the live queue', async t => {
  const f = await autoplayFixture(t);
  await f.library.updateGuild('100', guild => { guild.settings.autoplay = 'on'; });
  const before = (await f.request()).body.revision;
  assert.equal(await refreshSuggestions(f.player, f.client), true);
  const { session, revision } = (await f.request()).body;
  assert.notEqual(revision, before, 'new suggestions change the revision so clients refresh');
  assert.equal(session.suggestions.length, 3);
  assert.ok(session.suggestions.every(item => item.suggested === true && item.requestedBy?.id === '999'));
  assert.ok(session.queue.every(item => item.suggested === false));
  assert.equal(session.current.suggested, false);
  assert.equal(f.player.queue.tracks.length, 2);
});

test('listeners may promote a suggestion; removing and disliking need control; stale tokens are rejected', async t => {
  const f = await autoplayFixture(t);
  await f.library.updateGuild('100', guild => { guild.settings.autoplay = 'on'; guild.settings.djRoleId = '500'; });
  await refreshSuggestions(f.player, f.client);
  const shown = (await f.request()).body.session.suggestions;
  assert.equal((await f.command({ command: 'radio', subcommand: 'promote', options: { position: 1 } })).status, 400, 'the selection token is required');
  assert.equal((await f.command({ command: 'radio', subcommand: 'promote', options: { position: 1 }, expectedTrackId: shown[1].id })).status, 409);
  assert.equal((await f.command({ command: 'radio', subcommand: 'remove', options: { position: 1 }, expectedTrackId: shown[0].id })).status, 403, 'removal is a DJ control');
  assert.equal(suggestions(f.player).length, 3);

  const promoted = await f.command({ command: 'radio', subcommand: 'promote', options: { position: 1 }, expectedTrackId: shown[0].id });
  assert.equal(promoted.status, 200);
  const added = f.player.queue.tracks.at(-1);
  assert.equal(added.info.title, shown[0].title);
  assert.equal(added.requester.id, '999', 'a promoted pick stays bot-requested, so play stats still count it as autoplay');
  assert.equal(promoted.body.snapshot.session.queue.at(-1).suggested, true);

  const remaining = (await f.request('', { actor: '201' })).body.session.suggestions;
  assert.equal((await f.command({ command: 'radio', subcommand: 'less', options: { position: 1 }, expectedTrackId: remaining[0].id }, { actor: '201' })).status, 200);
  assert.ok(!suggestions(f.player).some(item => item.info.title === remaining[0].title));
});
