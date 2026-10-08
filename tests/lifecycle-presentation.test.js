import test from 'node:test';
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { loadCommands } from '../src/commands/index.js';
import { maintenanceStatus } from '../src/utils/maintenance.js';
import { createOrUpdate, refresh, clearController } from '../src/utils/player-controller.js';
import { updateVoiceStatus, resetVoiceStatusWarnings } from '../src/utils/voice-status.js';
import { submitPresentationWrite, getPresentationDiagnostics } from '../src/utils/presentation-updates.js';
import { handleVoiceStateUpdate, handlePlayerDestroy, clearIdleTimer } from '../src/lavalink.js';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('Gateway and terminal lifecycle storms retain no completion waiters behind stalled cosmetic writes', { timeout: 5000 }, async () => {
  const release = deferred(), edited = deferred(), statusStarted = deferred();
  const resources = new WeakMap(), completionIds = new Set(); let retainedReactions = 0;
  const hook = createHook({ init(id, type, trigger, resource) {
    if (type !== 'PROMISE') return;
    resources.set(resource, id);
    if (completionIds.has(trigger)) retainedReactions++;
  } });
  hook.enable();
  const guildId = 'lifecycle-waiter-stress';
  const player = { guildId, textChannelId: 'text', voiceChannelId: 'voice', paused: false,
    queue: { current: { info: { title: 'Held song', author: 'Artist' } }, tracks: [] }, getData: () => false };
  const message = { id: 'held-message', async edit() { edited.resolve(); await release.promise; return message; } };
  const voice = { permissionsFor: () => ({ has: () => true }), members: { filter: () => ({ size: 1 }) } };
  const channels = new Map([
    ['text', { send: async () => message, messages: { fetch: async () => message } }], ['voice', voice],
  ]);
  const client = { user: { id: 'bot' }, channels: { cache: channels }, lavalink: { getPlayer: () => player },
    rest: { async put() { statusStarted.resolve(); await release.promise; } } };
  let controller, status;
  try {
    await createOrUpdate(client, player);
    controller = refresh(client, player); status = updateVoiceStatus(client, player);
    await Promise.race([Promise.all([edited.promise, statusStarted.promise]),
      new Promise((_, reject) => setTimeout(() => reject(Error('fixture writers did not start')), 1000))]);
    const controllerCompletion = submitPresentationWrite(`controller:${guildId}`, () => null);
    const voiceCompletion = submitPresentationWrite(`voice:${guildId}`, () => null);
    completionIds.add(resources.get(controllerCompletion)); completionIds.add(resources.get(voiceCompletion));
    assert.ok(!completionIds.has(undefined), 'capture actual scheduler promise resources');
    const oldState = { guild: { id: guildId, channels: { cache: channels } } };
    for (let n = 0; n < 1000; n++) handleVoiceStateUpdate(client, oldState);
    for (let n = 0; n < 1000; n++) handlePlayerDestroy(client, player);
    assert.equal(retainedReactions, 0, 'discarded lifecycle submissions must not subscribe to held completion');
    assert.equal(getPresentationDiagnostics().records, 2);
  } finally {
    hook.disable(); release.resolve();
    await Promise.all([controller, status]);
    clearIdleTimer(guildId); clearController(guildId); resetVoiceStatusWarnings();
  }
});

