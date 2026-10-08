import { guardedMutation, commandMutationPolicy } from '../utils/requests.js';
import { savedSession } from '../utils/sessions.js';
import { plainText } from '../utils/presentation.js';
import { parseSeekTimestamp } from '../utils/operations.js';
import { validatePlaybackQuery } from '../utils/query.js';
import { mixKey } from '../utils/library-actions.js';
import { fail, PortalError } from './errors.js';
import { requirePlayback, visible, visibleHistory, visibleSession, writable } from './policy.js';
import { snapshotProjection } from './projection.js';
import { assertFavoriteSelection, assertHistorySelection, assertMixSelection } from './selections.js';
import { commandAuthorityPhase } from './timing.js';

const ALLOWED = new Set(['play', 'playnext', 'pause', 'resume', 'seek', 'skip', 'skipto', 'stop', 'clear', 'remove', 'move', 'shuffle', 'loop', 'volume', 'filter', 'voteskip', 'radio', 'replay', 'session', 'favorite', 'mix', 'settings', 'queue', 'nowplaying', 'history', 'help', 'top']);
const CONFLICTING = new Set(['playnext', 'seek', 'skip', 'skipto', 'clear', 'remove', 'move', 'shuffle', 'replay']);
// These handlers perform no admission work that needs guild authority. Their
// first await is the native requireControl guard, which takes fresh authority
// inside the bounded mutation lane before reading protected state. An earlier
// admission or preflight grant would only repeat the same round back to back.
const DIRECT_CONTROLS = new Set(['pause', 'resume', 'seek', 'filter', 'volume', 'skip', 'skipto', 'loop', 'shuffle',
  'remove', 'move', 'clear', 'radio', 'voteskip', 'stop']);
