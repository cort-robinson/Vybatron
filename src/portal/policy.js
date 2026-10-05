import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { validId } from '../utils/library.js';
import { fail } from './errors.js';
import { withTimeout } from '../utils/enqueue.js';

export const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
export const VOICE_TYPES = new Set([ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
export function visible(context, channel) {
  return Boolean(context.member && channel?.guildId === context.guild.id && channel.permissionsFor?.(context.member)?.has(P.ViewChannel));
}
export function visibleSession(context, player) {
  return !player || (visible(context, context.channels.get(player.voiceChannelId)) && visible(context, context.channels.get(player.textChannelId)));
}
export function writable(context, channel) {
  return channel?.guildId === context.guild.id && TEXT_TYPES.has(channel.type)
    && channel.permissionsFor?.(context.me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
}
export function djAccess(context, client) {
  const roleId = client.library.settings(context.guild.id).djRoleId;
  return Boolean(context.member && (context.guildAdmin || !roleId || context.member.roles?.cache?.has(roleId)));
}

export function createPortalPolicy(client, { operatorIds = [] } = {}) {
  const operators = new Set(operatorIds.map(String));
  if ([...operators].some(id => !validId(id))) throw new Error('Invalid trusted portal operator configuration.');
  const pendingReads = new Map();
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
    const user = await read(`user:${actorId}`, () => client.users.fetch(actorId, { force: true }), fresh, urgent);
    if (!user || user.id !== actorId || user.bot) fail(403, 'forbidden', 'This account cannot use the portal.');
    let maintainer = operators.has(actorId);
    if (!maintainer) {
      const application = await read('application', () => client.application.fetch(), fresh, urgent);
      const owner = application.owner;
      // User owners and verified team owners only, never every team member.
      maintainer = actorId === (owner?.ownerId || owner?.id);
    }
    return { user, maintainer };
  };
  const guild = async (actorId, guildId, verifiedIdentity, { fresh = false, urgent = false } = {}) => {
    ready();
    if (!validId(guildId) || !client.guilds.cache.has(guildId)) fail(404, 'guild_not_found', 'That server is unavailable.');
    const who = verifiedIdentity || await identity(actorId, { fresh, urgent });
    const server = await read(`guild:${guildId}`, () => client.guilds.fetch({ guild: guildId, force: true }), fresh, urgent);
    const memberRead = read(`member:${guildId}:${actorId}`, () => server.members.fetch({ user: actorId, force: true }), fresh, urgent)
      .catch(error => { if (Number(error?.code) !== 10007) throw error; return null; });
    // Independent permission inputs need not form a seven-request waterfall.
    // Limit each round to two reads so even Stop fits its reserved REST slots.
    // Start only after the guild refresh: discord.js patches its role cache
    // from that response, which must precede the authoritative role inventory.
    const [member, channels] = await Promise.all([
      memberRead,
      read(`channels:${guildId}`, () => server.channels.fetch(), fresh, urgent),
    ]);
    if (!member && !who.maintainer) fail(404, 'guild_not_found', 'That server is unavailable.');
    // Member permissions depend on the current role definitions, not merely
    // the member's fresh list of role IDs.
    const [allRoles, me] = await Promise.all([
      read(`roles:${guildId}`, () => server.roles.fetch(), fresh, urgent),
      read(`botMember:${guildId}`, () => server.members.fetchMe({ force: true }), fresh, urgent),
    ]);
    ready();
    // discord.js fetch-all updates roles but does not evict deleted ones. Its
    // member/channel permission getters otherwise retain a removed grant until
    // the gateway deletion arrives, despite the fresh REST role inventory.
    for (const roleId of server.roles.cache?.keys() || []) if (!allRoles.has(roleId)) server.roles.cache.delete(roleId);
    const guildAdmin = Boolean(member && (server.ownerId === actorId || member.permissions?.has(P.ManageGuild)));
    const admin = guildAdmin || who.maintainer;
    const roles = admin ? allRoles : new Map();
    return { ...who, guild: server, member, channels, roles, me, guildAdmin, admin };
  };
  return { ready, identity, guild, close() { pendingReads.clear(); } };
}

export function requirePlayback(context, client, { dj = true, sourceOnly = false, queueSource = false, saved = null, allowIdle = false } = {}) {
  if (!context.member) fail(403, 'membership_required', 'Join this server to control playback.');
  const player = client.lavalink?.getPlayer(context.guild.id);
  if (!visibleSession(context, player)) fail(403, 'hidden_channel', 'The listening channel is not visible to you.');
  if (saved && (!visible(context, context.channels.get(saved.voiceChannelId)) || !visible(context, context.channels.get(saved.textChannelId)))) fail(403, 'hidden_channel', 'The saved listening channel is not visible to you.');
  if (sourceOnly) {
    if (!(queueSource ? player?.queue?.tracks?.length : player?.queue?.current)) fail(409, 'changed_session', 'There is no source track to save.');
    return;
  }
  const voice = context.member.voice?.channel;
  if (!voice || !visible(context, context.channels.get(voice.id))) fail(403, 'wrong_voice', 'Join the listening voice channel first.');
  if ((player?.voiceChannelId && voice.id !== player.voiceChannelId) || (saved && voice.id !== saved.voiceChannelId)) fail(403, 'wrong_voice', 'Join the original listening voice channel first.');
  if (!allowIdle && !player && !saved) fail(409, 'changed_session', 'The listening session has ended.');
  if (dj && !djAccess(context, client)) fail(403, 'dj_required', 'Playback controls require the configured DJ role or Manage Server permission.');
}
