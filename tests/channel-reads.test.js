import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { channelTrusted, trackChannelReads, trackedChannelRead } from '../src/utils/channel-reads.js';
import { execute as settings } from '../src/commands/settings.js';

function fixture() {
  const client = new EventEmitter();
  const channels = new Map([['400', { id: '400', guildId: '100' }], ['401', { id: '401', guildId: '100' }]]);
  client.guilds = { cache: new Map([['100', { id: '100', channels: { cache: channels } }]]) };
  trackChannelReads(client);
  // A read Discord answers when the test says so.
  const read = (ids = ['400'], result = null) => {
    let answer, fail; const answered = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
    const reading = trackedChannelRead(client, '100', ids, () => answered.then(value => value ?? result));
    return { reading, answer, fail };
  };
  return { client, channels, read, update: id => client.emit('channelUpdate', null, { id, guildId: '100' }) };
}

test('a change crossing an in-flight read untrusts the channel at once and after the answer lands', async () => {
  const { client, read, update } = fixture();
  const pending = read(); update('400');
  assert.equal(channelTrusted(client, '100', '400'), false, 'untrusted before the late answer is written');
  assert.equal(channelTrusted(client, '100', '401'), true, 'other channels are unaffected');
  pending.answer({}); await pending.reading;
  assert.equal(channelTrusted(client, '100', '400'), false);
  const clean = read(); clean.answer({}); await clean.reading;
  assert.equal(channelTrusted(client, '100', '400'), true, 'a clean re-read restores trust');
});

test('an older crossed read that lands after a clean read keeps the channel untrusted', async () => {
  const { client, read, update } = fixture();
  const older = read(); update('400');
  const clean = read(); clean.answer({}); await clean.reading;
  assert.equal(channelTrusted(client, '100', '400'), false, 'the older crossed read is still in flight');
  older.answer({}); await older.reading;
  assert.equal(channelTrusted(client, '100', '400'), false, 'its late answer may be older than the change');
});

test('a failed read writes nothing and marks nothing', async () => {
  const { client, read, update } = fixture();
  const pending = read(); update('400'); pending.fail(new Error('Unknown channel'));
  await assert.rejects(pending.reading, /Unknown channel/);
  assert.equal(channelTrusted(client, '100', '400'), true);
});

test('guild availability, membership and shard lifecycle changes cross every in-flight read of that guild', async () => {
  for (const [event, value] of [['guildUnavailable', { id: '100' }], ['guildAvailable', { id: '100' }], ['guildCreate', { id: '100' }],
    ['shardReconnecting', 0], ['shardResume', 0], ['shardReady', 0], ['shardDisconnect', {}], ['invalidated']]) {
    const { client, read } = fixture();
    const single = read(['400']); const list = read(null, new Map([['401', {}]]));
    client.emit(event, value);
    assert.equal(channelTrusted(client, '100', '400'), false, event);
    assert.equal(channelTrusted(client, '100', '401'), false, `${event}: the whole-list read covers every channel`);
    single.answer({}); list.answer(); await Promise.all([single.reading, list.reading]);
    assert.equal(channelTrusted(client, '100', '400'), false, `${event}: stays untrusted after landing`);
    assert.equal(channelTrusted(client, '100', '401'), false, `${event}: list answer marked`);
  }
  const { client, read } = fixture();
  const other = read(); client.emit('guildAvailable', { id: '101' });
  assert.equal(channelTrusted(client, '100', '400'), true, 'another guild changing does not cross this one');
  other.answer({}); await other.reading;
});

test('marks are reclaimed when the channel or the guild is gone and nothing is reading it', async () => {
  const { client, channels, read, update } = fixture();
  const pending = read(); update('400'); pending.answer({}); await pending.reading;
  assert.equal(channelTrusted(client, '100', '400'), false, 'still cached: the late answer may be what is cached');
  channels.delete('400');
  assert.equal(channelTrusted(client, '100', '400'), true, 'gone from the cache: absent, as REST would answer');
  const again = read(['401']); update('401'); again.answer({}); await again.reading;
  client.guilds.cache.delete('100'); client.emit('guildDelete', { id: '100' });
  assert.equal(channelTrusted(client, '100', '401'), true, 'a guild the bot left drops its marks');
});

test('native /settings musicchannel tracks its read; the portal path relies on the policy read and is not wrapped again', async () => {
  for (const portal of [false, true]) {
    const { client, update } = fixture();
    client.library = { settings: () => ({}), updateGuild: async () => {} }; client.lavalink = { getPlayer: () => null };
    const channel = { id: '400', guildId: '100', type: 0, permissionsFor: () => ({ has: () => true }) };
    const interaction = { client, guildId: '100', user: { id: '202' }, ...(portal && { portalRecheck: async () => {} }),
      guild: { ownerId: '202', channels: { fetch: async () => { update('400'); return channel; } }, members: { fetchMe: async () => ({ id: '999' }) } },
      options: { getSubcommand: () => 'musicchannel', getChannel: () => channel }, reply: async () => {} };
    await settings(interaction); await tick();
    assert.equal(channelTrusted(client, '100', '400'), portal, portal ? 'portal: tracked inside the policy read, not here' : 'native: the crossed read is tracked');
  }
});

test('a read landing after the bot left the guild, and a deleted unread channel, leave no marks', async () => {
  const { client, channels, read, update } = fixture();
  const pending = read(); update('400');
  client.guilds.cache.delete('100'); client.emit('guildDelete', { id: '100' });
  pending.answer({}); await pending.reading;
  client.guilds.cache.set('100', { id: '100', channels: { cache: channels } });
  assert.equal(channelTrusted(client, '100', '400'), true, 'the late answer after the leave marked nothing');
  const crossed = read(['401']); update('401'); crossed.answer({}); await crossed.reading;
  assert.equal(channelTrusted(client, '100', '401'), false);
  channels.delete('401'); client.emit('channelDelete', { id: '401', guildId: '100' });
  channels.set('401', { id: '401', guildId: '100' });
  assert.equal(channelTrusted(client, '100', '401'), true, 'the deletion dropped the mark; a later channel with that id starts trusted');
});
