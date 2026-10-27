import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayStats } from '../src/utils/play-stats.js';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';

const DAY = 24 * 60 * 60_000;

async function withStats(t, options) {
  const f = await portalFixture(t, options);
  const stats = await new PlayStats(':memory:', { logger: { error() {} } }).open();
  f.client.stats = stats;
  t.after(() => stats.close());
  const record = (id, { voiceChannelId = '300', requesterId = '201', playedAt = Date.now() - 1000, ...end } = {}) => {
    const handle = stats.begin({ guildId: '100', voiceChannelId, track: track(id, requesterId), requesterKind: 'user', requesterId, playedAt });
    stats.finish(handle, { playedMs: 180_000, completed: true, ...end });
  };
  return { ...f, stats, record };
}

const titles = list => list.map(entry => entry.track.title);

test('server favorites only reflect plays in voice channels the viewer can currently see', async t => {
  const f = await withStats(t);
  for (const requesterId of ['200', '201']) f.record('publicsong1', { requesterId });
  for (const requesterId of ['200', '201', '202']) f.record('secretsong1', { requesterId, voiceChannelId: '301' });
  const open = await f.request('/stats');
  assert.equal(open.status, 200);
  assert.deepEqual(titles(open.body.serverFavorites.onRepeat), ['Song secretsong1', 'Song publicsong1']);
  assert.deepEqual(open.body.serverFavorites.onRepeat.map(entry => entry.plays), [3, 2]);

  f.channels.get('301').hidden.add('200');
  const hidden = await f.request('/stats');
  assert.deepEqual(titles(hidden.body.serverFavorites.onRepeat), ['Song publicsong1']);
  assert.deepEqual(titles(hidden.body.personal.topTracks), ['Song publicsong1'], 'personal stats use the same visibility rule');
  // Another listener still sees both rooms.
  assert.deepEqual(titles((await f.request('/stats', { actor: '201' })).body.serverFavorites.onRepeat), ['Song secretsong1', 'Song publicsong1']);
});

test('stats projections expose catalog tracks and counts, never other listeners', async t => {
  const f = await withStats(t);
  f.record('publicsong1', { requesterId: '201' });
  f.record('publicsong1', { requesterId: '202' });
  f.record('mysongsong1', { requesterId: '200' });
  f.record('mysongsong1', { requesterId: '200', playedAt: Date.now() - 45 * DAY });
  await f.library.updateFavorites('200', list => { list.push({ uri: 'https://www.youtube.com/watch?v=favoritesng', sourceName: 'youtube', identifier: 'favoritesng', title: 'Old love', author: 'Artist', duration: 1000, isStream: false }); });
  const response = await f.request('/stats?window=30d');
  assert.equal(response.status, 200);
  const body = JSON.stringify(response.body);
  assert.doesNotMatch(body, /"20[12]"|requester|never-save|encoded/);
  assert.equal(response.body.serverFavorites.onRepeat[0].track.requestedBy, null);
  assert.deepEqual(response.body.personal.topTracks.map(entry => [entry.track.title, entry.plays]), [['Song mysongsong1', 1]]);
  assert.deepEqual((await f.request('/stats?window=all')).body.personal.topTracks.map(entry => entry.plays), [2]);
  assert.deepEqual(response.body.personal.topArtists.map(artist => [artist.name, artist.plays]), [['Artist', 1]]);
  const [rediscover] = response.body.personal.rediscover;
  assert.deepEqual([rediscover.index, rediscover.track.title, rediscover.requests, rediscover.lastRequestedAt], [1, 'Old love', 0, null]);
  const library = await f.request('/library');
  assert.equal(rediscover.track.id, library.body.favorites[0].id, 'rediscover entries carry the favorite selection token');
  assert.equal((await f.request('/stats?window=forever')).status, 400);
});

