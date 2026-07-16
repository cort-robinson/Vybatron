import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOrUpdate,
  end,
  getControllerRecord,
  getMessageLink,
  refresh,
  resetControllers,
} from '../src/utils/player-controller.js';

function track(id = 'one') {
  return { info: { title: id, author: 'Artist', identifier: id, uri: `https://example.com/${id}` } };
}

function player(guildId = 'guild') {
  return {
    guildId,
    textChannelId: 'channel',
    paused: false,
    position: 0,
    volume: 100,
    queue: { current: track(), tracks: [] },
  };
}

function fixture() {
  let sends = 0;
  let edits = 0;
  const messages = new Map();
  const channel = {
    messages: { fetch: async (id) => messages.get(id) || null },
    send: async () => {
      sends += 1;
      const message = {
        id: `message-${sends}`,
        edit: async () => { edits += 1; return message; },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  return {
    client: { channels: { cache: new Map([['channel', channel]]) } },
    messages,
    get sends() { return sends; },
    get edits() { return edits; },
  };
}

test.afterEach(resetControllers);

test('controller sends once, edits thereafter, and links to its origin', async () => {
  const f = fixture();
  const p = player();
  await createOrUpdate(f.client, p);
  await refresh(f.client, p);
  assert.equal(f.sends, 1);
  assert.equal(f.edits, 1);
  assert.equal(getMessageLink('guild'), 'https://discord.com/channels/guild/channel/message-1');
});

test('concurrent first-track writes create one controller', async () => {
  const f = fixture();
  const p = player('concurrent');
  const create = createOrUpdate(f.client, p);
  const update = refresh(f.client, p);
  await Promise.all([create, update]);
  assert.equal(f.sends, 1);
  assert.equal(f.edits, 1);
  assert.equal(getControllerRecord('concurrent').messageId, 'message-1');
});

test('a deleted controller is replaced once and the registry is updated', async () => {
  const f = fixture();
  const p = player('deleted');
  await createOrUpdate(f.client, p);
  f.messages.delete('message-1');
  await refresh(f.client, p);
  await refresh(f.client, p);
  assert.equal(f.sends, 2);
  assert.equal(f.edits, 1);
  assert.equal(getControllerRecord('deleted').messageId, 'message-2');
});

test('a controller deleted between fetch and edit is replaced', async () => {
  const f = fixture();
  const p = player('edit-race');
  await createOrUpdate(f.client, p);
  f.messages.get('message-1').edit = async () => { throw new Error('Unknown Message'); };
  await refresh(f.client, p);
  assert.equal(f.sends, 2);
  assert.equal(getControllerRecord('edit-race').messageId, 'message-2');
});

test('ending edits the existing message and removes the session registry', async () => {
  const f = fixture();
  const p = player('ended');
  await createOrUpdate(f.client, p);
  await end(f.client, p, 'Stopped by a listener.');
  assert.equal(f.edits, 1);
  assert.equal(getControllerRecord('ended'), null);
});
