import test from 'node:test';
import assert from 'node:assert/strict';
import { LavalinkManager } from 'lavalink-client';
import {
  createOrUpdate,
  end,
  getControllerRecord,
  getMessageLink,
  refresh,
  resetControllers,
  showStatus,
  requestControllerEnd,
} from '../src/utils/player-controller.js';
import { getPresentationDiagnostics, submitPresentationWrite } from '../src/utils/presentation-updates.js';

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
  const payloads = [];
  const channel = {
    messages: { fetch: async (id) => messages.get(id) || null },
    send: async (payload) => {
      sends += 1;
      payloads.push(payload);
      const message = {
        id: `message-${sends}`,
        edit: async (payload) => { edits += 1; payloads.push(payload); return message; },
      };
      messages.set(message.id, message);
      return message;
    },
  };
  return {
    client: { channels: { cache: new Map([['channel', channel]]) } },
    channel,
    messages,
    payloads,
    get sends() { return sends; },
    get edits() { return edits; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nativeFixture(guildId) {
  const f = fixture();
  const manager = new LavalinkManager({
    nodes: [{ id: 'test', host: 'localhost', port: 2333, authorization: 'test-password' }],
    client: { id: '123' }, sendToShard: () => {},
  });
  const node = manager.nodeManager.nodes.get('test');
  node.socket = { readyState: 1 };
  node.sessionId = 'test-session';
  node.info = { sourceManagers: ['youtube'], filters: [], plugins: [] };
  function createNative(title = 'Current song') {
    const p = manager.createPlayer({ guildId, voiceChannelId: 'voice', textChannelId: 'channel', node: 'test' });
    p.queue.current = manager.utils.buildTrack({
      encoded: 'test-encoded', pluginInfo: {}, userData: {},
      info: { identifier: 'abcdefghijk', title, author: 'Artist', length: 180_000,
        uri: 'https://www.youtube.com/watch?v=abcdefghijk', sourceName: 'youtube', isStream: false, isSeekable: true },
    }, { id: '200' });
    return p;
  }
  f.client.lavalink = manager;
  return Object.assign(f, { manager, player: createNative(), createNative });
}

function assertEndedControls(payload) {
  const controls = payload.components.flatMap(row => row.components).filter(button => button.data.custom_id);
  assert.ok(controls.every(button => button.data.disabled), 'ended playback cannot leave actionable transport buttons');
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
  assert.equal(f.edits, 0, 'overlapping initial intents share the latest render');
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

test('rejected terminal admission cleans owned metadata synchronously while saturated writers retain fences', async () => {
  const f = fixture(); const p = player('saturated-terminal');
  await createOrUpdate(f.client, p);
  const gate = deferred();
  const held = Array.from({ length: 256 }, (_, i) => submitPresentationWrite(`saturation:${i}`, () => gate.promise));
  try {
    await new Promise(resolve => setImmediate(resolve));
    const before = getPresentationDiagnostics();
    assert.equal(before.records, 256); assert.equal(before.ordinary, 4); assert.equal(before.terminal, 0);
    const ending = requestControllerEnd(f.client, p);
    assert.equal(getControllerRecord(p.guildId), null, 'cleanup cannot depend on a dropped terminal operation');
    assert.equal(await ending, null);
    assert.deepEqual(getPresentationDiagnostics(), { ...before, drops: before.drops + 1 });
    assert.equal(await createOrUpdate(f.client, p), null, 'synchronous retirement fences late starts');
    assert.equal(f.edits, 0, 'cosmetic terminal admission is best effort at capacity');
  } finally {
    gate.resolve(); await Promise.all(held);
  }
  assert.equal(getPresentationDiagnostics().records, 0);
  assert.equal(getControllerRecord(p.guildId), null);
});

test('bounded native controller callers await actual settlement and preserve message results', async t => {
  for (const [name, call] of [
    ['createOrUpdate', (f, p) => createOrUpdate(f.client, p)],
    ['refresh', (f, p) => refresh(f.client, p)],
    ['showStatus', (f, p) => showStatus(f.client, p, 'recovering', 'Reconnecting.')],
    ['end', (f, p) => end(f.client, p)],
  ]) await t.test(name, async () => {
    const f = fixture(); const p = player(`await-${name}`);
    await createOrUpdate(f.client, p);
    const message = f.messages.get('message-1');
    const gate = deferred(); const entered = deferred();
    message.edit = async () => { entered.resolve(); await gate.promise; return message; };
    let settled = false;
    const operation = call(f, p).then(result => { settled = true; return result; });
    try {
      await entered.promise; await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false);
      assert.ok(getControllerRecord(p.guildId), 'terminal metadata remains until an admitted operation settles');
    } finally { gate.resolve(); }
    assert.equal(await operation, message);
    assert.equal(getControllerRecord(p.guildId) === null, name === 'end');
  });
});

test('refresh preserves recovery and only a started track restores active controls', async () => {
  const f = fixture();
  const p = player('recovering');
  await createOrUpdate(f.client, p);
  await showStatus(f.client, p, 'recovering', 'Reconnecting the audio stream… keeping your queue and track position.');
  await refresh(f.client, p);
  let payload = f.payloads.at(-1);
  assert.equal(payload.embeds[0].data.author.name, 'Recovering audio');
  assert.match(payload.embeds[0].data.description, /Reconnecting the audio stream/);
  const buttons = payload.components.flatMap((row) => row.components);
  assert.equal(buttons.find((button) => button.data.label === 'Pause').data.disabled, true);
  assert.equal(buttons.find((button) => button.data.label === 'Skip').data.disabled, false);
  assert.equal(buttons.find((button) => button.data.label === 'Stop').data.disabled, false);
  assert.doesNotMatch(payload.embeds[0].data.description, /Ends <t:/);
  await createOrUpdate(f.client, p, { state: 'playing' });
  await refresh(f.client, p);
  payload = f.payloads.at(-1);
  assert.equal(payload.embeds[0].data.author.name, 'Now Playing');
  assert.doesNotMatch(payload.embeds[0].data.description, /Reconnecting the audio stream/);
  assert.equal(f.sends, 1);
});

test('first-track recovery creates one visible controller and refresh never resurrects a finished queue', async () => {
  const f = fixture();
  const p = player('initial-recovery');
  await showStatus(f.client, p, 'recovering', 'Waiting for the audio service.');
  assert.equal(f.sends, 1);
  assert.equal(f.payloads.at(-1).embeds[0].data.author.name, 'Recovering audio');
  await createOrUpdate(f.client, p);
  p.queue.current = null;
  await showStatus(f.client, p, 'queue-finished', 'Add something with /play.');
  await refresh(f.client, p);
  const payload = f.payloads.at(-1);
  assert.equal(payload.embeds[0].data.title, 'Queue Finished');
  assert.doesNotMatch(payload.embeds[0].data.description, /Now Playing/);
  assert.ok(payload.components.flatMap((row) => row.components).filter((button) => button.data.custom_id).every((button) => button.data.disabled));
  assert.equal(f.sends, 1);
});

test('native replacement binds a new record and late old-player events cannot change or delete it', async () => {
  const f = nativeFixture('native-replaced');
  const old = f.player;
  await createOrUpdate(f.client, old);
  const original = getControllerRecord(old.guildId);
  f.manager.deletePlayer(old.guildId);
  const current = f.createNative('New session song');
  await createOrUpdate(f.client, current);
  const record = getControllerRecord(old.guildId);
  assert.notEqual(record, original);
  assert.equal(record.player, current);
  const before = f.payloads.length;
  const results = await Promise.all([
    refresh(f.client, old), showStatus(f.client, old, 'recovering', 'Old stream failed'),
    end(f.client, old), createOrUpdate(f.client, old),
  ]);
  assert.deepEqual(results, [null, null, null, null]);
  assert.equal(getControllerRecord(old.guildId), record);
  assert.equal(f.payloads.length, before);
  assert.equal(f.sends, 1, 'an existing controller in the same channel can be reused by the new session');
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'New session song');
});

test('a native new-session controller queued ahead of an old end keeps its ownership and controls', async () => {
  const f = nativeFixture('native-end-order');
  await createOrUpdate(f.client, f.player);
  f.manager.deletePlayer(f.player.guildId);
  const current = f.createNative('Replacement song');
  const creating = createOrUpdate(f.client, current);
  const ending = end(f.client, f.player);
  await Promise.all([creating, ending]);
  assert.equal(getControllerRecord(current.guildId).player, current);
  assert.equal(f.payloads.at(-1).embeds[0].data.author.name, 'Now Playing');
  assert.equal(f.edits, 1);
});

test('queued native starts recheck stopping and destruction markers before creating controls', async t => {
  for (const flag of ['vybertron.stopping', 'internal_destroystatus']) await t.test(flag, async () => {
    const f = nativeFixture(`native-${flag}`);
    const creating = createOrUpdate(f.client, f.player);
    f.player.setData(flag, true);
    assert.equal(await creating, null);
    assert.equal(await showStatus(f.client, f.player, 'recovering', 'Late stream update'), null);
    assert.equal(await refresh(f.client, f.player), null);
    assert.equal(f.sends, 0);
    assert.equal(getControllerRecord(f.player.guildId), null);
  });
});

test('an end marker fences native starts queued before and after end while destruction is pending', async () => {
  const f = nativeFixture('native-late-start');
  const creating = createOrUpdate(f.client, f.player);
  const ending = end(f.client, f.player);
  const lateStart = createOrUpdate(f.client, f.player);
  await Promise.all([creating, ending, lateStart]);
  assert.equal(f.manager.getPlayer(f.player.guildId), f.player, 'the player has not finished destruction yet');
  assert.equal(f.sends, 0);
  assert.equal(await showStatus(f.client, f.player, 'recovering', 'Late reconnect'), null);
  assert.equal(getControllerRecord(f.player.guildId), null);
});

test('ending may disable its own native controller after stopping and removal from the manager', async () => {
  const f = nativeFixture('native-owned-end');
  await createOrUpdate(f.client, f.player);
  f.player.setData('vybertron.stopping', true);
  f.player.setData('internal_destroystatus', true);
  f.manager.deletePlayer(f.player.guildId);
  await end(f.client, f.player, 'Stopped by a listener.');
  assert.equal(f.edits, 1);
  assertEndedControls(f.payloads.at(-1));
  assert.equal(getControllerRecord(f.player.guildId), null);
  assert.equal(await createOrUpdate(f.client, f.player), null);
  assert.equal(f.sends, 1);
});

test('a native refresh waiting on message fetch cannot edit or replace controls after Stop', async () => {
  const f = nativeFixture('native-fetch-stop');
  await createOrUpdate(f.client, f.player);
  const fetched = deferred(); const entered = deferred();
  let reads = 0;
  f.channel.messages.fetch = async id => {
    if (++reads === 1) { entered.resolve(); return fetched.promise; }
    return f.messages.get(id) || null;
  };
  const refreshing = refresh(f.client, f.player);
  await entered.promise;
  f.player.setData('vybertron.stopping', true);
  const ending = end(f.client, f.player);
  fetched.resolve(f.messages.get('message-1'));
  assert.equal(await refreshing, null);
  await ending;
  assert.equal(f.sends, 1);
  assert.equal(f.edits, 1, 'only the terminal edit is allowed');
  assertEndedControls(f.payloads.at(-1));
  assert.equal(getControllerRecord(f.player.guildId), null);
});

test('a native first controller waiting for channel fetch cannot send after end', async () => {
  const f = nativeFixture('native-channel-stop');
  f.client.channels.cache.clear();
  const fetched = deferred(); const entered = deferred();
  f.client.channels.fetch = async () => { entered.resolve(); return fetched.promise; };
  const creating = createOrUpdate(f.client, f.player);
  await entered.promise;
  const ending = end(f.client, f.player);
  fetched.resolve(f.channel);
  assert.equal(await creating, null);
  await ending;
  assert.equal(f.sends, 0);
  assert.equal(getControllerRecord(f.player.guildId), null);
});

test('a native edit failing after Stop cannot fall back to sending a fresh active controller', async () => {
  const f = nativeFixture('native-edit-stop');
  await createOrUpdate(f.client, f.player);
  const edited = deferred(); const entered = deferred();
  let attempts = 0;
  f.messages.get('message-1').edit = async () => {
    if (++attempts === 1) { entered.resolve(); return edited.promise; }
    throw new Error('Unknown Message');
  };
  const refreshing = refresh(f.client, f.player);
  await entered.promise;
  f.player.setData('vybertron.stopping', true);
  const ending = end(f.client, f.player);
  edited.reject(new Error('Unknown Message'));
  assert.equal(await refreshing, null);
  await ending;
  assert.equal(f.sends, 1);
  assert.equal(getControllerRecord(f.player.guildId), null);
});

test('a held edit coalesces a refresh burst into one latest paused track render', async () => {
  const f = fixture(); const p = player('burst');
  await createOrUpdate(f.client, p);
  const gate = deferred(); const entered = deferred();
  const message = f.messages.get('message-1'); const edit = message.edit;
  let calls = 0;
  message.edit = async payload => { if (++calls === 1) { entered.resolve(); await gate.promise; } return edit(payload); };
  const first = refresh(f.client, p); await entered.promise;
  const pending = Array.from({ length: 12 }, () => refresh(f.client, p));
  p.paused = true; p.queue.current = track('Latest song');
  assert.equal(calls, 1);
  gate.resolve(); await Promise.all([first, ...pending]);
  assert.equal(calls, 2);
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'Latest song');
  assert.equal(f.payloads.at(-1).embeds[0].data.author.name, 'Paused');
});

