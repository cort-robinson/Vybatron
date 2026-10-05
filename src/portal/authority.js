import { Collection, GuildMember, PermissionsBitField } from 'discord.js';

// Preserve discord.js prototypes/getters, but never inherit from a live cached
// instance (Base._clone does). Capture these inputs INSIDE each REST read,
// before another pending input or channel can let a Gateway patch intervene.
function copy(value, overrides = {}) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, item] of Object.entries(overrides)) descriptors[key] = { value: item, writable: true, configurable: true, enumerable: true };
  return Object.create(Object.getPrototypeOf(value), descriptors);
}
const permissions = value => new PermissionsBitField(value).freeze();
export const detachGuild = guild => copy(guild);
export const detachUser = user => user && copy(user);
export function detachRoles(roles) {
  // The 250-role bound belongs to the UI projection, not permission evaluation.
  return new Collection([...roles].map(([id, role]) => [id, copy(role, role.permissions === undefined ? {} : { permissions: permissions(role.permissions) })]));
}
export function detachMember(member) {
  if (!member) return null;
  // Voice IDs are the approved live Gateway input, not REST role authority.
  // Read only the ID from that source so movement during channel waits still
  // fails the same-voice guard against this stage's verified channel map.
  const voice = { get channelId() { return member.voice?.channelId || member.voice?.channel?.id || null; } };
  const overrides = { user: detachUser(member.user), voice };
  if (member instanceof GuildMember) overrides._roles = member._roles.slice();
  else {
    // Faithful plain-fixture seam: explicit guild permissions and role IDs are
    // detached too; the bound view replaces role objects with fresh definitions.
    overrides.roles = { cache: new Collection(member.roles?.cache || []) };
    if (member.permissions !== undefined) overrides.permissions = permissions(member.permissions);
  }
  return copy(member, overrides);
}
function managerView(manager, guild, cache, overrides = {}) {
  const view = copy(manager || {}, { guild, cache, ...overrides });
  // Native DataManager.resolve accepts an existing Member/Role unchanged. Map
  // it back to this stage, so even a real cached object cannot supply live roles.
  view.resolve = value => {
    const resolved = manager?.resolve ? manager.resolve.call(view, value) : value;
    return cache.get(typeof resolved === 'string' ? resolved : resolved?.id) || null;
  };
  return view;
}
function overwritesView(manager, channel) {
  const cache = new Collection([...manager.cache].map(([id, overwrite]) => [id, copy(overwrite, {
    channel, allow: permissions(overwrite.allow), deny: permissions(overwrite.deny),
  })]));
  return copy(manager, { channel, cache });
}
export function detachChannel(channel) {
  if (!channel) return null;
  const detached = copy(channel);
  if (channel.permissionOverwrites) detached.permissionOverwrites = overwritesView(channel.permissionOverwrites, detached);
  if (channel.hidden instanceof Set) detached.hidden = new Set(channel.hidden);
  return detached;
}

export function bindAuthority(guildInput, memberInput, roleInputs, botInput, actorId) {
  const guild = copy(guildInput);
  const roles = new Collection([...roleInputs].map(([id, role]) => [id, copy(role, { guild })]));
  const channels = new Collection(); const members = new Collection();
  const bindMember = input => {
    if (!input) return null;
    const member = copy(input, { guild });
    if (!(member instanceof GuildMember)) member.roles = { cache: new Collection([...input.roles.cache.keys()].filter(id => roles.has(id)).map(id => [id, roles.get(id)])) };
    member.voice = { get channelId() { return input.voice.channelId; }, get channel() { return channels.get(this.channelId) || null; } };
    return member;
  };
  const member = bindMember(memberInput); const me = bindMember(botInput);
  if (member) members.set(member.id, member);
  if (me) members.set(me.id, me);
  guild.roles = managerView(guildInput.roles, guild, roles);
  // Native channel joinable/speakable resolve client.user through this cache and
  // use this same fetched bot member (including its timeout), not the live cache.
  guild.members = managerView(guildInput.members, guild, members, { me, fetchMe: async () => me });
  guild.channels = managerView(guildInput.channels, guild, channels);
  if (guildInput.voiceStates) {
    // Gateway supplies voice IDs/listeners only. Other cached members are never
    // used for actor/bot authorization; their views also use the fresh role set.
    const states = new Collection();
    for (const [id, state] of guildInput.voiceStates.cache) {
      if (!members.has(id) && id !== actorId && id !== guild.client?.user?.id) {
        const listener = guildInput.members.cache.get(id);
        if (listener) members.set(id, bindMember(detachMember(listener)));
      }
      states.set(id, copy(state, { guild }));
    }
    guild.voiceStates = managerView(guildInput.voiceStates, guild, states);
  }
  const bindChannel = input => {
    if (!input) return null;
    const channel = copy(input, { guild });
    if (input.permissionOverwrites) channel.permissionOverwrites = overwritesView(input.permissionOverwrites, channel);
    return channel;
  };
  return { guild, member, me, roles, channels, bindChannel };
}
