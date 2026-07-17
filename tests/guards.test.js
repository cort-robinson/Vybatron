import test from 'node:test';
import assert from 'node:assert/strict';
import { requireUserVoice, requireControl } from '../src/utils/guards.js';

function mockInteraction({ voiceChannelId = null, voiceChannel = null, player = undefined } = {}) {
  const replies = [];
  return {
    guildId: 'g1',
    member: { voice: { channel: voiceChannel || (voiceChannelId ? { id: voiceChannelId } : null) } },
    client: { lavalink: { getPlayer: () => player } },
    deferred: false,
    replied: false,
    reply(p) {
      replies.push(p);
      this.replied = true;
      return Promise.resolve();
    },
    followUp(p) {
      replies.push(p);
      return Promise.resolve();
    },
    get replies() {
      return replies;
    },
  };
}

test('V3: no voice channel rejects with reply', async () => {
  const i = mockInteraction();
  const result = await requireUserVoice(i);
  assert.equal(result, null);
  assert.equal(i.replies.length, 1);
});

test('V3: user in voice channel passes', async () => {
  const i = mockInteraction({ voiceChannelId: 'vc1' });
  const result = await requireUserVoice(i);
  assert.equal(result.id, 'vc1');
  assert.equal(i.replies.length, 0);
});

test('voice permission failures explain how to recover', async () => {
  const cannotJoin = mockInteraction({
    voiceChannel: { id: 'vc1', joinable: false, speakable: true },
  });
  assert.equal(await requireUserVoice(cannotJoin, { checkBotAccess: true }), null);
  assert.match(cannotJoin.replies[0].content, /View Channel and Connect/);

  const cannotSpeak = mockInteraction({
    voiceChannel: { id: 'vc1', joinable: true, speakable: false },
  });
  assert.equal(await requireUserVoice(cannotSpeak, { checkBotAccess: true }), null);
  assert.match(cannotSpeak.replies[0].content, /Speak permission/);

  const existingSession = mockInteraction({
    voiceChannel: { id: 'vc1', joinable: false, speakable: false },
    player: { voiceChannelId: 'vc1' },
  });
  assert.equal(await requireControl(existingSession), existingSession.client.lavalink.getPlayer());
});

test('V8: no active player rejects', async () => {
  const i = mockInteraction({ voiceChannelId: 'vc1', player: undefined });
  const result = await requireControl(i);
  assert.equal(result, null);
  assert.equal(i.replies.length, 1);
});

test('V8: user in different channel than bot rejects', async () => {
  const player = { voiceChannelId: 'vc-bot' };
  const i = mockInteraction({ voiceChannelId: 'vc-user', player });
  const result = await requireControl(i);
  assert.equal(result, null);
  assert.equal(i.replies.length, 1);
});

test('V8: user in same channel as bot passes', async () => {
  const player = { voiceChannelId: 'vc1' };
  const i = mockInteraction({ voiceChannelId: 'vc1', player });
  const result = await requireControl(i);
  assert.equal(result, player);
  assert.equal(i.replies.length, 0);
});
