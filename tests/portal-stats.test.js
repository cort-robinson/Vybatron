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
