import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayStats } from '../src/utils/play-stats.js';
import { trackReference, LIBRARY_LIMITS } from '../src/utils/library.js';
import { handleMessageComponent, handleModalSubmit } from '../src/utils/components.js';
import { buildStopConfirmationPayload, SESSION_MIX_MODAL_ID } from '../src/utils/messages.js';
import { execute as mix } from '../src/commands/mix.js';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';

const DAY = 24 * 60 * 60_000;
const id = (prefix, index) => `${prefix}${String(index).padStart(11 - prefix.length, '0')}`;
const artistTrack = (identifier, author, requesterId = '200') => {
  const value = track(identifier, requesterId);
  value.info.author = author;
  return value;
};

async function withStats(t, options) {
  const f = await portalFixture(t, options);
  const stats = await new PlayStats(':memory:', { logger: { error() {} } }).open();
  f.client.stats = stats;
  t.after(() => stats.close());
  const record = (value, { voiceChannelId = '300', requesterId = '200', playedAt = Date.now() - 1000 } = {}) => {
    const handle = stats.begin({ guildId: '100', voiceChannelId, track: value, requesterKind: 'user', requesterId, playedAt });
    stats.finish(handle, { playedMs: 180_000, completed: true });
  };
  return { ...f, stats, record };
}

const titles = list => list.map(item => item.title);

test('the stats DTO carries personal playlists built from visible plays, without other listeners', async t => {
  const f = await withStats(t);
  for (const index of [1, 2, 3]) { f.record(artistTrack(id('nova', index), 'Nova')); f.record(artistTrack(id('nova', index), 'Nova')); }
  f.record(artistTrack(id('echo', 1), 'Echo'));
  f.record(artistTrack(id('secret', 1), 'Secret'), { voiceChannelId: '301' });
  f.record(artistTrack(id('friend', 1), 'Nova', '201'), { requesterId: '201' });
  await f.library.updateFavorites('200', list => { list.push(trackReference(artistTrack(id('fav', 1), 'Calm'))); });
  f.channels.get('301').hidden.add('200');

  const response = await f.request('/stats?window=30d');
  assert.equal(response.status, 200);
  const playlists = response.body.personal.playlists;
  assert.deepEqual(playlists.map(list => list.id), ['your-mix', 'top-tracks', 'rediscover', 'artist-1', 'artist-2']);
  for (const list of playlists) {
    assert.deepEqual(Object.keys(list).sort(), ['artist', 'id', 'kind', 'refreshesAt', 'title', 'tracks']);
    assert.ok(list.tracks.length <= 25);
    assert.ok(list.tracks.every(item => item.requestedBy === null && /^[a-f0-9]{24}$/.test(item.id)));
  }
  const body = JSON.stringify(playlists);
  assert.doesNotMatch(body, /secret|"201"|encoded|token/i);
  const [yourMix, top, rediscover, nova, echo] = playlists;
  assert.equal(yourMix.title, 'Your mix');
  assert.ok(yourMix.refreshesAt > Date.now() && yourMix.refreshesAt - Date.now() <= 7 * DAY);
  assert.deepEqual(titles(top.tracks).slice(0, 3).sort(), ['Song nova0000001', 'Song nova0000002', 'Song nova0000003'], 'requested twice, so first');
  assert.equal(titles(top.tracks)[3], 'Song echo0000001');
  assert.equal(top.tracks.length, 4);
  assert.deepEqual(titles(rediscover.tracks), ['Song fav00000001']);
  assert.deepEqual([nova.artist, nova.title, echo.artist], ['Nova', 'Nova mix', 'Echo']);
  assert.ok(titles(nova.tracks).includes('Song friend00001'), 'server plays by the artist feed the mix anonymously');

  // A listener who left the server gets nothing from it.
  f.members.delete('200');
  assert.equal((await f.request('/stats')).status, 404);
});

