import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture } from './portal-fixtures.js';
import { publicCommands } from '../src/portal/commands.js';
import { loadCommandsData } from '../src/commands/index.js';

const link = id => `https://www.youtube.com/watch?v=${id}`;
const move = (options = {}, tracks = [link('abcdefghijk'), link('lmnopqrstuv')]) =>
  ({ command: 'transfer', options: { position: 42_000, paused: false, volume: 60, repeat: 'queue', ...options }, tracks });

test('transfer moves a device session into the listener’s voice channel at its place', async t => {
  const f = await portalFixture(t, { idle: true });
  const before = (await f.request()).body;
  assert.deepEqual(before.session.viewerVoice, { id: '300', name: 'General' });
  const moved = await f.command(move({ paused: true }));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.match(moved.body.message, /Moved 2 songs to General, paused/);
  const player = f.manager.getPlayer('100');
  assert.equal(player.voiceChannelId, '300'); assert.equal(player.textChannelId, '400');
  assert.equal(player.queue.current.info.identifier, 'abcdefghijk');
  assert.deepEqual(player.queue.tracks.map(track => track.info.identifier), ['lmnopqrstuv']);
  assert.equal(player.volume, 60); assert.equal(player.repeatMode, 'queue');
  const play = f.calls.find(item => Array.isArray(item) && item[0] === 'play');
  assert.equal(play[1].position, 42_000); assert.equal(play[1].paused, true);
  assert.equal(moved.body.snapshot.session.status, 'paused');
  // The listener asked for these songs, so they count as theirs.
  assert.equal(player.queue.current.requester.id, '200');
});

test('transfer never replaces a session other listeners are hearing', async t => {
  const f = await portalFixture(t);
  const current = f.player.queue.current;
  const refused = await f.command(move());
  assert.equal(refused.status, 409); assert.equal(refused.body.error.code, 'session_active');
  assert.equal(f.player.queue.current, current); assert.equal(f.player.queue.tracks.length, 2);
});

test('transfer needs the listener in a voice channel and a configured music channel', async t => {
  const f = await portalFixture(t, { idle: true });
  f.members.get('200').voice.channel = null;
  assert.equal((await f.request()).body.session.viewerVoice, null);
  assert.equal((await f.command(move())).status, 403);
  f.members.get('200').voice.channel = f.channels.get('300');
  await f.library.updateGuild('100', guild => { guild.settings.musicTextChannelId = null; });
  assert.equal((await f.command(move())).status, 409);
  assert.equal(f.manager.getPlayer('100'), undefined);
});

test('transfer accepts only bounded public links and stays out of the slash command schemas', async t => {
  const f = await portalFixture(t, { idle: true });
  for (const tracks of [[], ['http://example.com/song'], ['https://example.com/a b'], Array.from({ length: 101 }, (_, index) => link(String(index).padStart(11, '0')))]) {
    assert.equal((await f.command(move({}, tracks))).status, 400);
  }
  assert.equal((await f.command({ ...move(), command: 'play', options: { query: 'song' } })).status, 400);
  assert.equal((await f.command(move({ position: -1 }))).status, 400);
  const { tracks: _tracks, ...withoutTracks } = move();
  assert.equal((await f.command(withoutTracks)).status, 400);
  assert.ok(!publicCommands(await loadCommandsData()).some(command => command.name === 'transfer'));
});