// Audible controls take their pre-mutation authority from the Gateway cache
// when the policy can vouch for it, so the playback write isn't held behind a
// Discord REST round. Queue edits, Stop and the final disclosure stay fresh.
const GATEWAY_CONTROLS = new Set(['pause', 'resume', 'seek', 'filter', 'volume', 'skip', 'skipto']);
const ROOT_KEYS = new Set(['actorId', 'command', 'subcommand', 'options', 'expectedRevision', 'expectedTrackId', 'expectedHistoryId', 'expectedMixVersion']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const publicName = (command, name) => command === 'skipto' && name === 'index' ? 'position' : command === 'replay' && name === 'position' ? 'index' : name;

function publicOption(option) {
  const result = { type: option.type, name: option.name, description: plainText(option.description, { maxLength: 100 }) };
  for (const key of ['required', 'min_value', 'max_value', 'min_length', 'max_length', 'channel_types']) if (option[key] !== undefined) result[key] = option[key];
  if (option.options) result.options = option.options.map(publicOption);
  if (option.choices) result.choices = option.choices.map(choice => ({ name: plainText(choice.name, { maxLength: 100 }), value: choice.value }));
  if (option.portalCommand) result.name = publicName(option.portalCommand, result.name);
  return result;
}
export function publicCommands(commandMap) {
  return [...commandMap.entries()].filter(([name]) => ALLOWED.has(name)).map(([name, command]) => {
    const schema = command.data.toJSON();
    return { name, description: plainText(schema.description, { maxLength: 100 }), options: (schema.options || []).map(option => publicOption({ ...option, portalCommand: name })) };
  });
}
export function validateCommand(body, commandMap) {
  if (!object(body) || Object.keys(body).some(key => !ROOT_KEYS.has(key)) || !ALLOWED.has(body.command) || !commandMap.has(body.command)) fail(400, 'invalid_command', 'Choose a supported command.');
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{32}$/.test(body.expectedRevision))) fail(400, 'invalid_revision', 'Use the revision from the latest snapshot.');
  const selections = [
    ['expectedTrackId', body.command === 'favorite' && ['play', 'remove'].includes(body.subcommand), /^[a-f0-9]{24}$/],
    ['expectedHistoryId', body.command === 'replay', /^[^\u0000-\u001f\u007f]{1,40}$/],
    ['expectedMixVersion', body.command === 'mix' && body.subcommand === 'delete', /^[a-f0-9]{32}$/],
  ];
  for (const [key, required, shape] of selections) {
    if (Object.hasOwn(body, key) && !required) fail(400, 'invalid_selection', 'A selection token was supplied for an unsupported command.');
    if (required && (typeof body[key] !== 'string' || !shape.test(body[key]))) fail(400, 'invalid_selection', 'Include the selected library item token before trying again.');
  }
  const schema = commandMap.get(body.command).data.toJSON();
  const subcommands = (schema.options || []).filter(option => option.type === 1);
  let options = schema.options || [];
  if (subcommands.length) {
    const subcommand = subcommands.find(option => option.name === body.subcommand);
    if (!subcommand) fail(400, 'invalid_subcommand', 'Choose a supported subcommand.');
    options = subcommand.options || [];
  } else if (body.subcommand !== undefined) fail(400, 'invalid_subcommand', 'This command has no subcommand.');
  const supplied = body.options ?? {};
  if (!object(supplied) || Object.keys(supplied).length > 10) fail(400, 'invalid_options', 'Command options must be an object.');
  const values = {};
  const expected = options.map(option => ({ ...option, originalName: option.name, name: publicName(body.command, option.name) }));
  for (const key of Object.keys(supplied)) if (!expected.some(option => option.name === key)) fail(400, 'invalid_options', 'An unsupported command option was supplied.');
  for (const option of expected) {
    const value = supplied[option.name];
    if (value === undefined || value === null) {
      if (option.required) fail(400, 'invalid_options', `The ${option.name} option is required.`);
      continue;
    }
    let valid = false;
    if (option.type === 3) valid = typeof value === 'string' && value.length >= (option.min_length || 1) && value.length <= Math.min(option.max_length || 200, 200) && !/[\u0000-\u001f\u007f]/.test(value);
    if (option.type === 4) valid = Number.isSafeInteger(value) && value >= (option.min_value ?? 0) && value <= (option.max_value ?? 1000);
    if (option.type === 5) valid = typeof value === 'boolean';
    if ([7, 8].includes(option.type)) valid = typeof value === 'string' && /^\d{1,22}$/.test(value);
    if (!valid || (option.choices && !option.choices.some(choice => choice.value === value))) fail(400, 'invalid_options', `The ${option.name} option is invalid.`);
    values[option.originalName] = value;
  }
  const needsRevision = CONFLICTING.has(body.command) || (body.command === 'mix' && body.subcommand === 'save') || (body.command === 'favorite' && body.subcommand === 'add') || (body.command === 'session' && ['resume', 'discard'].includes(body.subcommand));
  if (needsRevision && !body.expectedRevision) fail(400, 'revision_required', 'Refresh this session and include its revision before editing.');
  return { ...body, values, policy: commandMutationPolicy(body.command, body.subcommand) };
}

function assertMixAccess(context, mix, expectedVersion) {
  if (mix && mix.ownerId !== context.user.id && !context.guildAdmin) fail(403, 'mix_owner_required', 'Only the creator or a server manager can edit that mix.');
  assertMixSelection(mix, expectedVersion);
}

function assertCommandSelection(client, context, command) {
  if (command.command === 'favorite' && ['remove', 'play'].includes(command.subcommand)) {
    assertFavoriteSelection(client.library.favorites(context.user.id)[command.values.index - 1], command.expectedTrackId);
  }
  if (command.command === 'replay') {
    const history = client.library.readGuild(context.guild.id).history.filter(item => visibleHistory(context, item));
    assertHistorySelection(history[(command.values.position || 1) - 1], command.expectedHistoryId);
  }
  if (command.command === 'mix' && command.subcommand === 'delete') {
    assertMixAccess(context, client.library.readGuild(context.guild.id).mixes[mixKey(command.values.name)], command.expectedMixVersion);
  }
}