test('urgent native radio-off finishes behind stalled cosmetics without completion waiters or maintenance leases', { timeout: 5000 }, async () => {
  const release = deferred(), edited = deferred();
  const resources = new WeakMap(); let completionId, retainedReactions = 0, acknowledged = 0, replied = 0;
  const hook = createHook({ init(id, type, trigger, resource) {
    if (type !== 'PROMISE') return;
    resources.set(resource, id);
    if (completionId !== undefined && trigger === completionId) retainedReactions++;
  } });
  hook.enable();
  const guildId = 'urgent-radio-waiter-stress', data = new Map();
  const player = { guildId, textChannelId: 'text', voiceChannelId: 'voice',
    queue: { current: { info: { title: 'Song', author: 'Artist' } }, tracks: [] },
    getData: key => data.get(key), setData: (key, value) => data.set(key, value) };
  let edits = 0;
  const message = { id: 'controller', async edit() { edits++; edited.resolve(); await release.promise; return message; } };
  const client = Object.assign(new EventEmitter(), {
    lavalink: { getPlayer: () => player },
    channels: { cache: new Map([['text', { send: async () => message, messages: { fetch: async () => message } }]]) },
  });
  let held, completion; const calls = [];
  try {
    await loadCommands(client);
    await createOrUpdate(client, player);
    held = refresh(client, player);
    await edited.promise;
    completion = submitPresentationWrite(`controller:${guildId}`, () => null);
    completionId = resources.get(completion);
    assert.notEqual(completionId, undefined);
    const dispatch = client.listeners('interactionCreate')[0];
    for (let n = 0; n < 1000; n++) calls.push(dispatch({
      client, guildId, commandName: 'radio', user: { id: 'listener' },
      member: { voice: { channel: { id: 'voice' } } },
      options: { getSubcommand: () => 'off' },
      isAutocomplete: () => false, isMessageComponent: () => false,
      isModalSubmit: () => false, isChatInputCommand: () => true,
      async deferReply() { this.deferred = true; acknowledged++; },
      async editReply(payload) { replied++; assert.match(payload.content, /Autoplay is off/); },
      async reply() { assert.fail('urgent command must acknowledge before execution'); },
    }));
    await Promise.all(calls);
    assert.equal(acknowledged, 1000);
    assert.equal(replied, 1000);
    assert.equal(retainedReactions, 0);
    assert.equal(maintenanceStatus(client).inFlight, 0);
    assert.equal(edits, 1);
    assert.equal(getPresentationDiagnostics().records, 1);
  } finally {
    hook.disable(); release.resolve();
    await Promise.all([held, completion, ...calls]);
    clearController(guildId);
  }
  assert.equal(edits, 2);
  assert.equal(getPresentationDiagnostics().records, 0);
});

test('native Refresh dispatcher storms acknowledge without retaining stalled controller completion', { timeout: 5000 }, async () => {
  const release = deferred(), edited = deferred();
  const resources = new WeakMap(); let completionId, retainedReactions = 0, acknowledged = 0;
  const hook = createHook({ init(id, type, trigger, resource) {
    if (type !== 'PROMISE') return;
    resources.set(resource, id);
    if (completionId !== undefined && trigger === completionId) retainedReactions++;
  } });
  hook.enable();
  const guildId = 'native-refresh-waiter-stress';
  const player = { guildId, textChannelId: 'text', voiceChannelId: 'voice',
    queue: { current: { info: { title: 'Song', author: 'Artist' } }, tracks: [] }, getData: () => false };
  let edits = 0;
  const message = { id: 'controller', async edit() { edits++; edited.resolve(); await release.promise; return message; } };
  const client = Object.assign(new EventEmitter(), {
    lavalink: { getPlayer: () => player },
    channels: { cache: new Map([['text', { send: async () => message, messages: { fetch: async () => message } }]]) },
  });
  let held, completion; const calls = [];
  try {
    await loadCommands(client);
    await createOrUpdate(client, player);
    held = refresh(client, player);
    await edited.promise;
    completion = submitPresentationWrite(`controller:${guildId}`, () => null);
    completionId = resources.get(completion);
    assert.notEqual(completionId, undefined);
    const dispatch = client.listeners('interactionCreate')[0];
    for (let n = 0; n < 1000; n++) calls.push(dispatch({
      client, guildId, customId: 'player:v1:refresh', message,
      isAutocomplete: () => false, isMessageComponent: () => true,
      async deferUpdate() { acknowledged++; },
      async followUp() { assert.fail('Refresh should not fail'); },
      async reply() { assert.fail('current controller should remain valid'); },
    }));
    await Promise.all(calls);
    assert.equal(acknowledged, 1000);
    assert.equal(retainedReactions, 0);
    assert.equal(edits, 1, 'held edit serializes all later refresh intents');
    assert.equal(getPresentationDiagnostics().records, 1);
  } finally {
    hook.disable(); release.resolve();
    await Promise.all([held, completion, ...calls]);
    clearController(guildId);
  }
  assert.equal(edits, 2, 'only the latest submitted Refresh renders after settlement');
  assert.equal(getPresentationDiagnostics().records, 0);
});
