import { createHash } from 'node:crypto';
import { plainText } from '../utils/presentation.js';
import { catalogUrl, LIBRARY_LIMITS, validId } from '../utils/library.js';
import { savedSession } from '../utils/sessions.js';
import { AUDIO_PRESETS, getAudioPreset } from '../utils/filters.js';
import { radioState } from '../utils/radio.js';
import { isPlaybackRecovering } from '../playback-recovery.js';
import { getControllerRecord } from '../utils/player-controller.js';
import { seekRevision } from '../utils/operations.js';
import { djAccess, visible, visibleSession, writable, TEXT_TYPES, VOICE_TYPES } from './policy.js';
import { publicTrackId, mixVersion } from './selections.js';

export function safeImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 1024) return null;
    const paths = {
      'cdn.discordapp.com': /^\/(?:avatars|icons|embed\/avatars)\/[\w/.\-]+$/,
      'media.discordapp.net': /^\/(?:avatars|icons)\/[\w/.\-]+$/,
      'i.ytimg.com': /^\/vi(?:_webp)?\/[\w-]{11}\/[\w.-]+$/,
      'img.youtube.com': /^\/vi\/[\w-]{11}\/[\w.-]+$/,
      'i.scdn.co': /^\/image\/[a-z0-9]+$/,
      'i1.sndcdn.com': /^\/[\w-]+\.(?:jpg|png|webp)$/,
      'f4.bcbits.com': /^\/img\/[\w-]+\.(?:jpg|png|webp)$/,
    };
    if (!paths[url.hostname]?.test(url.pathname)) return null;
    url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}
