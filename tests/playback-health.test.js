import test from 'node:test';
import assert from 'node:assert/strict';
import { playbackHealth, recordPlaybackFailure, recordPlaybackProgress } from '../src/utils/playback-health.js';

test('real playback failures retain only bounded public video identifiers', (t) => {
  const client = {};
  const track = { encoded: 'secret', requester: { id: 'private-user' }, info: {
    sourceName: 'youtube', identifier: 'RYnFIRc0k6E', title: 'private title', uri: 'https://signed.example',
  } };
  t.mock.method(Date, 'now', () => 1000);
  for (let i = 0; i < 12; i++) recordPlaybackFailure(client, track);
  const health = playbackHealth(client);
  assert.equal(health.failures.length, 10);
  assert.equal(new Set(health.failures.map((f) => f.id)).size, 10);
  assert.deepEqual(Object.keys(health.failures[0]).sort(), ['at', 'id', 'identifier']);
  assert.doesNotMatch(JSON.stringify(health), /secret|private|signed/);
  health.failures[0].identifier = 'mutated';
  assert.equal(playbackHealth(client).failures[0].identifier, 'RYnFIRc0k6E');
  Date.now.mock.mockImplementation(() => 1000 + 15 * 60_000);
  assert.deepEqual(playbackHealth(client), { failures: [] });
});

test('unsupported sources and malformed identifiers never become probe targets', () => {
  const client = {};
  recordPlaybackFailure(client, { info: { sourceName: 'soundcloud', identifier: 'RYnFIRc0k6E' } });
  recordPlaybackFailure(client, { info: { sourceName: 'youtube', identifier: 'https://private.example' } });
  assert.deepEqual(playbackHealth(client), { failures: [] });
});

test('server-reported playback progress clears only the recovered video', () => {
  const client = {};
  const track = { info: { sourceName: 'youtube', identifier: 'RYnFIRc0k6E' } };
  recordPlaybackFailure(client, track);
  recordPlaybackFailure(client, { info: { sourceName: 'youtube', identifier: 'jNQXAC9IVRw' } });
  const player = { connected: true, playing: true, queue: { current: track }, lastPosition: 0 };
  recordPlaybackProgress(client, player);
  assert.equal(playbackHealth(client).failures.length, 2);
  player.lastPosition = 5000;
  recordPlaybackProgress(client, player);
  assert.deepEqual(playbackHealth(client).failures.map((f) => f.identifier), ['jNQXAC9IVRw']);
});
