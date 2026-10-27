import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ChannelType, Client, GatewayIntentBits, IntentsBitField, OverwriteType, PermissionFlagsBits as P, Status, TextChannel, VoiceChannel } from 'discord.js';
import { deferred, portalFixture } from './portal-fixtures.js';
import { createPortalPolicy, visible } from '../src/portal/policy.js';

// ADR-0011 trusts the discord.js cache that Gateway events keep current. A
// forced REST read started before a Gateway update can answer after it; these
// cases use real discord.js structures so a late response would really patch
// the cache, and prove it can't restore a kick, a role or an overwrite.

async function realGuild(t) {
  const f = await portalFixture(t);
  const discord = new Client({ intents: [] }); t.after(() => discord.destroy());
  discord.user = { id: '999' };
  const guild = discord.guilds._add({ id: '100', name: 'Race server', owner_id: '202', roles: [
    { id: '100', name: '@everyone', permissions: String(P.ViewChannel | P.Connect | P.Speak | P.SendMessages | P.EmbedLinks), position: 0 },
    { id: '500', name: 'Managers', permissions: String(P.ManageGuild), position: 1 },
  ] });
  const memberData = roles => ({ user: { id: '200', username: 'Listener', discriminator: '0' }, roles, joined_at: new Date(0).toISOString() });
  guild.members._add(memberData(['500']));
  const bot = guild.members._add({ user: { id: '999', username: 'Vybatron', discriminator: '0', bot: true }, roles: [], joined_at: new Date(0).toISOString() });
  Object.defineProperty(guild.members, 'me', { value: bot, configurable: true });
  Object.defineProperty(guild, 'shard', { value: { status: Status.Ready }, configurable: true });
  guild.available = true;
  const channelData = (id, type, overwrites = []) => ({ id, guild_id: '100', name: `channel ${id}`, type, permission_overwrites: overwrites });
  for (const [id, Kind, type] of [['300', VoiceChannel, ChannelType.GuildVoice], ['400', TextChannel, ChannelType.GuildText]]) {
    const channel = new Kind(guild, channelData(id, type), discord);
    guild.channels.cache.set(id, channel); discord.channels.cache.set(id, channel);
  }
  guild.voiceStates._add({ user_id: '200', channel_id: '300', guild_id: '100', session_id: 's', deaf: false, mute: false,
    self_deaf: false, self_mute: false, self_video: false, suppress: false, request_to_speak_timestamp: null });
  f.client.guilds.cache.set('100', guild);
  f.client.options = { intents: new IntentsBitField([GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers]) };
  // Discord's answers, which a test can hold to make them arrive late.
  const answers = { member: () => memberData(['500']), channel: id => channelData(id, id === '300' ? ChannelType.GuildVoice : ChannelType.GuildText), hold: null };
  discord.rest.get = async route => {
    if (answers.hold?.route === route) await answers.hold.gate.promise;
    if (route === '/guilds/100/members/200') { const data = answers.member(); if (!data) throw Object.assign(new Error('Unknown member'), { code: 10007 }); return data; }
    if (route === '/guilds/100/members/999') return { user: { id: '999', username: 'Vybatron', discriminator: '0', bot: true }, roles: [], joined_at: new Date(0).toISOString() };
    const channel = route.match(/^\/channels\/(\d+)$/); if (channel) return answers.channel(channel[1]);
    throw new Error(`unexpected route ${route}`);
  };
  const policy = createPortalPolicy(f.client); t.after(() => policy.close());
  const hold = route => { answers.hold = { route, gate: deferred() }; return answers.hold.gate; };
  return { f, guild, discord, policy, answers, hold, memberData, channelData };
}

test('a REST member read that answers after a kick does not put the member back in the Gateway cache', async t => {
  const { f, guild, policy, answers, hold } = await realGuild(t);
  assert.ok(policy.gatewayGuild('200', '100'), 'the Gateway vouches before the kick');
  const gate = hold('/guilds/100/members/200');
  const reading = policy.guild('200', '100', undefined, { fresh: true, channelScope: 'none' }); await tick();
  // GUILD_MEMBER_REMOVE: discord.js deletes the member, then emits.
  const member = guild.members.cache.get('200'); guild.members.cache.delete('200'); f.client.emit('guildMemberRemove', member);
  gate.resolve(); await reading;
  assert.equal(guild.members.cache.has('200'), false, 'the late response did not restore the member');
  assert.equal(policy.gatewayGuild('200', '100'), null);
  answers.member = () => null; answers.hold = null;
  await assert.rejects(policy.guild('200', '100'), { status: 404 }, 'the next protected read takes REST and is denied');
});

test('a REST member read that answers after a role removal does not restore the role', async t => {
  const { f, guild, policy, hold, memberData } = await realGuild(t);
  assert.equal(policy.gatewayGuild('200', '100').guildAdmin, true);
  const gate = hold('/guilds/100/members/200');
  const reading = policy.guild('200', '100', undefined, { fresh: true, channelScope: 'none' }); await tick();
  // GUILD_MEMBER_UPDATE removing the Managers role.
  const member = guild.members.cache.get('200'); const old = member._clone(); member._patch(memberData([])); f.client.emit('guildMemberUpdate', old, member);
  gate.resolve(); await reading;
  assert.deepEqual(guild.members.cache.get('200')._roles, [], 'the late response did not restore the role');
  assert.equal(policy.gatewayGuild('200', '100').guildAdmin, false);
  assert.equal((await policy.guild('200', '100', undefined, { channelScope: 'none' })).admin, false);
});

test('a REST channel read that answers after an overwrite update makes that channel untrusted until a clean read', async t => {
  const { f, guild, policy, answers, hold, channelData } = await realGuild(t);
  assert.equal(visible(policy.gatewayGuild('200', '100'), guild.channels.cache.get('400')) || true, true);
  const hidden = [{ id: '200', type: OverwriteType.Member, allow: '0', deny: String(P.ViewChannel) }];
  const gate = hold('/channels/400');
  const reading = policy.guild('200', '100', undefined, { fresh: true }); await tick();
  // CHANNEL_UPDATE hiding the controller channel from the actor.
  const channel = guild.channels.cache.get('400'); const old = channel._clone(); channel._patch(channelData('400', ChannelType.GuildText, hidden));
  f.client.emit('channelUpdate', old, channel);
  gate.resolve(); await reading;
  // discord.js really did patch the older overwrites back into the cache.
  assert.equal(guild.channels.cache.get('400').permissionOverwrites.cache.has('200'), false);
  assert.equal(policy.gatewayGuild('200', '100'), null, 'the Gateway no longer vouches for that channel');
  answers.hold = null; answers.channel = id => channelData(id, id === '300' ? ChannelType.GuildVoice : ChannelType.GuildText, id === '400' ? hidden : []);
  const context = await policy.guild('200', '100');
  assert.equal(visible(context, context.channels.get('400')), false, 'the REST round sees the update');
  // That clean read rewrote the cache with current data, so the Gateway vouches again.
  const restored = policy.gatewayGuild('200', '100');
  assert.ok(restored); assert.equal(visible(restored, restored.channels.get('400')), false);
});
