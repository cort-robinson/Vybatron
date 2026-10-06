import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration,
  isUrl,
  plainText,
  playbackRate,
  progressBar,
  remainingTrackDuration,
  safeText,
  safeUrl,
  trackIdentity,
} from '../src/utils/presentation.js';

test('presentation text strips controls and collapses whitespace', () => {
  assert.equal(plainText('  hello\u0000\n\t world  '), 'hello world');
});

test('presentation text escapes Markdown, neutralizes mentions, and truncates Unicode safely', () => {
  const value = safeText('**@everyone** 😀😀😀', { maxLength: 14 });
  assert.ok(value.includes('@\u200b'));
  assert.ok(value.includes('\\*'));
  assert.ok(Array.from(value).length <= 14);
  assert.doesNotMatch(value, /[\u0000-\u001f\u007f-\u009f]/);
});

test('URL validation permits only HTTP(S)', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('ftp://example.com/file'), null);
  assert.equal(safeUrl('not a url'), null);
  assert.equal(safeUrl('https://user:password@example.com/track'), null);
  assert.equal(safeUrl(`https://example.com/${'a'.repeat(2100)}`), null);
  assert.equal(safeUrl(`https://example.com/${'a'.repeat(600)}`, { maxLength: 512 }), null);
  assert.equal(safeUrl('https://example.com/a').startsWith('https://'), true);
  assert.equal(isUrl('http://example.com'), true);
  assert.equal(isUrl('search words'), false);
});

test('duration and track hashes are stable', () => {
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_665_000), '1:01:05');
  assert.equal(formatDuration(0, true), 'Live');
  const first = { info: { sourceName: 'youtube', identifier: 'abc', uri: 'https://example.com/a' } };
  const same = { info: { ...first.info } };
  const renamed = { info: { ...first.info, title: 'Renamed metadata' } };
  const other = { info: { ...first.info, identifier: 'def' } };
  assert.equal(trackIdentity(first), trackIdentity(same));
  assert.notEqual(trackIdentity(first), trackIdentity(renamed));
  assert.notEqual(trackIdentity(first), trackIdentity(other));
});

test('Unicode truncation respects Discord UTF-16 limits without splitting a surrogate pair', () => {
  for (const length of [4, 13, 100, 256]) {
    const value = plainText('🎵'.repeat(400), { maxLength: length });
    assert.ok(value.length <= length);
    assert.doesNotMatch(value, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  }
});

test('progress and remaining time handle missing metadata and speed effects honestly', () => {
  const player = { position: 30_000, queue: { current: { info: { duration: 120_000 } } } };
  assert.match(progressBar(30_000, 120_000), /25%/);
  assert.match(progressBar(-10, 120_000), /0%/);
  assert.match(progressBar(999_999, 120_000), /100%/);
  assert.equal(progressBar(0, undefined), null);
  assert.equal(remainingTrackDuration(player), 90_000);
  player.filterManager = { data: { timescale: { speed: 1.5, rate: 2 } } };
  assert.equal(playbackRate(player), 3);
  assert.equal(remainingTrackDuration(player), 30_000);
  player.filterManager.data.timescale.speed = 0;
  assert.equal(remainingTrackDuration(player), null);
  player.queue.current.info.isStream = true;
  assert.equal(remainingTrackDuration(player), null);
});
