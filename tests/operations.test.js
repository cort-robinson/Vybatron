import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveQueuedTrack,
  nextLoopMode,
  removeQueuedTrack,
  setLoopMode,
} from '../src/utils/operations.js';

function track(title) {
  return { info: { title } };
}

function player() {
  const p = {
    repeatMode: 'off',
    queue: { tracks: [track('A'), track('B'), track('C')] },
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
