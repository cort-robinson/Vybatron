import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlayerPayload,
  buildQueuePayload,
  clampQueuePage,
  COLORS,
  QUEUE_PAGE_SIZE,
  remainingQueueDuration,
} from '../src/utils/messages.js';
import { trackIdentity } from '../src/utils/presentation.js';

function makeTrack(index) {
  return {
    info: {
      title: `Track ${index} **bold**`,
      author: `Artist ${index}`,
      duration: 60_000 + index,
      isSeekable: true,
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
  assert.match(json.description, /Ends <t:\d+:R>/);
  assert.match(json.description, /Up next/);
  assert.match(json.description, /Track 1/);
  assert.match(json.footer.text, /Volume 80%/);
  assert.equal(playing.components.length, 2);
  assert.deepEqual(
    playing.components[0].components.map((component) => component.data.label),
    ['Pause', 'Skip', 'View queue', 'Stop', 'Favorite']
  );
  assert.deepEqual(
    playing.components[1].components.map((component) => component.data.label),
    ['Shuffle', 'Loop: off', 'Seek', 'Refresh', 'Open track']
  );
  assert.equal(playing.components[1].components[2].data.disabled, false);
  const playerIds = playing.components
    .flatMap((row) => row.components)
    .map((component) => component.data.custom_id)
    .filter(Boolean);
  assert.equal(new Set(playerIds).size, playerIds.length);
  assert.deepEqual(playing.allowedMentions.parse, []);

  const paused = buildPlayerPayload(makePlayer(0), { state: 'paused' });
  assert.match(paused.embeds[0].toJSON().description, /Paused at/);
  assert.equal(paused.embeds[0].toJSON().color, COLORS.paused);
  assert.equal(paused.components[0].components[0].data.label, 'Resume');
  assert.equal(paused.components[0].components[0].data.disabled, false);

  const ended = buildPlayerPayload(makePlayer(1), { state: 'ended' });
  assert.equal(ended.components[0].components[0].data.disabled, true);
  assert.equal(ended.components[0].components[2].data.disabled, true);
  assert.equal(ended.components[0].components[3].data.disabled, true);

  const livePlayer = makePlayer(0);
  livePlayer.queue.current.info.isStream = true;
  const live = buildPlayerPayload(livePlayer);
  assert.equal(live.components[1].components[2].data.disabled, true);
});

for (const size of [0, 1, 10, 11, 25, 26, 250]) {
  test(`queue pagination remains bounded for ${size} queued tracks`, () => {
    const player = makePlayer(size);
    const maxPage = Math.max(0, Math.ceil(size / QUEUE_PAGE_SIZE) - 1);
    assert.equal(clampQueuePage(player, 10_000), maxPage);
    const payload = buildQueuePayload(player, maxPage);
    const json = payload.embeds[0].toJSON();
    assert.equal(json.color, COLORS.brand);
    assert.ok(json.description.length <= 4096);
    assert.match(json.description, /1:00/);
    assert.match(json.description, /listener0/);
    assert.match(json.footer.text, /remaining/);
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

test('ETA accounts for audio speed and hides guesses for unknown duration, loops, and paused queues', () => {
  const player = makePlayer(2);
  player.filterManager = { data: { timescale: { speed: 2, rate: 1 } } };
  assert.equal(remainingQueueDuration(player), (45_000 + 60_001 + 60_002) / 2);
  let json = buildQueuePayload(player).embeds[0].toJSON();
  assert.match(json.description, /in ~0:22/);
  assert.match(json.description, /in ~0:52/);
  assert.match(buildPlayerPayload(player).embeds[0].data.description, /25%/);
  player.paused = true;
  json = buildQueuePayload(player).embeds[0].toJSON();
  assert.doesNotMatch(json.description, /in ~/);
  assert.match(json.footer.text, /Paused/);
  player.paused = false;
  player.queue.tracks[0].info.duration = undefined;
  assert.equal(remainingQueueDuration(player), null);
  json = buildQueuePayload(player).embeds[0].toJSON();
  assert.match(json.footer.text, /Unknown remaining/);
  assert.equal((json.description.match(/in ~/g) || []).length, 1);
  player.repeatMode = 'track';
  assert.equal(remainingQueueDuration(player), null);
  assert.doesNotMatch(buildPlayerPayload(player).embeds[0].data.description, /Ends <t:/);
  assert.match(buildPlayerPayload(player).embeds[0].data.description, /Track loop on/);
  assert.doesNotMatch(buildQueuePayload(player).embeds[0].data.description, /in ~/);
});

test('arbitrary external titles remain valid Discord payloads with Unicode and mention limits', () => {
  const player = makePlayer(10);
  for (const track of [player.queue.current, ...player.queue.tracks]) {
    track.info.title = `**@everyone**${'🎵'.repeat(400)}`;
    track.info.author = `${'🎸'.repeat(400)}@here`;
    track.requester.username = '😀'.repeat(400);
  }
  const playerPayload = buildPlayerPayload(player);
  const queuePayload = buildQueuePayload(player);
  assert.ok(playerPayload.embeds[0].data.title.length <= 256);
  assert.ok(playerPayload.embeds[0].data.title.includes('@\u200b'));
  assert.ok(playerPayload.embeds[0].data.description.length <= 4096);
  assert.ok(queuePayload.embeds[0].data.description.length <= 4096);
  assert.ok(queuePayload.components[1].components[0].options.every((option) => option.data.label.length <= 100));
  assert.doesNotThrow(() => JSON.stringify(playerPayload));
  assert.doesNotThrow(() => JSON.stringify(queuePayload));
});

test('overlong or credential-bearing track URLs cannot break or leak through player links', () => {
  const player = makePlayer(0);
  player.queue.current.info.uri = `https://example.com/${'a'.repeat(600)}`;
  let payload = buildPlayerPayload(player);
  assert.equal(payload.components[1].components.some((button) => button.data.url), false);
  player.queue.current.info.uri = 'https://user:password@example.com/track';
  payload = buildPlayerPayload(player);
  assert.equal(payload.embeds[0].data.url, undefined);
  assert.equal(payload.components[1].components.some((button) => button.data.url), false);
});
