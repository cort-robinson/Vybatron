import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createOrUpdate, resetControllers } from '../src/utils/player-controller.js';
import { resetVoiceStatusWarnings } from '../src/utils/voice-status.js';
import { resetPresentationUpdates, presentationWritePending } from '../src/utils/presentation-updates.js';
import { guardedMutation, commandMutationPolicy, componentMutationPolicy } from '../src/utils/requests.js';
import { handleMessageComponent, handleModalSubmit } from '../src/utils/components.js';
import { trackIdentity } from '../src/utils/presentation.js';
import { execute as pause } from '../src/commands/pause.js';
import { execute as resume } from '../src/commands/resume.js';
import { execute as loop } from '../src/commands/loop.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled() {
  for (let i = 0; i < 200 && (presentationWritePending('controller:100') || presentationWritePending('voice:100')); i++) await tick();
}
test.afterEach(async () => { await settled(); resetControllers(); resetVoiceStatusWarnings(); resetPresentationUpdates(); });

// Discord's controller edit and voice-status PUT are held open by gates so the
// test controls exactly when each REST call finishes.
function heldDiscord(f) {
  const edits = []; const statuses = [];
  let editGate = deferred(); let statusGate = deferred();
  const message = { id: 'controller', async edit(payload) { edits.push(payload); await editGate.promise; return message; } };
  const channel = f.channels.get('400');
  channel.send = async () => message;
  channel.messages = { fetch: async () => message };
  f.client.rest = { ...f.client.rest, async put(route, payload) { statuses.push(payload.body.status); await statusGate.promise; } };
  f.client.channels.cache.get('300').permissionsFor = () => ({ has: () => true });
  return {
    edits, statuses,
    hold() { editGate = deferred(); statusGate = deferred(); },
    release() { editGate.resolve(); statusGate.resolve(); },
  };
}

// A native slash command or button as the dispatcher sees it.
function native(f, { commandName, customId, options = {}, ack, channelId = '400' } = {}) {
  const replies = [];
  const interaction = {
    client: f.client, guildId: '100', guild: f.guild, channelId,
    member: f.members.get('200'), user: f.users.get('200'), commandName, customId,
    deferred: false, replied: false,
    options: { getSubcommand: () => null, getString: name => options[name] ?? null, getInteger: name => options[name] ?? null },
    isMessageComponent: () => Boolean(customId), isModalSubmit: () => false, isButton: () => Boolean(customId),
    async deferReply() { await ack?.(); this.deferred = true; },
    async deferUpdate() { await ack?.(); this.deferred = true; },
    async reply(payload) { replies.push(payload); this.replied = true; },
    async editReply(payload) { replies.push(payload); },
    async followUp(payload) { replies.push(payload); },
  };
  return { interaction, replies };
}

const slash = (f, execute, commandName, extra) => {
  const { interaction, replies } = native(f, { commandName, ...extra });
  return { replies, done: guardedMutation(interaction, execute, commandMutationPolicy(commandName, null)) };
};
const button = (f, customId, extra) => {
  const { interaction, replies } = native(f, { customId, ...extra });
  return { replies, done: guardedMutation(interaction, handleMessageComponent, componentMutationPolicy(customId)) };
};
const author = payload => payload.embeds[0].data.author.name;

test('native Pause replies before a slow controller edit and voice-status write finish', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled(); d.hold();
  const before = d.edits.length;

  const { replies, done } = slash(f, pause, 'pause');
  await done;
  assert.equal(f.player.paused, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0].content ?? replies[0].embeds?.[0]?.data?.description ?? '', /paused/i);
  assert.equal(presentationWritePending('controller:100'), true, 'the controller edit is still in flight after the reply');

  d.release(); await settled();
  assert.equal(d.edits.length, before + 1);
  assert.equal(author(d.edits.at(-1)), 'Paused');
  assert.equal(d.statuses.length, 1);
});

test('quick Pause then Resume while the first edit is held leave the controller showing the final state', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled(); d.hold();
  const before = d.edits.length;

  await slash(f, pause, 'pause').done;
  await tick();
  assert.equal(author(d.edits.at(-1)), 'Paused', 'the first edit has started and is held');
  // Resume does not wait for the held Paused edit, and its reply is sent.
  const second = slash(f, resume, 'resume');
  await second.done;
  assert.equal(f.player.paused, false);
  assert.equal(second.replies.length, 1);
  // A third control in the same burst collapses with the second render.
  await slash(f, loop, 'loop', { options: { mode: 'track' } }).done;
  assert.equal(f.player.repeatMode, 'track');

  d.release(); await settled();
  assert.equal(d.edits.length, before + 2, 'held edit plus one collapsed latest render');
  assert.equal(author(d.edits.at(-1)), 'Now Playing');
  assert.match(JSON.stringify(d.edits.at(-1)), /track/i);
  assert.match(d.statuses.at(-1), /^🎵/, 'voice status ends on the playing state');
});