test('stats are unavailable without breaking the portal', async t => {
  const f = await withStats(t);
  f.stats.disable();
  const response = await f.request('/stats');
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'stats_unavailable');
  assert.equal((await f.request('')).status, 200, 'the session snapshot still works');
  assert.equal((await f.request('/library')).status, 200);
  assert.equal((await f.command({ command: 'top', subcommand: 'play', options: {} })).status, 200, 'the command answers with a safe message');
  assert.equal(f.calls.includes('add'), false);
});

test('clearing request stats is identity-scoped and keeps server totals', async t => {
  const f = await withStats(t);
  f.record('mysongsong1', { requesterId: '200' });
  f.record('mysongsong1', { requesterId: '201' });
  const cleared = await f.request('/v1/stats/requests/clear?actorId=200', { method: 'POST' });
  assert.deepEqual(cleared, { status: 200, body: { ok: true, cleared: 1 } });
  const after = await f.request('/stats');
  assert.deepEqual(after.body.personal.topTracks, []);
  assert.equal(after.body.serverFavorites.onRepeat[0].plays, 2);
  assert.equal((await f.request('/v1/stats/requests/clear?actorId=999999', { method: 'POST' })).status, 403, 'unknown or bot accounts are rejected');
  assert.equal((await f.request('/v1/stats/requests/clear?actorId=200')).status, 404, 'GET is not a clear');
});

test('the recap reads one window under the stats privacy rules', async t => {
  const f = await withStats(t);
  f.record('mysongsong1', { requesterId: '200' });
  f.record('mysongsong1', { requesterId: '200', playedAt: Date.now() - 20 * DAY });
  f.record('mysongsong1', { requesterId: '200', skipped: true, completed: false, playedMs: 4_000 });
  f.record('publicsong1', { requesterId: '201' });
  f.record('secretsong1', { requesterId: '200', voiceChannelId: '301' });
  f.record('secretsong1', { requesterId: '202', voiceChannelId: '301' });
  f.channels.get('301').hidden.add('200');
  const week = await f.request('/recap?window=7d');
  assert.equal(week.status, 200, JSON.stringify(week.body));
  assert.equal(week.body.window, '7d');
  assert.ok(Math.abs(week.body.since - (Date.now() - 7 * DAY)) < 60_000);
  assert.deepEqual([week.body.personal.plays, week.body.personal.playedMs, week.body.personal.songs], [2, 184_000, 1]);
  assert.deepEqual(week.body.personal.topTracks.map(entry => [entry.track.title, entry.plays]), [['Song mysongsong1', 1]]);
  assert.deepEqual(week.body.personal.topArtists.map(artist => [artist.name, artist.plays]), [['Artist', 1]]);
  assert.deepEqual([week.body.server.plays, week.body.server.songs], [3, 2], 'the hidden room adds nothing, even the viewer’s own requests there');
  assert.deepEqual(week.body.server.topTracks.map(entry => entry.track.title).sort(), ['Song mysongsong1', 'Song publicsong1']);
  assert.ok(week.body.server.topTracks.every(entry => entry.track.requestedBy === null));
  assert.doesNotMatch(JSON.stringify(week.body), /"20[12]"|requester|encoded/);
  const month = await f.request('/recap');
  assert.equal(month.body.window, '30d', 'the window defaults to 30 days');
  assert.equal(month.body.personal.plays, 3);
  // Another listener sees the room the first cannot, and only their own requests.
  const other = (await f.request('/recap', { actor: '202' })).body;
  assert.deepEqual([other.personal.plays, other.server.plays], [1, 6]);
  for (const window of ['all', 'forever']) assert.equal((await f.request(`/recap?window=${window}`)).status, 400, window);

  await f.request('/v1/stats/requests/clear?actorId=200', { method: 'POST' });
  const cleared = (await f.request('/recap')).body;
  assert.deepEqual([cleared.personal.plays, cleared.personal.topTracks.length, cleared.server.plays], [0, 0, 4]);
  f.stats.disable();
  const unavailable = await f.request('/recap');
  assert.deepEqual([unavailable.status, unavailable.body.error.code], [503, 'stats_unavailable']);
});

