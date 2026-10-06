import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { LIBRARY_LIMITS, validId } from '../utils/library.js';
import { fail } from './errors.js';
import { withTimeout } from '../utils/enqueue.js';
import { savedSession } from '../utils/sessions.js';
import { bindAuthority, detachChannel, detachGuild, detachMember, detachRoles, detachUser } from './authority.js';

export const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
export const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
export function visible(context, channel) {
  return Boolean(context.member && channel?.guildId === context.guild.id && channel.permissionsFor?.(context.member)?.has(P.ViewChannel));
}
export function visibleSession(context, player) {
  return !player || (VOICE_TYPES.has(context.channels.get(player.voiceChannelId)?.type) && TEXT_TYPES.has(context.channels.get(player.textChannelId)?.type)
    && visible(context, context.channels.get(player.voiceChannelId)) && visible(context, context.channels.get(player.textChannelId)));
}
export function visibleHistory(context, item) {
  const channel = context.channels.get(item.voiceChannelId);
  return VOICE_TYPES.has(channel?.type) && visible(context, channel);
}
export const actorVoiceId = member => member?.voice?.channelId || member?.voice?.channel?.id;
export function writable(context, channel) {
  return channel?.guildId === context.guild.id && TEXT_TYPES.has(channel.type)
    && channel.permissionsFor?.(context.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
}
export function djAccess(context, client) {
  const roleId = client.library.settings(context.guild.id).djRoleId;
  return Boolean(context.member && (context.guildAdmin || !roleId || (context.roleIds.has(roleId) && context.member.roles?.cache?.has(roleId))));
}

// Separate ordinary and Stop pools. Slots remain held until the underlying REST
// request settles, including after its caller's five-second deadline expires.
function channelPool(limit) {
  let active = 0;
  const waiting = [];
  const drain = () => {
    while (active < limit && waiting.length) {
      const { fetch, resolve, reject } = waiting.shift(); active++;
      Promise.resolve().then(fetch).then(resolve, reject).finally(() => { active--; drain(); }).catch(() => {});
    }
  };
  return fetch => new Promise((resolve, reject) => { waiting.push({ fetch, resolve, reject }); drain(); });
}

export function createPortalPolicy(client, { operatorIds = [] } = {}) {
  const operators = new Set(operatorIds.map(String));
  if ([...operators].some(id => !validId(id))) throw new Error('Invalid trusted portal operator configuration.');
  const pendingReads = new Map();
  const ordinaryChannels = channelPool(4);
  const urgentChannels = channelPool(2);
  const read = async (key, fetch, fresh, urgent) => {
    // Share only overlapping REST requests, never a completed authorization
    // result. Commands deliberately begin new reads after each slow lookup.
    if (fresh) key = Symbol(key);
    let pending = pendingReads.get(key);
    if (!pending) {
      if (pendingReads.size >= (urgent ? 130 : 128)) fail(429, 'busy', 'Discord verification is busy. Try again shortly.');
      pending = Promise.resolve().then(fetch);
      pendingReads.set(key, pending);
      // Retain the underlying request after a caller's deadline. Otherwise a
      // stalled Discord request could spawn duplicates every snapshot poll.
      void pending.finally(() => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }).catch(() => {});
    }
    return withTimeout(pending, 5000);
  };
  const ready = () => {
    if (client.isReady?.() !== true || client.runtimeState?.draining || !client.library) fail(503, 'discord_unavailable', 'Discord is temporarily unavailable.');
  };
  const identity = async (actorId, { fresh = false, urgent = false } = {}) => {
    ready();
    if (!validId(actorId)) fail(400, 'invalid_actor', 'A valid session actor is required.');
    // These independent identity inputs use at most two admissions. Observe
    // both promises even when one fails, and derive no grant before both pass.
    // Explicit trusted operators still need a valid user, but no owner lookup.
    const [user, ownerId] = await Promise.all([
      read(`user:${actorId}`, async () => detachUser(await client.users.fetch(actorId, { force: true })), fresh, urgent),
      operators.has(actorId) ? undefined : read('application', async () => {
        const { owner } = await client.application.fetch();
        // Capture the scalar inside the read, before a sibling/Gateway await.
        // User owners and verified team owners only, never every team member.
        return owner?.ownerId || owner?.id;
      }, fresh, urgent),
    ]);
    if (!user || user.id !== actorId || user.bot) fail(403, 'forbidden', 'This account cannot use the portal.');
    const maintainer = operators.has(actorId) || actorId === ownerId;
    return { user, maintainer };
  };
  const guild = async (actorId, guildId, verifiedIdentity, { fresh = false, urgent = false, channelScope = 'session', channelIds = [] } = {}) => {
    ready();
    if (!['session', 'history', 'none', 'configuration'].includes(channelScope)) throw new Error('Invalid internal channel scope.');
    if (!validId(guildId) || !client.guilds.cache.has(guildId)) fail(404, 'guild_not_found', 'That server is unavailable.');
    const who = verifiedIdentity || await identity(actorId, { fresh, urgent });
    const { server, guildInput } = await read(`guild:${guildId}`, async () => {
      const server = await client.guilds.fetch({ guild: guildId, force: true });
      return { server, guildInput: detachGuild(server) };
    }, fresh, urgent);
    const memberRead = read(`member:${guildId}:${actorId}`, async () => detachMember(await server.members.fetch({ user: actorId, force: true })), fresh, urgent)
      .catch(error => { if (Number(error?.code) !== 10007) throw error; return null; });
    // Guild refresh patches roles. Fetch the authoritative inventory afterwards,
    // with no more than two non-channel inputs in flight even for urgent work.
    const [memberInput, allRoles] = await Promise.all([
      memberRead,
      read(`roles:${guildId}`, async () => detachRoles(await server.roles.fetch()), fresh, urgent),
    ]);
    if (!memberInput && !who.maintainer) fail(404, 'guild_not_found', 'That server is unavailable.');
    ready();
    // discord.js fetch-all updates roles but does not evict deleted ones. Its
    // member/channel permission getters otherwise retain a removed grant until
    // the gateway deletion arrives, despite the fresh REST role inventory.
    for (const roleId of server.roles.cache?.keys() || []) if (!allRoles.has(roleId)) server.roles.cache.delete(roleId);
    const authority = bindAuthority(guildInput, memberInput, allRoles, null, actorId);
    const guildAdmin = Boolean(authority.member && (authority.guild.ownerId === actorId || authority.member.permissions?.has(P.ManageGuild)));
    const admin = guildAdmin || who.maintainer;
    // Deny complete discovery before it can consume Discord's list bucket.
    if (channelScope === 'configuration' && !admin) fail(403, 'admin_required', 'Manage Server permission is required.');
    const fetchChannel = id => read(`channel:${guildId}:${id}`, () => (urgent ? urgentChannels : ordinaryChannels)(async () => {
      ready();
      try {
        // cache:false can return an existing channel WITHOUT applying REST data.
        // Detach immediately inside the shared read, then bind each caller's
        // channel to its own captured guild/member/role authority below.
        const channel = await server.channels.fetch(id, { force: true });
        return channel?.id === id && channel.guildId === guildId && (TEXT_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type)) ? detachChannel(channel) : null;
      } catch (error) {
        if ([10003, 50001, 50013].includes(Number(error?.code)) || error?.code === 'GuildChannelUnowned') return null;
        throw error;
      }
    }), fresh, urgent).then(channel => stage.bindChannel(channel));
    const fetchChannels = async () => {
      if (channelScope === 'none') return new Map();
      if (channelScope === 'configuration') {
        const inventory = await read(`channels:${guildId}`, async () => {
          const fetched = await server.channels.fetch();
          return new Map([...fetched].map(([id, channel]) => [id, detachChannel(channel)]));
        }, fresh, urgent);
        return new Map([...inventory].filter(([id, channel]) => channel?.id === id && channel.guildId === guildId).map(([id, channel]) => [id, stage.bindChannel(channel)]));
      }
      const player = client.lavalink?.getPlayer(guildId);
      const saved = savedSession(client.library, guildId);
      const ids = new Set([player?.voiceChannelId, player?.textChannelId, actorVoiceId(stage.member), saved?.voiceChannelId,
        saved?.textChannelId, client.library.settings(guildId).musicTextChannelId, ...channelIds].filter(validId));
      if (channelScope === 'history') for (const item of client.library.readGuild(guildId).history.slice(0, LIBRARY_LIMITS.history)) {
        if (validId(item.voiceChannelId)) ids.add(item.voiceChannelId);
      }
      const channels = new Map();
      // Bound submissions as well as actual network work; history has at most
      // 100 sources, and no hundreds-of-promises fanout reaches REST admission.
      const ordered = [...ids]; const width = urgent ? 2 : 4;
      for (let start = 0; start < ordered.length; start += width) {
        await Promise.all(ordered.slice(start, start + width).map(async id => {
          const channel = await fetchChannel(id);
          if (channel) channels.set(id, channel);
        }));
      }
      return channels;
    };
    // Refresh bot membership before evaluating channel access. Stop then has at
    // most two channel reads outstanding even with 128 ordinary admissions held.
    const botInput = await read(`botMember:${guildId}`, async () => detachMember(await server.members.fetchMe({ force: true })), fresh, urgent);
    const stage = bindAuthority(guildInput, memberInput, allRoles, botInput, actorId);
    const channels = await fetchChannels();
    for (const [id, channel] of channels) stage.channels.set(id, channel);
    ready();
    return { ...who, guild: stage.guild, member: stage.member, channels: stage.channels, roles: admin ? stage.roles : new Map(),
      roleIds: new Set(allRoles.keys()), me: stage.me, guildAdmin, admin, fetchChannel };
  };
  return { ready, identity, guild, close() { pendingReads.clear(); } };
}

