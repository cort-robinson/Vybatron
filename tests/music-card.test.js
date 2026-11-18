import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { loadCommands } from '../src/commands/index.js';
import { radioState } from '../src/utils/radio.js';
import { trackReference } from '../src/utils/library.js';
import { portalFixture } from './portal-fixtures.js';
import { track } from './fixtures.js';

let interactionNumber = 0;

async function discord(t, options = {}) {
  const f = await portalFixture(t, { idle: true, ...options });
  f.guild.voiceStates = { cache: new Map([...f.members].map(([id, member]) => [id, { channelId: member.voice.channel.id, member }])) };
  f.client.user = { id: '999', bot: true };
  await loadCommands(f.client);
  const dispatch = f.client.listeners('interactionCreate')[0];
  const posts = [];
  const channel = { send: async payload => posts.push(payload) };
  async function use(id, { kind = 'button', actor = '200', query, value } = {}) {
    let result;
    const interaction = {
      id: String(++interactionNumber), client: f.client, guild: f.guild, guildId: f.guild.id, channelId: '400', channel,
      member: f.members.get(actor), user: f.users.get(actor),
      customId: id, values: [value], fields: { getTextInputValue: () => query },
      commandName: kind === 'slash' ? 'settings' : undefined, options: { getSubcommand: () => 'startcard' },
      isAutocomplete: () => false, isModalSubmit: () => kind === 'modal', isMessageComponent: () => ['button', 'select'].includes(kind),
      isChatInputCommand: () => kind === 'slash', isButton: () => kind === 'button', isStringSelectMenu: () => kind === 'select',
      deferUpdate() { this.deferred = true; },
      deferReply(payload) { this.deferred = true; this.ephemeral = payload.flags === MessageFlags.Ephemeral; },
      reply(payload) { assert.ok(!this.deferred); this.replied = true; result = payload; },
      editReply(payload) { assert.ok(this.deferred); result = payload; },
      followUp(payload) { result = payload; },
      showModal(modal) { assert.ok(!this.deferred); result = modal.toJSON(); },
    };
    await dispatch(interaction);
    return { result, interaction };
  }
  return { ...f, posts, use };
}

test('a manager posts a reusable card and a listener can privately choose and queue a specific recording', async t => {
  const f = await discord(t, { idle: false, search: () => ({ loadType: 'search', tracks: [track('firstresult'), track('nextversion')] }) });
  await f.use(null, { kind: 'slash' });
  assert.equal(f.posts.length, 0);
  await f.use(null, { kind: 'slash', actor: '201' });
  const [add, mix] = f.posts[0].components[0].toJSON().components;
  assert.equal(mix.label, 'Play our mix');
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  const { result: modal } = await f.use(add.custom_id);
  const { result: choices, interaction } = await f.use(modal.custom_id, { kind: 'modal', query: 'find both versions' });
  assert.equal(interaction.ephemeral, true);
  const menu = choices.components[0].toJSON().components[0];
  assert.equal(menu.options.length, 2);
  const pick = { kind: 'select', value: menu.options[1].value };
  assert.match((await f.use(menu.custom_id, { ...pick, actor: '201' })).result.content, /your own recording/);
  const size = f.player.queue.tracks.length;
  const [{ result: added }, duplicate] = await Promise.all([f.use(menu.custom_id, pick), f.use(menu.custom_id, pick)]);
  assert.match(duplicate.result.content, /already used|expired/);
  assert.equal(f.player.queue.tracks.length, size + 1);
  assert.equal(f.player.queue.tracks.at(-1).info.identifier, 'nextversion');
  assert.match(added.content, /Plays after.*01234567890/);
  assert.equal(radioState(f.player).enabled, false);
  assert.match((await f.use('music:v1:mix')).result.content, /DJ role/);
});

test('an empty-history mix asks for a starting song, rechecks voice and preserves an active session', async t => {
  const f = await discord(t);
  const { result: modal } = await f.use('music:v1:mix');
  assert.equal(modal.title, 'Choose a starting song');
  const seed = { kind: 'modal', query: 'https://www.youtube.com/watch?v=openingsong' };
  f.members.get('200').voice.channel = f.channels.get('301');
  assert.match((await f.use(modal.custom_id, seed)).result.content, /voice session changed/);
  assert.equal(f.manager.getPlayer('100'), undefined);
  f.members.get('200').voice.channel = f.channels.get('300');
  const { result } = await f.use(modal.custom_id, seed);
  assert.match(result.content, /Starting.*openingsong.*Autoplay/);
  const player = f.manager.getPlayer('100');
  assert.equal(player.queue.current.info.identifier, 'openingsong');
  assert.equal(radioState(player).enabled, true);
  assert.match((await f.use('music:v1:mix')).result.content, /already going/);
  assert.equal(player.queue.tracks.length, 0);
});

test('one tap starts a mix from history visible to the whole room and privately acknowledges the public card', async t => {
  const f = await discord(t);
  const channelsRead = [];
  f.channels.get('301').hidden.add('201');
  f.client.stats = {
    available: true, voiceChannelIds: () => ['300', '301'],
    serverFavorites(guildId, { visibleChannelIds }) {
      channelsRead.push(visibleChannelIds);
      return { onRepeat: [{ track: trackReference(track('onrepeat123')) }] };
    },
  };
  const { result, interaction } = await f.use('music:v1:mix');
  assert.equal(interaction.ephemeral, true);
  assert.match(result.content, /Starting.*onrepeat123.*Autoplay/);
  assert.ok(channelsRead.length >= 2);
  assert.ok(channelsRead.every(ids => ids.length === 1 && ids[0] === '300'));
  assert.equal(radioState(f.manager.getPlayer('100')).enabled, true);
});

test('the More menu routes shared controls through the same DJ check and Stop confirmation', async t => {
  const f = await discord(t, { idle: false });
  await f.library.updateGuild('100', guild => { guild.settings.djRoleId = '500'; });
  const item = { kind: 'select', value: 'stop' };
  assert.match((await f.use('player:v1:more', item)).result.content, /DJ role/);
  assert.match((await f.use('player:v1:more', { ...item, actor: '201' })).result.content, /Stop playback, clear/);
  assert.equal(f.player.playing, true);
});

test('an unresolved room member keeps private history out of the opening song', async t => {
  const f = await discord(t);
  f.guild.voiceStates.cache.set('404', { channelId: '300', member: null });
  f.client.stats = { available: true, voiceChannelIds: () => ['301'], serverFavorites() { assert.fail('unknown audience'); } };
  assert.equal((await f.use('music:v1:mix')).result.title, 'Choose a starting song');
});

test('a full voice channel accepts requests when the bot already occupies a slot and can still speak', async t => {
  const f = await discord(t, { idle: false });
  const voice = f.channels.get('300');
  Object.assign(voice, { full: true, joinable: false, viewable: true });
  const { result: modal } = await f.use('music:v1:add');
  assert.equal(modal.title, 'Add a song');
  const request = { kind: 'modal', query: 'https://www.youtube.com/watch?v=openingsong' };
  assert.match((await f.use(modal.custom_id, request)).result.content, /Added.*openingsong/);
  voice.speakable = false;
  assert.match((await f.use('music:v1:add')).result.content, /Speak permission/);
  f.player.connected = false;
  assert.match((await f.use('music:v1:add')).result.content, /can’t join/);
});