test('/top play queues a visible server favorites list through the normal enqueue path', async t => {
  const f = await withStats(t);
  for (const requesterId of ['200', '201', '202']) f.record('loudsong001', { requesterId });
  for (const requesterId of ['200', '201']) f.record('quietsong01', { requesterId });
  for (const requesterId of ['200', '201', '202']) f.record('secretsong1', { requesterId, voiceChannelId: '301' });
  f.channels.get('301').hidden.add('200');
  const before = f.player.queue.tracks.length;
  const result = await f.command({ command: 'top', subcommand: 'play', options: { list: 'on-repeat' } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const added = f.player.queue.tracks.slice(before).map(item => item.info.identifier);
  assert.deepEqual(added, ['loudsong001', 'quietsong01']);
  assert.ok(added.every(id => id !== 'secretsong1'));
  assert.ok(f.player.queue.tracks.slice(before).every(item => item.requester?.id === '200'), 'queued as the person who pressed Play all');

  const shuffled = await f.command({ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle: true } });
  assert.equal(shuffled.status, 200);
  assert.equal(f.player.queue.tracks.length, before + 4);

  const gems = await f.command({ command: 'top', subcommand: 'play', options: { list: 'forgotten-gems' } });
  assert.equal(gems.status, 200);
  assert.match(gems.body.message, /No forgotten gems yet/);
  assert.equal(f.player.queue.tracks.length, before + 4);
});

test('/top play follows voice rules and the queue limit', async t => {
  const f = await withStats(t);
  f.record('loudsong001', { requesterId: '201' });
  f.members.get('200').voice.channel = null;
  const outside = await f.command({ command: 'top', subcommand: 'play', options: {} });
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error.code, 'wrong_voice');
  f.members.get('200').voice.channel = f.channels.get('300');
  while (f.player.queue.tracks.length < 500) f.player.queue.tracks.push(track('filler00000'));
  const full = await f.command({ command: 'top', subcommand: 'play', options: {} });
  assert.equal(full.status, 400);
  assert.equal(f.player.queue.tracks.length, 500);
});

test('the autoplay taste preference is identity-scoped, on by default and shown in bootstrap', async t => {
  const f = await withStats(t);
  assert.equal((await f.request('/v1/bootstrap?actorId=200')).body.viewer.autoplayTaste, true);
  const off = await f.request('/v1/preferences/autoplay-taste/off?actorId=200', { method: 'POST' });
  assert.deepEqual(off, { status: 200, body: { ok: true, enabled: false } });
  assert.equal(f.library.tasteInAutoplay('200'), false);
  assert.equal(f.library.tasteInAutoplay('201'), true, 'another listener is unaffected');
  assert.equal((await f.request('/v1/bootstrap?actorId=200')).body.viewer.autoplayTaste, false);
  assert.equal((await f.request('/v1/preferences/autoplay-taste/maybe?actorId=200', { method: 'POST' })).status, 404);
  assert.equal((await f.request('/v1/preferences/autoplay-taste/on?actorId=999999', { method: 'POST' })).status, 403, 'unknown or bot accounts are rejected');
  assert.equal((await f.request('/v1/preferences/autoplay-taste/on?actorId=200')).status, 404, 'GET is not a change');
  assert.equal(f.library.tasteInAutoplay('200'), false);
});

test('the portal command lane neither lists nor runs the personal taste subcommand', async t => {
  const f = await withStats(t);
  const radio = (await f.request('/v1/bootstrap?actorId=200')).body.commands.find(command => command.name === 'radio');
  assert.ok(radio.options.some(option => option.name === 'on'));
  assert.ok(!radio.options.some(option => option.name === 'mytaste'));
  const response = await f.command({ command: 'radio', subcommand: 'mytaste', options: { enabled: false } });
  assert.equal(response.status, 400);
  assert.equal(f.library.tasteInAutoplay('200'), true);
});