export function requirePlayback(context, client, { dj = true, sourceOnly = false, queueSource = false, saved = null, allowIdle = false } = {}) {
  if (!context.member) fail(403, 'membership_required', 'Join this server to control playback.');
  const player = client.lavalink?.getPlayer(context.guild.id);
  if (!visibleSession(context, player)) fail(403, 'hidden_channel', 'The listening channel is not visible to you.');
  if (saved && !visibleSession(context, saved)) fail(403, 'hidden_channel', 'The saved listening channel is not visible to you.');
  if (sourceOnly) {
    if (!(queueSource ? player?.queue?.tracks?.length : player?.queue?.current)) fail(409, 'changed_session', 'There is no source track to save.');
    return;
  }
  const voice = context.channels.get(actorVoiceId(context.member));
  if (!voice || !VOICE_TYPES.has(voice.type) || !visible(context, voice)) fail(403, 'wrong_voice', 'Join the listening voice channel first.');
  if ((player?.voiceChannelId && voice.id !== player.voiceChannelId) || (saved && voice.id !== saved.voiceChannelId)) fail(403, 'wrong_voice', 'Join the original listening voice channel first.');
  if (!allowIdle && !player && !saved) fail(409, 'changed_session', 'The listening session has ended.');
  if (dj && !djAccess(context, client)) fail(403, 'dj_required', 'Playback controls require the configured DJ role or Manage Server permission.');
}
