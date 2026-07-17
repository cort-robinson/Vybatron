import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveQueuedTrack,
  nextLoopMode,
  parseSeekTimestamp,
  removeQueuedTrack,
  seekToTimestamp,
  setLoopMode,
} from '../src/utils/operations.js';

function track(title) {
  return { info: { title } };
}

function player() {
  const p = {
    repeatMode: 'off',
    queue: {
      current: { info: { title: 'Current', duration: 180_000, isSeekable: true } },
      tracks: [track('A'), track('B'), track('C')],
    },
    seekCalls: [],
    async seek(position) { this.seekCalls.push(position); },
    async setRepeatMode(mode) { this.repeatMode = mode; },
  };
  p.queue.splice = async (index, amount, inserted) => {
    const removed = inserted
      ? p.queue.tracks.splice(index, amount, inserted)
      : p.queue.tracks.splice(index, amount);
    return removed.length === 1 ? removed[0] : removed;
  };
  return p;
}

test('remove and move use one-based upcoming queue positions', async () => {
  const p = player();
  assert.equal((await removeQueuedTrack(p, 2)).info.title, 'B');
  p.queue.tracks = [track('A'), track('B'), track('C')];
  assert.equal((await moveQueuedTrack(p, 1, 3)).info.title, 'A');
  assert.deepEqual(p.queue.tracks.map((item) => item.info.title), ['B', 'C', 'A']);
});

test('invalid queue positions do not mutate and loop cycles deterministically', async () => {
  const p = player();
  const before = p.queue.tracks.slice();
  assert.equal(await removeQueuedTrack(p, 0), null);
  assert.equal(await moveQueuedTrack(p, 2, 2), null);
  assert.deepEqual(p.queue.tracks, before);
  assert.equal(nextLoopMode('off'), 'track');
  assert.equal(nextLoopMode('track'), 'queue');
  assert.equal(nextLoopMode('queue'), 'off');
  await setLoopMode(p, 'queue');
  assert.equal(p.repeatMode, 'queue');
});

test('seek parses timestamps and rejects invalid, ended, and live positions', async () => {
  assert.equal(parseSeekTimestamp('1:30'), 90_000);
  assert.equal(parseSeekTimestamp('1:02:03'), 3_723_000);
  assert.equal(parseSeekTimestamp('1:60'), null);
  assert.equal(parseSeekTimestamp('90'), null);

  const p = player();
  assert.deepEqual(await seekToTimestamp(p, 'bad'), {
    error: 'Enter a timestamp as mm:ss or hh:mm:ss.',
  });
  assert.deepEqual(await seekToTimestamp(p, '3:00'), {
    error: 'Choose a timestamp before the track ends.',
  });
  const result = await seekToTimestamp(p, '1:30');
  assert.equal(result.position, 90_000);
  assert.deepEqual(p.seekCalls, [90_000]);

  p.queue.current.info.isStream = true;
  assert.deepEqual(await seekToTimestamp(p, '0:30'), {
    error: 'This track does not support seeking.',
  });
});
