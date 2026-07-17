import test from 'node:test';
import assert from 'node:assert/strict';
import { data, execute } from '../src/commands/seek.js';

test('/seek exposes a bounded timestamp and seeks through the shared player', async () => {
  const json = data.toJSON();
  const timestamp = json.options.find((option) => option.name === 'timestamp');
  assert.equal(timestamp.required, true);
  assert.equal(timestamp.min_length, 4);
  assert.equal(timestamp.max_length, 12);

  const calls = [];
  const player = {
    voiceChannelId: 'voice',
    position: 0,
    queue: {
      current: { info: { title: 'Track', duration: 120_000, isSeekable: true } },
    },
    async seek(position) { calls.push(['seek', position]); },
  };
  const interaction = {
    guildId: 'guild',
    channelId: 'text',
    member: { voice: { channel: { id: 'voice' } } },
    client: { lavalink: { getPlayer: () => player } },
    options: { getString: () => '1:00' },
    deferred: false,
    replied: false,
    async reply(payload) { calls.push(['reply', payload]); },
  };

  await execute(interaction);
  assert.equal(calls[0][0], 'seek');
  assert.equal(calls[0][1], 60_000);
  assert.equal(calls[1][0], 'reply');
  assert.match(calls[1][1].content, /Jumped to 1:00/);
});
