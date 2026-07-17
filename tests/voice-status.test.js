import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearVoiceStatus,
  resetVoiceStatusWarnings,
  updateVoiceStatus,
} from '../src/utils/voice-status.js';

function player(paused = false) {
  return {
    guildId: 'guild',
    voiceChannelId: 'voice',
    paused,
    queue: { current: { info: { title: 'Song', author: 'Artist' } } },
  };
}

function client(allowed = true) {
  const calls = [];
  return {
    user: { id: 'bot' },
    channels: { cache: new Map([['voice', { permissionsFor: () => ({ has: () => allowed }) }]]) },
    rest: { put: async (route, payload) => { calls.push({ route, payload }); } },
    calls,
  };
}

beforeEach(resetVoiceStatusWarnings);

test('voice status sets playing and paused text, then clears', async () => {
  const c = client();
  await updateVoiceStatus(c, player());
  await updateVoiceStatus(c, player(true));
  await clearVoiceStatus(c, player());
  assert.equal(c.calls[0].payload.body.status, '🎵 Song — Artist');
  assert.equal(c.calls[1].payload.body.status, '⏸ Song — Artist');
  assert.equal(c.calls[2].payload.body.status, null);
});

test('missing voice-status permission is non-fatal', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const c = client(false);
    assert.equal(await updateVoiceStatus(c, player()), false);
    assert.equal(c.calls.length, 0);
  } finally {
    console.warn = originalWarn;
  }
});