test('/mymix play queues a personal playlist through the normal enqueue path, with voice and queue limits', async t => {
  const f = await withStats(t);
  for (const index of [1, 2]) f.record(artistTrack(id('nova', index), 'Nova'));
  f.record(artistTrack(id('echo', 1), 'Echo'));
  const before = f.player.queue.tracks.length;

  const top = await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'top', window: '7d' } });
  assert.equal(top.status, 200, JSON.stringify(top.body));
  const added = f.player.queue.tracks.slice(before);
  assert.equal(added.length, 3);
  assert.ok(added.every(item => item.requester?.id === '200'), 'queued as the person who pressed Play');

  const artist = await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'artist', artist: 'nova', shuffle: true } });
  assert.equal(artist.status, 200);
  assert.deepEqual(f.player.queue.tracks.slice(before + 3).map(item => item.info.identifier).sort(), [id('nova', 1), id('nova', 2)]);

  const rediscover = await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'rediscover' } });
  assert.equal(rediscover.status, 200);
  assert.match(rediscover.body.message, /Nothing to rediscover yet/);
  const unknown = await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'artist', artist: 'Nobody' } });
  assert.match(unknown.body.message, /No artist mix yet/);
  assert.equal(f.player.queue.tracks.length, before + 5);

  const shown = await f.command({ command: 'mymix', subcommand: 'show', options: { playlist: 'top' } });
  assert.equal(shown.status, 200);
  assert.equal(shown.body.message, 'Request completed.', 'read-only replies stay neutral');

  f.members.get('200').voice.channel = null;
  const outside = await f.command({ command: 'mymix', subcommand: 'play', options: {} });
  assert.equal(outside.status, 403);
  f.members.get('200').voice.channel = f.channels.get('300');
  while (f.player.queue.tracks.length < LIBRARY_LIMITS.queue) f.player.queue.tracks.push(track('filler00000'));
  const full = await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'top' } });
  assert.equal(full.status, 400);
  assert.equal(f.player.queue.tracks.length, LIBRARY_LIMITS.queue);

  assert.equal((await f.command({ command: 'mymix', subcommand: 'play', options: { playlist: 'everything' } })).status, 400);
  assert.equal((await f.command({ command: 'mymix', subcommand: 'play', options: { window: '2d' } })).status, 400);
  f.stats.disable();
  const unavailable = await f.command({ command: 'mymix', subcommand: 'play', options: {} });
  assert.match(unavailable.body.message, /unavailable right now/);
});

test('saving a session as a mix keeps played songs first and respects the 100-track limit', async t => {
  const f = await withStats(t);
  // queue.previous is most recent first.
  f.player.queue.previous.push(track('played00002'), track('played00001'), track('lmnopqrstuv'));
  const revision = (await f.request()).body.revision;
  const saved = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'friday', session: true }, expectedRevision: revision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.match(saved.body.message, /2 of them already played this session/);
  assert.deepEqual(f.library.readGuild('100').mixes.friday.tracks.map(item => item.identifier),
    ['played00001', 'played00002', 'abcdefghijk', 'lmnopqrstuv', '01234567890'], 'oldest played first; a song still queued is not repeated');

  const plain = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'queue only' }, expectedRevision: saved.body.snapshot.revision });
  assert.equal(plain.status, 200);
  assert.equal(f.library.readGuild('100').mixes['queue only'].tracks.length, 3, 'without session only the current song and queue');

  // 97 upcoming + current leaves room for the two most recent played songs.
  f.player.queue.tracks.length = 0;
  for (let index = 0; index < 97; index++) f.player.queue.tracks.push(track(id('queued', index)));
  f.player.queue.previous.unshift(track('played00004'), track('played00003'));
  let current = (await f.request()).body.revision;
  const trimmed = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'long night', session: true }, expectedRevision: current });
  assert.equal(trimmed.status, 200, JSON.stringify(trimmed.body));
  const tracks = f.library.readGuild('100').mixes['long night'].tracks;
  assert.equal(tracks.length, LIBRARY_LIMITS.mixTracks);
  assert.deepEqual(tracks.slice(0, 2).map(item => item.identifier), ['played00003', 'played00004'], 'the oldest played songs are left out');

  f.player.queue.tracks.push(track('overflow001'), track('overflow002'), track('overflow003'));
  current = (await f.request()).body.revision;
  const tooLong = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'too long', session: true }, expectedRevision: current });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'mix_limit');
});