function commandAccess(client, context, command, { checkState = true } = {}) {
  const { command: name, subcommand: action, values } = command;
  if (name === 'settings') {
    if (!context.admin) fail(403, 'admin_required', 'Manage Server permission is required.');
    if (values.role && !context.roles.has(values.role)) fail(400, 'invalid_role', 'Choose a role from this server.');
    if (values.channel && !writable(context, context.channels.get(values.channel))) fail(400, 'invalid_channel', 'Choose a bot-readable and writable text channel in this server.');
    return;
  }
  if (!context.member) fail(403, 'membership_required', 'Join this server to use its music library and playback controls.');
  if (command.policy.readOnly) {
    if (['queue', 'nowplaying', 'history'].includes(name) && !visibleSession(context, client.lavalink?.getPlayer(context.guild.id))) fail(403, 'hidden_channel', 'The listening channel is not visible to you.');
    if (name === 'session') {
      const saved = savedSession(client.library, context.guild.id);
      if (saved && !visibleSession(context, saved)) fail(403, 'hidden_channel', 'The saved listening channel is not visible to you.');
    }
    return;
  }
  if (['play', 'playnext'].includes(name) && (validatePlaybackQuery(values.query) || values.query.startsWith('autocomplete:'))) fail(400, 'invalid_query', 'Enter a song title or supported public catalog link.');
  if (checkState) assertCommandSelection(client, context, command);
  if (name === 'mix' && action !== 'list') {
    const key = mixKey(values.name);
    const existing = client.library.readGuild(context.guild.id).mixes[key];
    if (action === 'load' && !existing) fail(404, 'mix_not_found', 'That mix no longer exists.');
    if (['save', 'delete'].includes(action) && existing && existing.ownerId !== context.user.id && !context.guildAdmin) fail(403, 'mix_owner_required', 'Only the creator or a server manager can edit that mix.');
    if (action === 'save' && existing && !values.replace) fail(409, 'mix_exists', 'That mix exists. Choose Replace to update it.');
  }
  if ((name === 'favorite' && !['add', 'play'].includes(action)) || (name === 'mix' && action === 'delete')) return;
  if ((name === 'favorite' && action === 'add') || (name === 'mix' && action === 'save')) {
    requirePlayback(context, client, { sourceOnly: true, queueSource: name === 'favorite' && values.position !== undefined });
    if (checkState && name === 'favorite' && values.position !== undefined && values.position > client.lavalink.getPlayer(context.guild.id).queue.tracks.length) fail(400, 'invalid_position', 'Choose an existing upcoming queue position.');
    if (checkState && name === 'mix' && (1 + (client.lavalink.getPlayer(context.guild.id).queue.tracks?.length || 0)) > 100) fail(400, 'mix_limit', 'A mix can contain at most 100 tracks.');
    return;
  }
  const addition = name === 'play' || (name === 'favorite' && action === 'play') || (name === 'mix' && action === 'load') || (name === 'top' && action === 'play');
  const checkpoint = name === 'session' ? savedSession(client.library, context.guild.id) : null;
  requirePlayback(context, client, { dj: !addition && name !== 'voteskip', allowIdle: addition || name === 'playnext', saved: checkpoint });
  const player = client.lavalink?.getPlayer(context.guild.id);
  const queueSize = player?.queue?.tracks?.length || 0;
  if (checkState && ((name === 'remove' && values.position > queueSize) || (name === 'skipto' && values.index > queueSize))) fail(400, 'invalid_position', 'Choose an existing queue position.');
  if (checkState && name === 'move' && (values.from > queueSize || values.to > queueSize || values.from === values.to)) fail(400, 'invalid_position', 'Choose two different existing queue positions.');
  if (checkState && name === 'seek') {
    const position = parseSeekTimestamp(values.timestamp);
    const info = player?.queue?.current?.info;
    if (position === null || !info || info.isStream || info.isSeekable === false || position >= info.duration) fail(400, 'invalid_seek', 'Choose a valid timestamp before the end of a seekable track.');
  }
  if (!player && ['play', 'playnext', 'favorite', 'mix', 'top'].includes(name)) {
    const text = context.channels.get(client.library.settings(context.guild.id).musicTextChannelId);
    if (!writable(context, text) || !visible(context, text)) fail(409, 'music_channel_required', 'An administrator must configure a visible music text channel before starting from the web.');
  }
  if (checkpoint && action === 'resume' && (!writable(context, context.channels.get(checkpoint.textChannelId)))) fail(403, 'invalid_channel', 'Vybertron cannot write to the saved controller channel.');
}