test('payload derives current recovery state after held lookup', async () => {
  const f = fixture(); const p = player('latest-after-lookup');
  await createOrUpdate(f.client, p);
  const gate = deferred(); const entered = deferred(); let calls = 0;
  f.channel.messages.fetch = async id => { if (++calls === 1) { entered.resolve(); await gate.promise; } return f.messages.get(id); };
  const updating = refresh(f.client, p); await entered.promise;
  const recovering = showStatus(f.client, p, 'unavailable', 'Audio unavailable.');
  p.queue.current = null;
  gate.resolve(); await Promise.all([updating, recovering]);
  assert.ok(f.payloads.slice(1).every(payload => payload.embeds[0].data.author.name === 'Playback Unavailable'));
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'one', 'unavailable keeps the last-track fallback');
});

test('a submitted old edit settles before terminal controls and never gets a late active follow-up', async () => {
  const f = nativeFixture('submitted-stop');
  await createOrUpdate(f.client, f.player);
  const gate = deferred(); const entered = deferred();
  const message = f.messages.get('message-1'); const edit = message.edit;
  let calls = 0;
  message.edit = async payload => { if (++calls === 1) { entered.resolve(); await gate.promise; } return edit(payload); };
  const updating = refresh(f.client, f.player); await entered.promise;
  f.player.setData('vybertron.stopping', true);
  const ending = end(f.client, f.player);
  assert.equal(await refresh(f.client, f.player), null);
  assert.equal(calls, 1);
  gate.resolve(); await Promise.all([updating, ending]);
  assert.equal(calls, 2); assertEndedControls(f.payloads.at(-1));
});

