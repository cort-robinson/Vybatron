import test from 'node:test';
import assert from 'node:assert/strict';
import { forgottenGems, isComplete, isEarlySkip, onRepeat, SCORING } from '../src/utils/stats-scoring.js';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;
const play = (songKey, daysAgo, requesterId = '200', extra = {}) => ({ songKey, playedAt: NOW - daysAgo * DAY, requesterKind: requesterId ? 'user' : 'autoplay', requesterId, skipped: false, ...extra });
const keys = list => list.map(entry => entry.songKey);

test('recent plays outrank equally popular older plays, halving every two weeks', () => {
  const [fresh, old] = onRepeat([play('fresh', 0, '200'), play('old', 14, '201')], NOW);
  assert.deepEqual([fresh.songKey, old.songKey], ['fresh', 'old']);
  assert.equal(fresh.score, 1);
  assert.equal(old.score, 0.5);
  assert.deepEqual(keys(onRepeat([play('ancient', 91)], NOW)), [], 'outside the 90-day window');
});

test('one requester replaying a song cannot outrank songs chosen by several people', () => {
  const spam = Array.from({ length: 10 }, () => play('spam', 0, '200'));
  const shared = ['201', '202', '203', '204'].map(id => play('shared', 0, id));
  const [first, second] = onRepeat([...spam, ...shared], NOW);
  assert.equal(first.songKey, 'shared');
  assert.equal(first.score, 4);
  assert.equal(second.score, 1 + 9 * SCORING.repeatFactor);
  assert.equal(second.plays, 10);
});

test('early skips count against a song and can remove it from the list', () => {
  const liked = [play('liked', 1, '200'), play('liked', 1, '201')];
  const skipped = [play('skipped', 1, '200'), play('skipped', 1, '201'), ...['202', '203', '204'].map(id => play('skipped', 1, id, { skipped: true }))];
  const list = onRepeat([...liked, ...skipped], NOW);
  assert.deepEqual(keys(list), ['liked', 'skipped']);
  assert.ok(list[1].score < list[0].score);
  const hated = [play('hated', 0, '200'), ...['201', '202'].map(id => play('hated', 0, id, { skipped: true }))];
  assert.deepEqual(keys(onRepeat(hated, NOW)), [], 'net-negative songs are not on repeat');
});

test('autoplay and backfilled plays count half; cleared requests share one anonymous requester', () => {
  const [autoplay] = onRepeat([play('radio', 0, null)], NOW);
  assert.equal(autoplay.score, SCORING.unattendedFactor);
  const [unknown] = onRepeat([play('old', 0, null, { requesterKind: 'unknown' }), play('old', 0, null, { requesterKind: 'unknown' })], NOW);
  assert.equal(unknown.score, 2 * SCORING.unattendedFactor);
  const [cleared] = onRepeat([play('c', 0, null, { requesterKind: 'cleared' }), play('c', 0, null, { requesterKind: 'cleared' })], NOW);
  assert.equal(cleared.score, 1 + SCORING.repeatFactor);
});

test('on repeat is capped at 25 songs with stable ordering', () => {
  const plays = Array.from({ length: 40 }, (_, index) => play(`song-${String(index).padStart(2, '0')}`, index / 10, String(200 + index)));
  const list = onRepeat(plays, NOW);
  assert.equal(list.length, 25);
  assert.equal(list[0].songKey, 'song-00');
  assert.deepEqual(keys(onRepeat(plays, NOW)), keys(list));
});

test('forgotten gems were popular 60-120 days ago with no plays since', () => {
  const gem = ['200', '201', '202'].map(id => play('gem', 90, id));
  const stillPlayed = [...['200', '201', '202'].map(id => play('still', 90, id)), play('still', 10, '203')];
  const tooOld = ['200', '201', '202'].map(id => play('ancient', 121, id));
  const tooRecent = ['200', '201', '202'].map(id => play('recent', 59, id));
  const unpopular = [play('niche', 90, '200')];
  const list = forgottenGems([...gem, ...stillPlayed, ...tooOld, ...tooRecent, ...unpopular], NOW);
  assert.deepEqual(keys(list), ['gem']);
  assert.equal(list[0].plays, 3);
});

test('forgotten gems also discount repeat plays and skips', () => {
  const loop = Array.from({ length: 4 }, () => play('loop', 80, '200'));
  assert.deepEqual(keys(forgottenGems(loop, NOW)), [], 'one person, four plays scores 1.75');
  const skipped = [...['200', '201'].map(id => play('meh', 80, id)), play('meh', 80, '202', { skipped: true })];
  assert.deepEqual(keys(forgottenGems(skipped, NOW)), []);
});

test('early skip and completion thresholds', () => {
  assert.equal(isEarlySkip({ playedMs: 29_000, durationMs: 600_000 }), true);
  assert.equal(isEarlySkip({ playedMs: 60_000, durationMs: 200_000 }), true, 'under 40%');
  assert.equal(isEarlySkip({ playedMs: 90_000, durationMs: 200_000 }), false);
  assert.equal(isEarlySkip({ playedMs: 35_000, durationMs: 0 }), false, 'unknown duration uses the 30 second rule');
  assert.equal(isComplete({ playedMs: 180_000, durationMs: 200_000 }), true);
  assert.equal(isComplete({ playedMs: 10_000, durationMs: 200_000, finished: true }), true);
  assert.equal(isComplete({ playedMs: 170_000, durationMs: 200_000 }), false);
});
