import { ChannelType, GatewayIntentBits, PermissionFlagsBits as P, Routes, Status } from 'discord.js';
import { LIBRARY_LIMITS, validId } from '../utils/library.js';
import { fail } from './errors.js';
import { commandAuthorityInput } from './timing.js';
import { savedSession } from '../utils/sessions.js';
import { bindAuthority, detachChannel, detachGuildResponse, detachMember, detachUser } from './authority.js';
import { channelTrusted, trackChannelReads, trackedChannelRead } from '../utils/channel-reads.js';

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

// One authorization round can admit identity (2), guild (1), both members (2)
// and Stop's two channel reads together, so urgent work reserves a full round.
export const READ_ADMISSIONS = Object.freeze({ ordinary: 128, urgent: 8 });
// Identity inputs with no Gateway event that keeps them current (ADR-0011):
// the actor's own account for 30 s and the bot application's owner for five
// minutes. Only a validated success is kept; a failure is never remembered.
export const IDENTITY_CACHE = Object.freeze({ userMs: 30_000, applicationMs: 300_000, users: 1000 });

export function createPortalPolicy(client, { operatorIds = [], now = () => Date.now() } = {}) {
  const operators = new Set(operatorIds.map(String));
  if ([...operators].some(id => !validId(id))) throw new Error('Invalid trusted portal operator configuration.');
  const pendingReads = new Map();
  // epoch fences out a read that started before an invalidation.
  const remembered = { users: new Map(), owner: null, epoch: 0 };
  const forgetUser = user => { if (user?.id) remembered.users.delete(user.id); remembered.epoch++; };
  const onUserUpdate = (_old, user) => forgetUser(user);
  client.on?.('userUpdate', onUserUpdate);
  // Forced channel reads write the cache gatewayView trusts; they go through
  // trackedChannelRead so a crossed Gateway update makes that channel
  // untrusted at once. Member reads use cache:false and never write it.
  trackChannelReads(client);
  const ordinaryChannels = channelPool(4);
  const urgentChannels = channelPool(2);
  const read = async (input, key, fetch, fresh, urgent) => {
    // Share only overlapping REST requests, never a completed authorization
    // result. Commands deliberately begin new reads after each slow lookup.
    if (fresh) key = Symbol(key);
    let pending = pendingReads.get(key);
    if (!pending) {
      if (pendingReads.size >= READ_ADMISSIONS.ordinary + (urgent ? READ_ADMISSIONS.urgent : 0)) fail(429, 'busy', 'Discord verification is busy. Try again shortly.');
      pending = Promise.resolve().then(fetch);
      pendingReads.set(key, pending);
      // Retain the underlying request after a caller's deadline. Otherwise a
      // stalled Discord request could spawn duplicates every snapshot poll.
      void pending.finally(() => { if (pendingReads.get(key) === pending) pendingReads.delete(key); }).catch(() => {});
    }
    return commandAuthorityInput(input, pending);
  };
  const sessionIds = (guildId, voiceId, channelIds = [], includeHistory = false) => {
    const player = client.lavalink?.getPlayer(guildId);
    const saved = savedSession(client.library, guildId);
    const ids = new Set([player?.voiceChannelId, player?.textChannelId, voiceId, saved?.voiceChannelId,
      saved?.textChannelId, client.library.settings(guildId).musicTextChannelId, ...channelIds].filter(validId));
    if (includeHistory) {
      for (const item of client.library.readGuild(guildId).history.slice(0, LIBRARY_LIMITS.history)) {
        if (validId(item.voiceChannelId)) ids.add(item.voiceChannelId);
      }
      // Play statistics name at most STATS_LIMITS.voiceChannels recent rooms.
      for (const id of client.stats?.voiceChannelIds?.(guildId) || []) ids.add(id);
    }
    return ids;
  };
  const ready = () => {
    if (client.isReady?.() !== true || client.runtimeState?.draining || !client.library) fail(503, 'discord_unavailable', 'Discord is temporarily unavailable.');
  };
  const identity = async (actorId, { fresh = false, urgent = false } = {}) => {
    ready();
    if (!validId(actorId)) fail(400, 'invalid_actor', 'A valid session actor is required.');
    // A fresh identity (the latency view, clearing request stats, every
    // pre-mutation REST stage) always reads Discord. Others may use a recent
    // validated answer; neither input has a Gateway event to keep it current.
    const at = now(); const epoch = remembered.epoch;
    const knownUser = fresh ? null : remembered.users.get(actorId);
    const knownOwner = fresh ? null : remembered.owner;
    let readUser = false, readOwner = false;
    // These independent identity inputs use at most two admissions. Observe
    // both promises even when one fails, and derive no grant before both pass.
    // Explicit trusted operators still need a valid user, but no owner lookup.
    const [user, ownerId] = await Promise.all([
      knownUser && knownUser.expires > at ? detachUser(knownUser.user)
        : (readUser = true, read('user', `user:${actorId}`, async () => detachUser(await client.users.fetch(actorId, { force: true })), fresh, urgent)),
      operators.has(actorId) ? undefined : knownOwner && knownOwner.expires > at ? knownOwner.id
        : (readOwner = true, read('application', 'application', async () => {
          const { owner } = await client.application.fetch();
          // Capture the scalar inside the read, before a sibling/Gateway await.
          // User owners and verified team owners only, never every team member.
          return owner?.ownerId || owner?.id;
        }, fresh, urgent)),
    ]);
    if (!user || user.id !== actorId || user.bot) fail(403, 'forbidden', 'This account cannot use the portal.');
    if (remembered.epoch === epoch) {
      if (readUser) {
        remembered.users.delete(actorId); remembered.users.set(actorId, { user: detachUser(user), expires: at + IDENTITY_CACHE.userMs });
        if (remembered.users.size > IDENTITY_CACHE.users) remembered.users.delete(remembered.users.keys().next().value);
      }
      if (readOwner && typeof ownerId === 'string' && validId(ownerId)) remembered.owner = { id: ownerId, expires: at + IDENTITY_CACHE.applicationMs };
    }
    const maintainer = operators.has(actorId) || actorId === ownerId;
    return { user, maintainer };
  };
  // gateway: answer from the Gateway-maintained cache when it can vouch
  // (gatewayView), else the REST round below. Protected reads default to it;
  // fresh REST stages (pre-mutation command checks) never use it unless the
  // caller asks, as the final disclosure does (ADR-0011).
  const guild = async (actorId, guildId, verifiedIdentity, { fresh = false, gateway = !fresh, urgent = false, channelScope = 'session', channelIds = [] } = {}) => {
    ready();
    if (!['session', 'history', 'none', 'configuration'].includes(channelScope)) throw new Error('Invalid internal channel scope.');
    if (!validId(guildId) || !client.guilds.cache.has(guildId)) fail(404, 'guild_not_found', 'That server is unavailable.');
    if (!verifiedIdentity && !validId(actorId)) fail(400, 'invalid_actor', 'A valid session actor is required.');
    // Complete channel discovery stays a REST read after REST admin checks.
    if (gateway && channelScope !== 'configuration' && gatewaySource(actorId, guildId)) {
      const who = verifiedIdentity || await identity(actorId, { urgent });
      ready();
      // Built after the identity wait, in one synchronous step, so it reflects
      // the Gateway state at this moment and no patch can land mid-evaluation.
      const view = gatewayView(actorId, guildId, who, { channelScope, channelIds });
      if (view) return view;
      // The cache stopped vouching meanwhile (a kick, a shard resume). A fresh
      // caller still gets a fresh identity in the REST round.
      if (!fresh) verifiedIdentity = who;
    }
    const server = client.guilds.cache.get(guildId);
    const readGuild = () => read('guild', `guild:${guildId}`, async () =>
      detachGuildResponse(server, await client.rest.get(Routes.guild(guildId)), guildId), fresh, urgent);
    const fetchDetachedChannel = id => read('channels', `channel:${guildId}:${id}`, () => (urgent ? urgentChannels : ordinaryChannels)(async () => {
      ready();
      try {
        // cache:false can return an existing channel WITHOUT applying REST data.
        // Detach immediately inside the shared read, then bind each caller's
        // channel to its own captured guild/member/role authority below.
        const channel = await trackedChannelRead(client, guildId, [id], () => server.channels.fetch(id, { force: true }));
        return channel?.id === id && channel.guildId === guildId && (TEXT_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type)) ? detachChannel(channel) : null;
      } catch (error) {
        if ([10003, 50001, 50013].includes(Number(error?.code)) || error?.code === 'GuildChannelUnowned') return null;
        throw error;
      }
    }), fresh, urgent);
    const sessionChannelIds = (voiceId, includeHistory = channelScope === 'history') => sessionIds(guildId, voiceId, channelIds, includeHistory);
    // Bound submissions as well as actual network work; history has at most
    // 100 sources, and no hundreds-of-promises fanout reaches REST admission.
    // A failed overlapped wave stops submitting further channel batches.
    const fetchDetachedChannels = async (ids, wave = null) => {
      const detached = new Map(); const ordered = [...ids]; const width = urgent ? 2 : 4;
      for (let start = 0; start < ordered.length && !wave?.failed; start += width) {
        await Promise.all(ordered.slice(start, start + width).map(async id => { detached.set(id, await fetchDetachedChannel(id)); }));
      }
      return detached;
    };
    const readMembers = () => Promise.all([
      // cache:false patches a clone, so a late response can't restore a kicked
      // member or revoked roles in the cache gatewayView trusts.
      read('actorMember', `member:${guildId}:${actorId}`, async () => detachMember(await server.members.fetch({ user: actorId, force: true, cache: false })), fresh, urgent)
        .catch(error => { if (Number(error?.code) !== 10007) throw error; return null; }),
      read('botMember', `botMember:${guildId}`, async () => detachMember(await server.members.fetchMe({ force: true, cache: false })), fresh, urgent),
    ]);
    // Identity, raw guild/role inventory and both members are independent
    // routes, so they start as one round for every caller, Stop included. Every
    // input is a fresh, separately detached REST read, and no grant is derived
    // until all of them succeed. A malformed guild inventory still fails closed.
    // Session channel IDs are known before membership: when Gateway already
    // places the actor in this guild's voice (which every playback control
    // requires), they join the round too. Non-members, configuration reads and
    // actors outside voice keep channel work after the membership decision.
    const gatewayVoiceId = actorVoiceId(server.members?.cache?.get(actorId)) || server.voiceStates?.cache?.get(actorId)?.channelId || null;
    const early = ['session', 'history'].includes(channelScope) && validId(gatewayVoiceId) ? sessionChannelIds(gatewayVoiceId, false) : null;
    // Admit the whole round or none of it, so saturation never leaves a partial
    // round of Discord requests running without a possible grant.
    const round = (verifiedIdentity ? 0 : operators.has(actorId) ? 1 : 2) + 3 + Math.min(early?.size || 0, urgent ? 2 : 4);
    if (pendingReads.size + round > READ_ADMISSIONS.ordinary + (urgent ? READ_ADMISSIONS.urgent : 0)) fail(429, 'busy', 'Discord verification is busy. Try again shortly.');
    let who, guildInput, allRoles, memberInput, botInput, prefetched;
    // Promise.all observes every input and fails fast; a failed round stops
    // submitting further channel batches.
    const wave = { failed: false };
    try {
      [who, { guildInput, allRoles }, [memberInput, botInput], prefetched] = await Promise.all([verifiedIdentity || identity(actorId, { fresh, urgent }),
        readGuild(), readMembers(), early ? fetchDetachedChannels(early, wave) : null]);
    } catch (error) { wave.failed = true; throw error; }
    if (!memberInput && !who.maintainer) fail(404, 'guild_not_found', 'That server is unavailable.');
    ready();
    // Deleted roles remain absent from this stage even while Gateway is late.
    // Do not edit shared caches: every native getter resolves through this view.
    const stage = bindAuthority(guildInput, memberInput, allRoles, botInput, actorId);
    const guildAdmin = Boolean(stage.member && (stage.guild.ownerId === actorId || stage.member.permissions?.has(P.ManageGuild)));
    const admin = guildAdmin || who.maintainer;
    // Deny complete discovery before it can consume Discord's list bucket.
    if (channelScope === 'configuration' && !admin) fail(403, 'admin_required', 'Manage Server permission is required.');
    const fetchChannel = id => fetchDetachedChannel(id).then(channel => stage.bindChannel(channel));
    const fetchChannels = async () => {
      if (channelScope === 'none') return new Map();
      if (channelScope === 'configuration') {
        const inventory = await read('channels', `channels:${guildId}`, async () => {
          const fetched = await trackedChannelRead(client, guildId, null, () => server.channels.fetch());
          return new Map([...fetched].map(([id, channel]) => [id, detachChannel(channel)]));
        }, fresh, urgent);
        return new Map([...inventory].filter(([id, channel]) => channel?.id === id && channel.guildId === guildId).map(([id, channel]) => [id, stage.bindChannel(channel)]));
      }
      // The stage member's voice ID can move during the round. Read any newly
      // current channel too, and bind only the channels this stage references.
      const detached = prefetched || new Map();
      const ids = sessionChannelIds(actorVoiceId(stage.member));
      for (const [id, channel] of await fetchDetachedChannels([...ids].filter(id => !detached.has(id)))) detached.set(id, channel);
      const channels = new Map();
      for (const id of ids) { const bound = stage.bindChannel(detached.get(id)); if (bound) channels.set(id, bound); }
      return channels;
    };
    const channels = await fetchChannels();
    for (const [id, channel] of channels) stage.channels.set(id, channel);
    ready();
    return { ...who, guild: stage.guild, member: stage.member, channels: stage.channels, roles: admin ? stage.roles : new Map(),
      roleIds: new Set(allRoles.keys()), me: stage.me, guildAdmin, admin, fetchChannel };
  };
  // Authority from the Gateway-maintained cache. With the members intent, every
  // input (owner, role definitions, actor roles and timeout, channel
  // overwrites, voice) is kept current by push events, so this is
  // event-sourced state rather than a time-based cache. gatewaySource returns
  // null, so the caller takes a REST round, whenever the cache can't be
  // trusted: no members intent, the guild's shard isn't Ready (missed events
  // replay on resume), or the actor, bot member or @everyone role is missing.
  const gatewaySource = (actorId, guildId) => {
    if (!validId(actorId) || !validId(guildId) || !client.options?.intents?.has?.(GatewayIntentBits.GuildMembers)) return null;
    const server = client.guilds.cache.get(guildId);
    if (!server || server.available === false || server.shard?.status !== Status.Ready) return null;
    const live = server.members.cache.get(actorId); const bot = server.members.me;
    if (!live || live.partial || !live.user || live.user.id !== actorId || live.user.bot || !bot || !server.roles.cache.has(guildId)) return null;
    return { server, live, bot };
  };
  // The view a REST round would build, from the cache, for session, history
  // or none channel scope. A channel missing from the cache is absent, as a
  // deleted one is from REST; the Guilds intent caches every guild channel.
  // Maintainer status comes only from a verified identity (who).
  const gatewayView = (actorId, guildId, who, { channelScope = 'session', channelIds = [] } = {}) => {
    ready();
    const source = gatewaySource(actorId, guildId);
    if (!source || !['session', 'history', 'none'].includes(channelScope) || (who && who.user?.id !== actorId)) return null;
    const { server, live, bot } = source;
    const { guildInput, allRoles } = detachGuildResponse(server, { id: server.id, owner_id: server.ownerId, name: server.name, icon: server.icon ?? null,
      roles: [...server.roles.cache.values()].map(role => ({ id: role.id, name: role.name, position: role.rawPosition ?? 0,
        permissions: String(role.permissions?.bitfield ?? 0n) })) }, guildId);
    const stage = bindAuthority(guildInput, detachMember(live), allRoles, detachMember(bot), actorId);
    const cached = id => {
      const channel = server.channels.cache.get(id);
      return channel?.id === id && channel.guildId === guildId && (TEXT_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type))
        ? stage.bindChannel(detachChannel(channel)) : null;
    };
    if (channelScope !== 'none') {
      for (const id of sessionIds(guildId, actorVoiceId(stage.member), channelIds, channelScope === 'history')) {
        if (!channelTrusted(client, guildId, id)) return null;
        const channel = cached(id); if (channel) stage.channels.set(id, channel);
      }
    }
    const maintainer = who?.maintainer === true;
    const guildAdmin = Boolean(stage.guild.ownerId === actorId || stage.member.permissions?.has(P.ManageGuild));
    const admin = guildAdmin || maintainer;
    return { user: who?.user || stage.member.user, maintainer, guild: stage.guild, member: stage.member, channels: stage.channels,
      roles: admin ? stage.roles : new Map(), roleIds: new Set(allRoles.keys()), me: stage.me, guildAdmin, admin,
      fetchChannel: async id => cached(id) };
  };
  // Session-scope Gateway authority for audible controls, without an identity
  // read: it grants no maintainer access.
  const gatewayGuild = (actorId, guildId) => gatewayView(actorId, guildId, null);
  return { ready, identity, guild, gatewayGuild, close() {
    pendingReads.clear(); remembered.users.clear(); remembered.owner = null; remembered.epoch++;
    client.off?.('userUpdate', onUserUpdate);
  } };
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
