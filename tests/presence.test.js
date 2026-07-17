import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType } from 'discord.js';
import {
  clearTrackPresence,
  IDLE_PRESENCE_ACTIVITY,
  startPresence,
  updateTrackPresence,
} from '../src/utils/presence.js';

function harness() {
  const presences = [];
  const client = {
    user: { setPresence: (presence) => { presences.push(presence); } },
  };
  const stop = startPresence(client);
  return { client, presences, stop };
}

function player(guildId, track, position = 0) {
  return {
    guildId,
    paused: false,
    position,
    queue: { current: track },
  };
}

function track(title, duration = 240_000, overrides = {}) {
  return {
    info: {
      author: 'Artist',
      duration,
      isStream: false,
      title,
      ...overrides,
    },
  };
}

test('presence starts with direct /play guidance', () => {
  const h = harness();

  assert.deepEqual(h.presences[0], {
    activities: [IDLE_PRESENCE_ACTIVITY],
    status: 'online',
  });
  h.stop();
});

test('active presence shows the track and artist without a text progress counter', () => {
  const h = harness();
  const current = player('g1', track('Midnight Drive'), 65_000);

  assert.equal(updateTrackPresence(h.client, current), true);
  assert.deepEqual(h.presences.at(-1), {
    activities: [{
      name: 'Midnight Drive',
      state: 'Artist',
      type: ActivityType.Listening,
    }],
    status: 'online',
  });

  h.stop();
});

test('most recently active guild owns global presence and falls back cleanly', () => {
  const h = harness();
  const first = player('g1', track('First Song'));
  const second = player('g2', track('Second Song'));

  updateTrackPresence(h.client, first);
  updateTrackPresence(h.client, second);
  assert.match(h.presences.at(-1).activities[0].name, /^Second Song/);

  clearTrackPresence(h.client, second);
  assert.match(h.presences.at(-1).activities[0].name, /^First Song/);

  clearTrackPresence(h.client, first);
  assert.deepEqual(h.presences.at(-1).activities[0], IDLE_PRESENCE_ACTIVITY);
  h.stop();
});

test('presence copy stays concise and track titles are bounded', () => {
  const h = harness();
  const longTitle = 'A'.repeat(200);

  updateTrackPresence(h.client, player('g1', track(longTitle)));
  assert.ok(Array.from(h.presences.at(-1).activities[0].name).length <= 128);
  h.stop();
});