test('session mixes follow the shared mix owner and server limits', async t => {
  const f = await withStats(t);
  f.player.queue.previous.push(track('played00001'));
  let revision = (await f.request()).body.revision;
  assert.equal((await f.command({ command: 'mix', subcommand: 'save', options: { name: 'mine', session: true }, expectedRevision: revision }, { actor: '202' })).status, 200);
  revision = (await f.request()).body.revision;
  const taken = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'mine', session: true, replace: true }, expectedRevision: revision });
  assert.equal(taken.status, 403);
  assert.equal(taken.body.error.code, 'mix_owner_required');
  const exists = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'mine', session: true }, expectedRevision: revision }, { actor: '202' });
  assert.equal(exists.status, 409);
  const manager = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'mine', session: true, replace: true }, expectedRevision: revision }, { actor: '201' });
  assert.equal(manager.status, 200, 'a server manager may replace it');
  assert.equal(f.library.readGuild('100').mixes.mine.ownerId, '202', 'replacing keeps the original owner');

  await f.library.updateGuild('100', guild => {
    for (let index = Object.keys(guild.mixes).length; index < LIBRARY_LIMITS.mixes; index++) guild.mixes[`mix ${index}`] = { ownerId: '202', tracks: [trackReference(track())], savedAt: 1 };
  });
  revision = (await f.request()).body.revision;
  const full = await f.command({ command: 'mix', subcommand: 'save', options: { name: 'one more', session: true }, expectedRevision: revision });
  assert.notEqual(full.status, 200);
  assert.equal(Object.keys(f.library.readGuild('100').mixes).length, LIBRARY_LIMITS.mixes);
});

test('the Discord Stop confirmation offers Save as mix, which saves the session without stopping it', async t => {
  const f = await withStats(t);
  const ids = buildStopConfirmationPayload().components[0].components.map(button => button.data.custom_id);
  assert.deepEqual(ids, ['player:v1:stop-confirm', 'player:v1:stop-save', 'player:v1:stop-cancel']);

  const calls = [];
  const base = { client: f.client, guildId: '100', guild: f.guild, user: f.users.get('200'), member: f.members.get('200'), replied: false, deferred: false,
    message: { flags: { has: () => true } }, async reply(payload) { this.replied = true; calls.push(['reply', payload]); } };
  await handleMessageComponent({ ...base, customId: 'player:v1:stop-save', isButton: () => true, isMessageComponent: () => true,
    async showModal(modal) { calls.push(['showModal', modal.toJSON()]); } });
  assert.equal(calls[0][0], 'showModal');
  assert.equal(calls[0][1].custom_id, SESSION_MIX_MODAL_ID);

  f.player.queue.previous.push(track('played00001'));
  await handleModalSubmit({ ...base, customId: SESSION_MIX_MODAL_ID, isMessageComponent: () => false, isModalSubmit: () => true,
    fields: { getTextInputValue: () => 'Last Night' } });
  const reply = calls.at(-1)[1];
  assert.match(reply.content, /Saved \*\*last night\*\* with 4 tracks\. 1 of them already played/);
  assert.equal(f.library.readGuild('100').mixes['last night'].tracks[0].identifier, 'played00001');
  assert.ok(f.manager.getPlayer('100'), 'saving never stops playback');
  assert.equal(f.calls.includes('destroy'), false);
});

test('/mix save session:true is available as a slash option', async t => {
  const f = await withStats(t);
  f.player.queue.previous.push(track('played00001'));
  const replies = [];
  await mix({ client: f.client, guildId: '100', guild: f.guild, user: f.users.get('200'), member: f.members.get('200'), commandName: 'mix',
    options: { getSubcommand: () => 'save', getString: () => 'slash session', getBoolean: key => key === 'session' ? true : null, getInteger: () => null },
    isMessageComponent: () => false, async reply(payload) { replies.push(payload); } });
  assert.match(replies[0].content, /with 4 tracks/);
});