test('player buttons release the guild lane before their controller edit settles', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled(); d.hold();
  const before = d.edits.length;

  await button(f, 'player:v1:toggle').done;
  assert.equal(f.player.paused, true);
  await button(f, 'player:v1:toggle').done;
  assert.equal(f.player.paused, false, 'the second press ran while the first edit was still held');
  await button(f, 'player:v1:loop').done;
  await button(f, 'player:v1:shuffle').done;

  d.release(); await settled();
  assert.ok(d.edits.length <= before + 2, 'held edits collapse to the latest render');
  assert.equal(author(d.edits.at(-1)), 'Now Playing');
  assert.notEqual(f.player.repeatMode, 'off');
});

test('a failed acknowledgement still stops the control before it changes playback', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  heldDiscord(f).release();
  const expired = Object.assign(new Error('Unknown interaction'), { code: 10062 });
  const { done } = slash(f, pause, 'pause', { ack: async () => { throw expired; } });
  await assert.rejects(done, /Unknown interaction/);
  assert.equal(f.player.paused, false);
  assert.equal(f.calls.includes('pause'), false);
  const press = button(f, 'player:v1:skip', { ack: async () => { throw expired; } });
  await assert.rejects(press.done, /Unknown interaction/);
  assert.equal(f.calls.includes('skip'), false);
});

test('the acknowledgement is sent before the control runs', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  heldDiscord(f).release();
  const order = [];
  const ackGate = deferred();
  f.player.pause = async () => { order.push('pause'); f.player.paused = true; };
  const { done } = slash(f, pause, 'pause', { ack: async () => { order.push('ack'); await ackGate.promise; order.push('acked'); } });
  await tick();
  assert.deepEqual(order, ['ack']);
  ackGate.resolve(); await done;
  assert.deepEqual(order, ['ack', 'acked', 'pause']);
});

test('a reply from another channel links to the replacement of a deleted controller', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled();

  // The controller message was deleted in Discord; the refresh must send a new one.
  const sendGate = deferred();
  const replacement = { id: 'replacement', async edit() { return replacement; } };
  const channel = f.channels.get('400');
  channel.messages = { fetch: async id => (id === 'replacement' ? replacement : null) };
  channel.send = async () => { await sendGate.promise; return replacement; };

  const { replies, done } = slash(f, pause, 'pause', { channelId: '401' });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(replies.length, 0, 'the reply waits for the replacement controller');
  sendGate.resolve(); await done;
  assert.equal(f.player.paused, true);
  const text = replies[0].content ?? JSON.stringify(replies[0]);
  assert.match(text, /Open player: \S+\/400\/replacement/);
  assert.doesNotMatch(text, /\/controller\b/);
});

test('a reply from another channel stops waiting for a controller edit that never settles, and drops the link', { timeout: 8000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled(); d.hold();

  const first = slash(f, pause, 'pause', { channelId: '401' });
  await first.done;
  assert.equal(f.player.paused, true);
  const text = first.replies[0].content ?? JSON.stringify(first.replies[0]);
  assert.match(text, /paused/i);
  assert.doesNotMatch(text, /Open player/, 'an unconfirmed controller link is left out');
  assert.equal(presentationWritePending('controller:100'), true, 'the edit is still held');
  // The guild lane is free again: the next control runs while the edit is still held.
  const second = slash(f, resume, 'resume');
  await second.done;
  assert.equal(f.player.paused, false);

  d.release(); await settled();
  assert.equal(author(d.edits.at(-1)), 'Now Playing');
});

test('Seek from the controller channel replies without a link to a controller that may be mid-replacement', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled(); d.hold();

  const { interaction, replies } = native(f, { customId: `player:v1:seek-submit:${trackIdentity(f.player.queue.current)}` });
  interaction.isModalSubmit = () => true;
  interaction.fields = { getTextInputValue: () => '0:05' };
  await guardedMutation(interaction, handleModalSubmit, componentMutationPolicy(interaction.customId));
  const text = replies.at(-1).content ?? JSON.stringify(replies.at(-1));
  assert.match(text, /Jumped to/);
  assert.doesNotMatch(text, /Open player/);
  d.release(); await settled();
});

test('a reply from another channel drops the link when the deleted controller cannot be replaced', { timeout: 3000 }, async t => {
  const f = await portalFixture(t);
  const d = heldDiscord(f);
  await createOrUpdate(f.client, f.player).catch(() => {});
  d.release(); await settled();

  // The controller was deleted and the bot can no longer send its replacement.
  const channel = f.channels.get('400');
  channel.messages = { fetch: async () => null };
  channel.send = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };

  const { replies, done } = slash(f, pause, 'pause', { channelId: '401' });
  await done;
  assert.equal(f.player.paused, true);
  const text = replies[0].content ?? JSON.stringify(replies[0]);
  assert.match(text, /paused/i);
  assert.doesNotMatch(text, /Open player/, 'no link to the deleted controller');
});
