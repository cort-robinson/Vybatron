import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlayerPayload,
  buildQueuePayload,
  clampQueuePage,
  COLORS,
  QUEUE_PAGE_SIZE,
} from '../src/utils/messages.js';
import { trackIdentity } from '../src/utils/presentation.js';

function makeTrack(index) {
  return {
    info: {
      title: `Track ${index} **bold**`,
      author: `Artist ${index}`,
      duration: 60_000 + index,
      identifier: `id-${index}`,
      sourceName: 'youtube',
      uri: `https://example.com/${index}`,
      artworkUrl: 'https://example.com/art.png',
    },
    requester: { username: `listener${index}` },
  };
}

function makePlayer(size) {
  return {
    paused: false,
    position: 15_000,
    volume: 80,
    queue: {
      current: makeTrack(0),
      tracks: Array.from({ length: size }, (_, index) => makeTrack(index + 1)),
    },
  };
}

test('player payload uses semantic status, timestamp, and native controls', () => {
  const playing = buildPlayerPayload(makePlayer(1), { startedAt: 1_700_000_000_000 });
  const json = playing.embeds[0].toJSON();
  assert.equal(json.color, COLORS.brand);
  assert.equal(json.author.name, 'Now Playing');
  assert.equal(json.timestamp, '2023-11-14T22:13:20.000Z');
  assert.equal(playing.components[0].components.length, 5);
  assert.deepEqual(playing.allowedMentions.parse, []);

  const paused = buildPlayerPayload(makePlayer(0), { state: 'paused' });
  assert.equal(paused.components[0].components[0].data.label, 'Resume');
  assert.equal(paused.components[0].components[0].data.disabled, false);

  const ended = buildPlayerPayload(makePlayer(1), { state: 'ended' });
  assert.equal(ended.components[0].components[0].data.disabled, true);
  assert.equal(ended.components[0].components[2].data.disabled, true);
  assert.equal(ended.components[0].components[3].data.disabled, true);
});

for (const size of [0, 1, 10, 11, 25, 26, 250]) {
  test(`queue pagination remains bounded for ${size} queued tracks`, () => {
    const player = makePlayer(size);
    const maxPage = Math.max(0, Math.ceil(size / QUEUE_PAGE_SIZE) - 1);
    assert.equal(clampQueuePage(player, 10_000), maxPage);
    const payload = buildQueuePayload(player, maxPage);
    const json = payload.embeds[0].toJSON();
    assert.ok(json.description.length <= 4096);
    assert.match(json.description, /1:00/);
    assert.match(json.description, /listener0/);
    assert.ok(payload.components.length >= 1 && payload.components.length <= 2);
    const previous = payload.components[0].components[0].data;
    const next = payload.components[0].components[1].data;
    const customIds = payload.components
      .flatMap((row) => row.components)
      .map((component) => component.data.custom_id)
      .filter(Boolean);
    assert.equal(new Set(customIds).size, customIds.length);
    assert.equal(previous.disabled, maxPage === 0);
    assert.equal(next.disabled, true);
    if (size > 0) {
      const options = payload.components[1].components[0].options;
      assert.ok(options.length <= 10);
      const absoluteIndex = maxPage * QUEUE_PAGE_SIZE + 1;
      assert.equal(options[0].data.value, `${absoluteIndex}:${trackIdentity(player.queue.tracks[absoluteIndex - 1])}`);
    }
  });
}