function safeReply(payload) {
  const value = typeof payload === 'string' ? payload : payload?.content || (payload?.embeds || []).map(embed => (embed.data || embed).description || '').join(' ');
  // Replies may contain catalog/controller links. Strip addresses altogether so
  // no upstream URL or token can sneak into the command result text.
  return plainText(String(value || 'Request completed.').replace(/https?:\/\/\S+/gi, '[link]').replace(/<[@#][^>]+>/g, ''), { maxLength: 1000 });
}

export async function executePortalCommand(client, policy, revisions, commandMap, guildId, body) {
  const command = validateCommand(body, commandMap);
  const nativePreflight = DIRECT_CONTROLS.has(command.command)
    && (command.command !== 'filter' || command.values.preset !== undefined);
  const freshContext = (phase = 'native') => commandAuthorityPhase(phase, () => (phase === 'native' && GATEWAY_CONTROLS.has(command.command)
    && policy.gatewayGuild?.(body.actorId, guildId)) || policy.guild(body.actorId, guildId, undefined, { fresh: true, urgent: command.command === 'stop',
    channelScope: ['history', 'replay', 'top'].includes(command.command) ? 'history' : 'session',
    channelIds: command.command === 'settings' && command.subcommand === 'musicchannel' && command.values.channel ? [command.values.channel] : [] }));
  let context = null;
  // Dynamic indices and source state are checked in preflight after the revision
  // fence inside the guild lane. A vanished old position is a stale intent, not
  // invalid fresh input. Verified direct handlers acquire their first authority
  // at the native guard; their earlier dispatch/setup carries no guild context.
  if (!DIRECT_CONTROLS.has(command.command)) {
    context = await freshContext();
    commandAccess(client, context, command, { checkState: false });
  }
  let message = 'Request completed.';
  let started = false;
  let mutationStarted = false;
  let baseline = null;
  const source = client.lavalink?.getPlayer(guildId);
  const replySourceIds = source ? [source.voiceChannelId, source.textChannelId] : [];
  const assertRevision = () => {
    if (!mutationStarted && baseline && baseline !== revisions.revision(guildId)) fail(409, 'stale_revision', 'The session changed. Refresh before trying again.');
  };
  const interaction = {
    client, guildId, commandName: command.command, user: context?.user, guild: context?.guild, member: context?.member, memberPermissions: context?.member?.permissions,
    channelId: null, portalAdmin: command.command === 'settings' && context?.maintainer, deferred: false, replied: false,
    get portalHistory() { return client.library.readGuild(guildId).history.filter(item => visibleHistory(context, item)); },
    options: {
      getSubcommand: () => command.subcommand || null,
      getString: key => command.values[key] ?? null, getInteger: key => command.values[key] ?? null, getBoolean: key => command.values[key] ?? null,
      getRole: key => context.roles.get(command.values[key]) || null, getChannel: key => context.channels.get(command.values[key]) || null,
    },
    isMessageComponent: () => false, isModalSubmit: () => false,
    async deferReply() { this.deferred = true; },
    async reply(payload) { this.replied = true; message = safeReply(payload); },
    async editReply(payload) { this.replied = true; message = safeReply(payload); },
    async followUp(payload) { this.replied = true; message = safeReply(payload); },
    portalReject(text) { throw new PortalError(403, 'forbidden', plainText(text, { maxLength: 250 })); },
    portalUnavailable() { fail(503, 'maintenance', 'Playback is briefly updating. Try again shortly.'); },
    portalAssertRevision: assertRevision,
    portalAssertFavorite(track) { assertFavoriteSelection(track, command.expectedTrackId); },
    portalAssertHistory(item) { assertHistorySelection(item, command.expectedHistoryId); },
    portalAssertMix(mix) { assertMixAccess(context, mix, command.expectedMixVersion); },
    portalPlayerCreated() { if (baseline) baseline = revisions.revision(guildId); },
    async portalRecheck() {
      if (!started) return;
      context = await freshContext();
      // Direct preflight has only established a local intent baseline. Preserve
      // stale-intent precedence over an invalid target after dispatch/read waits.
      if (nativePreflight) assertRevision();
      // Validate authority again after each slow lookup. Once a mutation has
      // started, dynamic queue indices/checkpoint conditions must not be applied
      // to our own already-edited state.
      if (mutationStarted) {
        const addition = command.command === 'play' || (command.command === 'favorite' && command.subcommand === 'play') || (command.command === 'mix' && command.subcommand === 'load') || (command.command === 'top' && command.subcommand === 'play');
        if (command.command === 'settings') { if (!context.admin) fail(403, 'admin_required', 'Manage Server permission is required.'); }
        else requirePlayback(context, client, { dj: !addition && command.command !== 'voteskip', sourceOnly: (command.command === 'favorite' && command.subcommand === 'add') || (command.command === 'mix' && command.subcommand === 'save'), allowIdle: addition || command.command === 'playnext' });
      } else commandAccess(client, context, command);
      applyContext();
      assertRevision();
    },
  };
  const applyContext = () => {
    // Native handlers use guild.channels.cache and member.voice.channel. Supply
    // a request-local view backed only by this stage's individually fetched
    // channels; never let a delayed gateway overwrite grant native access.
    interaction.guild = Object.create(context.guild, { channels: { value: {
      cache: context.channels, fetch: id => context.fetchChannel(id),
    } } });
    interaction.member = context.member;
    interaction.memberPermissions = context.member?.permissions; interaction.user = context.user;
    interaction.portalAdmin = command.command === 'settings' && context.maintainer;
  };
  if (context) applyContext();
  const preflight = async () => {
    if (!nativePreflight) context = await freshContext();
    const current = revisions.revision(guildId);
    if (command.command !== 'stop' && body.expectedRevision && body.expectedRevision !== current) fail(409, 'stale_revision', 'The session changed. Refresh before trying again.');
    if (!nativePreflight) commandAccess(client, context, command);
    baseline = body.expectedRevision && command.command !== 'stop' ? current : null;
    if (!nativePreflight) applyContext();
    const player = client.lavalink?.getPlayer(guildId);
    interaction.channelId = player?.textChannelId || client.library.settings(guildId).musicTextChannelId;
    started = true;
  };
  // A guard rechecks immediately before every enqueue-stage write. Once our
  // first queue write begins, subsequent changes are our own expected progress;
  // player identity/stopping fences still apply throughout the command.
  interaction.portalMutationStarted = () => { assertRevision(); if (!mutationStarted) assertCommandSelection(client, context, command); mutationStarted = true; };
  if (command.policy.readOnly) { await preflight(); await commandMap.get(command.command).execute(interaction); }
  else await guardedMutation(interaction, commandMap.get(command.command).execute, { ...command.policy, beforeMutation: preflight });
  context = await freshContext('finalDisclosure');
  // Captured embeds predate this final authority check. Neutral acknowledgments
  // avoid leaking queue/history names (including individually revoked history
  // sources) and never reexecute a mutation to regenerate its reply.
  const neutralRead = ['queue', 'nowplaying', 'history', 'replay'].includes(command.command)
    || (['session', 'top'].includes(command.command) && command.policy.readOnly);
  const hiddenReplySource = !visibleSession(context, client.lavalink?.getPlayer(guildId))
    || replySourceIds.some(id => !visible(context, context.channels.get(id)));
  // Every mix action can capture guild library names/counts, including a
  // completed save/load/delete. An idle nonmember maintainer still has config
  // access, but no guild-library access. Do not replay its handler for new text.
  const hiddenGuildLibrary = command.command === 'mix' && !context.member;
  if (neutralRead || hiddenGuildLibrary || (command.command !== 'help' && hiddenReplySource) || (command.command === 'settings' && !context.admin)) message = 'Request completed.';
  return { ok: true, message, snapshot: snapshotProjection(client, context, revisions.revision(guildId), revisions.nextSnapshot()) };
}