export function boundedNumber(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) { return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback; }
export function actorProjection(user) {
  if (!validId(user?.id)) return null;
  return { id: user.id, displayName: plainText(user.displayName || user.globalName || user.username, { maxLength: 80 }), avatarUrl: safeImage(user.displayAvatarURL?.() || user.avatarUrl) };
}
export function trackProjection(track) {
  const info = track?.info || track || {};
  const referenceUri = catalogUrl(info.uri);
  const uri = referenceUri?.length <= 512 ? referenceUri : null;
  const source = plainText(info.sourceName, { fallback: 'unknown', maxLength: 40 });
  // Encodings, requester tokens, pluginInfo and media URLs never enter a DTO.
  const id = publicTrackId(track);
  const youtubeId = uri?.startsWith('https://www.youtube.com/watch?') ? new URL(uri).searchParams.get('v') : null;
  return { id, title: plainText(info.title, { fallback: 'Unknown track', maxLength: 180 }), author: plainText(info.author, { fallback: 'Unknown artist', maxLength: 120 }), uri, source,
    durationMs: boundedNumber(info.duration), artworkUrl: safeImage(info.artworkUrl) || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg` : null),
    isStream: Boolean(info.isStream), requestedBy: actorProjection(track?.requester) };
}
export function guildProjection(context) { return { id: context.guild.id, name: plainText(context.guild.name, { maxLength: 100 }), iconUrl: safeImage(context.guild.iconURL?.()), admin: context.admin }; }
export const FILTERS = Object.entries(AUDIO_PRESETS).map(([id, preset]) => ({ id, label: preset.label, description: preset.description }));

export function createRevisions(client) {
  const epochs = new Map(); const objects = new WeakMap(); let nextObject = 0;
  const objectId = value => {
    if (!value || typeof value !== 'object') return null;
    if (!objects.has(value)) objects.set(value, ++nextObject);
    return objects.get(value);
  };
  const listeners = [];
  for (const event of ['trackStart', 'trackEnd', 'queueEnd', 'playerDestroy']) {
    const handler = player => { if (player?.guildId) epochs.set(player.guildId, (epochs.get(player.guildId) || 0) + 1); };
    client.lavalink?.on?.(event, handler); listeners.push([event, handler]);
  }
  const revision = guildId => {
    const player = client.lavalink?.getPlayer(guildId);
    const guild = client.library.readGuild(guildId);
    const checkpoint = savedSession(client.library, guildId);
    const current = player?.queue?.current;
    const signature = [epochs.get(guildId) || 0, objectId(player), objectId(current), current ? trackProjection(current).id : null,
      (player?.queue?.tracks || []).map(track => [objectId(track), trackProjection(track).id]), player?.voiceChannelId, player?.textChannelId,
      Boolean(player?.paused), Boolean(player?.playing), Boolean(isPlaybackRecovering(player)), player?.volume, player?.repeatMode, getAudioPreset(player).label,
      seekRevision(player),
      Boolean(radioState(player).enabled), guild.settings, guild.mixes, guild.history.map(item => item.id),
      checkpoint ? [checkpoint.voiceChannelId, checkpoint.textChannelId, checkpoint.tracks, checkpoint.paused, checkpoint.volume, checkpoint.repeatMode] : null];
    return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 32);
  };
  return { revision, close() { for (const [event, handler] of listeners) client.lavalink?.off?.(event, handler); epochs.clear(); } };
}

const channelProjection = channel => channel ? { id: channel.id, name: plainText(channel.name, { maxLength: 100 }) } : null;
export function snapshotProjection(client, context, revision) {
  const id = context.guild.id;
  const player = client.lavalink?.getPlayer(id);
  const allowed = visibleSession(context, player);
  const saved = savedSession(client.library, id);
  const savedVisible = saved && visible(context, context.channels.get(saved.voiceChannelId)) && visible(context, context.channels.get(saved.textChannelId));
  const settings = client.library.settings(id);
  const voice = context.member?.voice?.channel;
  const sameVoice = Boolean(context.member && voice && visible(context, context.channels.get(voice.id)) && (!player?.voiceChannelId || player.voiceChannelId === voice.id));
  const botVoiceAccess = voice && voice.joinable !== false && voice.speakable !== false;
  const musicChannel = context.channels.get(settings.musicTextChannelId);
  const canAdd = Boolean(allowed && sameVoice && botVoiceAccess && (player || (writable(context, musicChannel) && visible(context, musicChannel))));
  const preset = getAudioPreset(player);
  const current = allowed ? player?.queue?.current : null;
  const recovering = Boolean(player && isPlaybackRecovering(player));
  const controllerState = getControllerRecord(id)?.state;
  const status = !allowed || !player ? 'idle' : recovering ? 'recovering' : controllerState === 'unavailable' || player.node?.connected === false ? 'unavailable' : !current ? 'idle' : player.paused ? 'paused' : 'playing';
  const listeners = allowed ? [...(context.channels.get(player?.voiceChannelId)?.members?.values() || [])].filter(member => !member.user.bot).slice(0, 100).map(member => actorProjection({ ...member.user, id: member.id, displayName: member.displayName, avatarUrl: member.user.displayAvatarURL?.() })).filter(Boolean) : [];
  const reason = !allowed ? 'The listening channel is not visible to you.' : !context.member ? 'Join this server to control playback.' : !sameVoice ? 'Join the listening voice channel to control playback.' : !player && !canAdd ? 'An administrator must configure a visible music text channel.' : !djAccess(context, client) ? 'Playback controls require the DJ role.' : null;
  const channels = context.admin ? [...context.channels.values()].filter(channel => channel && visible(context, channel) && (TEXT_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type))).slice(0, 500).map(channel => ({ ...channelProjection(channel), type: VOICE_TYPES.has(channel.type) ? 'voice' : 'text' })) : [];
  return { guild: guildProjection(context), revision,
    session: { status, voiceChannel: allowed ? channelProjection(context.channels.get(player?.voiceChannelId)) : null, textChannel: allowed ? channelProjection(context.channels.get(player?.textChannelId)) : null,
      current: current ? trackProjection(current) : null, queue: allowed ? (player?.queue?.tracks || []).slice(0, LIBRARY_LIMITS.queue).map(trackProjection) : [],
      positionMs: current ? boundedNumber(status === 'playing' ? player.position : player.lastPosition ?? player.position, 0, boundedNumber(current.info?.duration) || Number.MAX_SAFE_INTEGER) : 0,
      durationMs: current ? boundedNumber(current.info?.duration) : 0, volume: allowed ? boundedNumber(player?.volume, settings.volume, 100) : 100,
      filter: allowed ? FILTERS.find(filter => filter.label === preset.label)?.id || 'custom' : 'off', repeat: allowed && ['off', 'track', 'queue'].includes(player?.repeatMode) ? player.repeatMode : 'off',
      radio: allowed && Boolean(player && radioState(player).enabled), fairQueue: allowed && settings.fairQueue, listeners,
      canAdd, canControl: Boolean(allowed && player && sameVoice && djAccess(context, client)), canVote: Boolean(allowed && current && sameVoice), reason },
    savedSession: { exists: Boolean(savedVisible), savedAt: savedVisible ? saved.savedAt : null, positionMs: savedVisible ? saved.position : 0, paused: savedVisible ? saved.paused : false,
      trackCount: savedVisible ? saved.tracks.length : 0, voiceChannel: savedVisible ? channelProjection(context.channels.get(saved.voiceChannelId)) : null,
      canResume: Boolean(savedVisible && voice?.id === saved.voiceChannelId && botVoiceAccess && writable(context, context.channels.get(saved.textChannelId)) && djAccess(context, client) && !(player?.queue?.current || player?.queue?.tracks?.length)) },
    settings: context.admin ? { volume: boundedNumber(settings.volume, 100, 100), fairQueue: Boolean(settings.fairQueue), djRoleId: settings.djRoleId || null, musicTextChannelId: settings.musicTextChannelId || null } : null,
    channels, roles: context.admin ? [...context.roles.values()].slice(0, 250).map(role => ({ id: role.id, name: plainText(role.name, { maxLength: 100 }) })) : [] };
}

export function activityProjection(client, guildId) {
  return { items: client.library.readGuild(guildId).activity.slice(0, LIBRARY_LIMITS.activity).map(item => ({ id: plainText(item.id, { maxLength: 40 }), at: boundedNumber(item.at),
    actor: { id: item.actor.id, displayName: plainText(item.actor.displayName, { maxLength: 80 }) }, action: item.action === 'settings' ? 'settings' : 'queue',
    detail: item.action === 'settings' ? 'Listening defaults updated.' : 'Listening queue updated.' })) };
}

export function libraryProjection(client, context) {
  const guild = client.library.readGuild(context.guild.id);
  return { favorites: client.library.favorites(context.user.id).slice(0, LIBRARY_LIMITS.favorites).map(trackProjection),
    mixes: context.member ? Object.entries(guild.mixes).slice(0, LIBRARY_LIMITS.mixes).map(([name, mix]) => ({ id: name, name, ownerId: mix.ownerId, version: mixVersion(mix), tracks: mix.tracks.map(trackProjection), canEdit: mix.ownerId === context.user.id || context.guildAdmin })) : [],
    history: guild.history.filter(item => visible(context, context.channels.get(item.voiceChannelId))).map(item => ({ id: item.id, playedAt: item.playedAt, voiceChannel: channelProjection(context.channels.get(item.voiceChannelId)), track: trackProjection(item.track) })) };
}