test('same-channel replacement adopts a submitted old send after settlement', async () => {
  const f = nativeFixture('submitted-send');
  const gate = deferred(); const entered = deferred();
  const send = f.channel.send;
  f.channel.send = async payload => { entered.resolve(); await gate.promise; return send(payload); };
  const creating = createOrUpdate(f.client, f.player); await entered.promise;
  f.manager.deletePlayer(f.player.guildId);
  const replacement = f.createNative('Replacement after send');
  const replacing = createOrUpdate(f.client, replacement);
  const ending = end(f.client, f.player);
  gate.resolve(); await Promise.all([creating, replacing, ending]);
  assert.equal(f.sends, 1); assert.equal(f.edits, 1);
  assert.equal(getControllerRecord(replacement.guildId).player, replacement);
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'Replacement after send');
});

test('different-channel replacement retires the old controller after its held lookup and owns the new render', async () => {
  const f = nativeFixture('replacement-other-channel');
  await createOrUpdate(f.client, f.player);
  const gate = deferred(); const entered = deferred(); let reads = 0;
  f.channel.messages.fetch = async id => { if (++reads === 1) { entered.resolve(); await gate.promise; } return f.messages.get(id); };
  const updating = refresh(f.client, f.player); await entered.promise;
  f.player.setData('vybertron.stopping', true);
  const ending = end(f.client, f.player);
  f.manager.deletePlayer(f.player.guildId);
  const current = f.createNative('New channel song'); current.textChannelId = 'other-channel';
  f.client.channels.cache.set('other-channel', { messages: f.channel.messages, send: f.channel.send });
  const replacing = createOrUpdate(f.client, current);
  gate.resolve(); await Promise.all([updating, ending, replacing]);
  assert.equal(f.sends, 2); assert.equal(f.edits, 1);
  assertEndedControls(f.payloads[1]);
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'New channel song');
  assert.equal(getControllerRecord(current.guildId).player, current);
  assert.equal(getControllerRecord(current.guildId).previous, null);
});

test('a held terminal edit cannot delete a same-channel replacement that follows it', async () => {
  const f = nativeFixture('terminal-replacement');
  await createOrUpdate(f.client, f.player);
  const gate = deferred(); const entered = deferred(); let writes = 0;
  const message = f.messages.get('message-1'); const edit = message.edit;
  message.edit = async payload => { if (++writes === 1) { entered.resolve(); await gate.promise; } return edit(payload); };
  const ending = end(f.client, f.player); await entered.promise;
  f.manager.deletePlayer(f.player.guildId);
  const current = f.createNative('After terminal');
  const replacing = createOrUpdate(f.client, current);
  assert.equal(writes, 1);
  gate.resolve(); await Promise.all([ending, replacing]);
  assert.equal(writes, 2);
  assert.equal(getControllerRecord(current.guildId).player, current);
  assert.equal(f.payloads.at(-1).embeds[0].data.title, 'After terminal');
});
