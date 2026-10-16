import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goBack,
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

function sessionPlayer({ position = 1_000, previous = [track('Earlier')], current = track('Now') } = {}) {
  if (current) Object.assign(current.info, { duration: 180_000, isSeekable: true });
  const p = {
    position,
    queue: {
      current,
      tracks: [track('Next')],
      previous: [...previous],
      async add(added, index) { this.tracks.splice(index, 0, added); },
      async shiftPrevious() { return this.previous.shift() ?? null; },
    },
    seekCalls: [],
    async seek(to) { this.seekCalls.push(to); },
    async play({ clientTrack }) { this.queue.current = clientTrack; },
  };
  return p;
}

test('Back early in a track plays the previous one and queues the current one next', async () => {
  const p = sessionPlayer();
  const result = await goBack(p);
  assert.equal(result.restarted, false);
  assert.equal(p.queue.current.info.title, 'Earlier');
  assert.deepEqual(p.queue.tracks.map(t => t.info.title), ['Now', 'Next']);
  assert.deepEqual(p.queue.previous, []);
  assert.deepEqual(p.seekCalls, []);
});

test('Back later in a track, or with no earlier track, restarts it', async () => {
  const late = sessionPlayer({ position: 3_500 });
  assert.equal((await goBack(late)).restarted, true);
  assert.deepEqual(late.seekCalls, [0]);
  assert.equal(late.queue.previous.length, 1);

  const first = sessionPlayer({ previous: [] });
  assert.equal((await goBack(first)).restarted, true);
  assert.deepEqual(first.seekCalls, [0]);
});

test('web Back always returns to an earlier track when one exists', async () => {
  const p = sessionPlayer({ position: 60_000 });
  const result = await goBack(p, { restartAfterMs: Infinity });
  assert.equal(result.restarted, false);
  assert.equal(p.queue.current.info.title, 'Earlier');
});

test('Back from a live stream goes to the previous track, and explains when it cannot', async () => {
  const p = sessionPlayer({ position: 60_000 });
  p.queue.current.info.isStream = true;
  assert.equal((await goBack(p)).track.info.title, 'Earlier');

  const alone = sessionPlayer({ previous: [] });
  alone.queue.current.info.isStream = true;
  assert.match((await goBack(alone)).error, /no earlier track/);
  assert.deepEqual(alone.seekCalls, []);
});
