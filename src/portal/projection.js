import { createHash, randomUUID } from 'node:crypto';
import { plainText } from '../utils/presentation.js';
import { catalogUrl, LIBRARY_LIMITS, validId } from '../utils/library.js';
import { savedSession, usableSession } from '../utils/sessions.js';
import { AUDIO_PRESETS, getAudioPreset } from '../utils/filters.js';
import { autoplayActive, autoplayMode, isAutoplayTrack, radioState, suggestions } from '../utils/radio.js';
import { ATTEMPT_KEY, isPlaybackRecovering } from '../playback-recovery.js';
import { getControllerRecord } from '../utils/player-controller.js';
import { seekRevision } from '../utils/operations.js';
import { sleepTimer } from '../utils/sleep-timer.js';
import { actorVoiceId, djAccess, visible, visibleHistory, visibleSession, writable, TEXT_TYPES, VOICE_TYPES } from './policy.js';
import { publicTrackId, mixVersion } from './selections.js';
import { STATS_WINDOWS } from '../utils/play-stats.js';
import { personalPlaylists } from '../utils/auto-playlists.js';
import { fail, PortalError } from './errors.js';

export function safeImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 1024) return null;
    const paths = {
      'cdn.discordapp.com': /^\/(?:avatars|icons|embed\/avatars)\/[\w/.-]+$/,
      'media.discordapp.net': /^\/(?:avatars|icons)\/[\w/.-]+$/,
      'i.ytimg.com': /^\/vi(?:_webp)?\/[\w-]{11}\/[\w.-]+$/,
      'img.youtube.com': /^\/vi\/[\w-]{11}\/[\w.-]+$/,
      // YouTube Music album art, which Lavalink sizes as `=w1000-h1000`.
      'lh3.googleusercontent.com': /^\/[\w-]{16,}=w\d{1,4}-h\d{1,4}$/,
      'yt3.googleusercontent.com': /^\/[\w-]{16,}=w\d{1,4}-h\d{1,4}$/,
      'yt3.ggpht.com': /^\/[\w-]{16,}=w\d{1,4}-h\d{1,4}$/,
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
// Session tracks carry `suggested`: true for autoplay picks, whose requester is the bot.
export function trackProjection(track, suggested) {
  const info = track?.info || track || {};
  const referenceUri = catalogUrl(info.uri);
  const uri = referenceUri?.length <= 512 ? referenceUri : null;
  const source = plainText(info.sourceName, { fallback: 'unknown', maxLength: 40 });
  // Encodings, requester tokens, pluginInfo and media URLs never enter a DTO.
  const id = publicTrackId(track);
  const youtubeId = uri?.startsWith('https://www.youtube.com/watch?') ? new URL(uri).searchParams.get('v') : null;
  // Saved songs keep no artwork. The widescreen thumbnail always exists, and the portal's square
  // crop of an official song upload is its album cover; hqdefault would add letterbox bars.
  return { id, title: plainText(info.title, { fallback: 'Unknown track', maxLength: 180 }), author: plainText(info.author, { fallback: 'Unknown artist', maxLength: 120 }), uri, source,
    durationMs: boundedNumber(info.duration), artworkUrl: safeImage(info.artworkUrl) || (youtubeId ? `https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg` : null),
    isStream: Boolean(info.isStream), requestedBy: actorProjection(track?.requester), ...(suggested === undefined ? {} : { suggested: Boolean(suggested) }) };
}
export function suggestionProjection(player) { return suggestions(player).map(track => trackProjection(track, true)); }
export function guildProjection(context) { return { id: context.guild.id, name: plainText(context.guild.name, { maxLength: 100 }), iconUrl: safeImage(context.guild.iconURL?.()), admin: context.admin }; }
// Lavalink announces a song as it starts loading it, then reports its place only every few seconds.
// A fresh song's place holds still until Lavalink reports it moving, so a page never runs ahead of the audio.
const opening = new WeakSet();
const OPENING_POLL_MS = 250; const OPENING_LIMIT_MS = 10_000;
// lavalink-client advances a playing position at 1x between Lavalink's updates; a speed preset
// (Nightcore, Slow) plays the song's own time faster or slower than the clock.
function playingPosition(player) {
  const timescale = player.filterManager?.data?.timescale; const speed = (Number(timescale?.speed) || 1) * (Number(timescale?.rate) || 1);
  return player.lastPositionChange && Number.isFinite(player.lastPosition) ? player.lastPosition + (Date.now() - player.lastPositionChange) * speed : player.position;
}
export const FILTERS = Object.entries(AUDIO_PRESETS).map(([id, preset]) => ({ id, label: preset.label, description: preset.description }));

// A session revision changes exactly when shared session state does. It runs
// every scan for every active player, so its inputs are cheap: cached track IDs
// and library digests rather than a cloned library and full track projections.
export function createRevisions(client) {
  const epochs = new Map(); const objects = new WeakMap(); let nextObject = 0;
  const trackIds = new WeakMap(); const checkpoints = new Map();
  const instanceId = randomUUID(); let sequence = 0, closed = false;
  const nextSnapshot = () => {
    if (closed || !Number.isSafeInteger(sequence + 1)) throw new Error('Snapshot ordering is unavailable.');
    return { instanceId, sequence: ++sequence };
  };
  const objectId = value => {
    if (!value || typeof value !== 'object') return null;
    if (!objects.has(value)) objects.set(value, ++nextObject);
    return objects.get(value);
  };
  // publicTrackId hashes a parsed catalog URL. Lavalink can resolve a track in
  // place, so a cached ID is reused only while its identity fields are unchanged.
  const trackId = track => {
    const info = track?.info || track || {};
    const cached = track && typeof track === 'object' ? trackIds.get(track) : undefined;
    if (cached && cached.info === info && cached.uri === info.uri && cached.sourceName === info.sourceName
      && cached.identifier === info.identifier && cached.title === info.title) return cached.id;
    const id = publicTrackId(track);
    if (track && typeof track === 'object') trackIds.set(track, { info, uri: info.uri, sourceName: info.sourceName, identifier: info.identifier, title: info.title, id });
    return id;
  };
  // The checkpoint fields a revision covers, parsed once per stored checkpoint.
  const checkpoint = (guildId, text, now) => {
    if (text === null) { checkpoints.delete(guildId); return null; }
    let cached = checkpoints.get(guildId);
    if (cached?.text !== text) {
      const saved = JSON.parse(text);
      cached = { text, saved: { savedAt: saved.savedAt }, digest: createHash('sha256').update(JSON.stringify([saved.voiceChannelId, saved.textChannelId, saved.tracks, saved.paused, saved.volume, saved.repeatMode])).digest('hex') };
      checkpoints.set(guildId, cached);
    }
    return usableSession(cached.saved, now) ? cached.digest : null;
  };
  const listeners = [];
  for (const event of ['trackStart', 'trackEnd', 'queueEnd', 'playerDestroy']) {
    const handler = player => { if (player?.guildId) epochs.set(player.guildId, (epochs.get(player.guildId) || 0) + 1); };
    client.lavalink?.on?.(event, handler); listeners.push([event, handler]);
  }
  // Lavalink is playing this track's attempt. A copy from another source (TorBox)
  // keeps the catalog identifier, so only its attempt token matches.
  const sameAttempt = (remote, track) => {
    const token = track.userData?.[ATTEMPT_KEY];
    return token ? remote?.userData?.[ATTEMPT_KEY] === token : remote?.info?.identifier === track.info?.identifier;
  };
  // Asks Lavalink where a fresh song is until its place moves, then lets the position run from there.
  // While it holds, the held place is part of the revision, so a corrected place reaches the page.
  const open = async player => {
    const track = player?.queue?.current; const node = player?.node;
    if (!track || track.info?.isStream || typeof node?.fetchPlayer !== 'function' || opening.has(track)) return;
    opening.add(track);
    let first = null;
    try {
      for (const until = Date.now() + OPENING_LIMIT_MS; !closed && Date.now() < until;
        await new Promise(resolve => { setTimeout(resolve, OPENING_POLL_MS).unref?.(); })) {
        if (player.queue?.current !== track || isPlaybackRecovering(player)) return;
        const remote = await node.fetchPlayer(player.guildId).catch(() => null);
        const position = Number(remote?.state?.position);
        if (player.queue?.current !== track || isPlaybackRecovering(player) || !Number.isFinite(position)
          || !sameAttempt(remote?.track, track)) continue;
        player.lastPosition = position; player.lastPositionChange = Date.now();
        if (first !== null && position > first) return;
        first ??= position;
      }
    } finally { opening.delete(track); }
  };
  const started = player => { void open(player); };
  client.lavalink?.on?.('trackStart', started); listeners.push(['trackStart', started]);
  const revision = guildId => {
    const player = client.lavalink?.getPlayer(guildId);
    const library = client.library.revisionInputs(guildId);
    const current = player?.queue?.current;
    const signature = [epochs.get(guildId) || 0, objectId(player), objectId(current), current ? trackId(current) : null,
      (player?.queue?.tracks || []).map(track => [objectId(track), trackId(track)]), player?.voiceChannelId, player?.textChannelId,
      Boolean(player?.paused), Boolean(player?.playing), Boolean(isPlaybackRecovering(player)), player?.volume, player?.repeatMode, getAudioPreset(player).label,
      seekRevision(player), Boolean(player?.queue?.previous?.length), sleepTimer(player),
      Boolean(radioState(player).enabled), radioState(player).override, autoplayActive(client, player), suggestions(player).map(trackId),
      Boolean(current && isAutoplayTrack(player, current)), current && opening.has(current) ? player.lastPosition ?? null : false, library.document, library.historyIds, checkpoint(guildId, library.session, Date.now())];
    return createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 32);
  };
  return { revision, nextSnapshot, close() { closed = true; for (const [event, handler] of listeners) client.lavalink?.off?.(event, handler); epochs.clear(); checkpoints.clear(); } };
}

const channelProjection = channel => channel ? { id: channel.id, name: plainText(channel.name, { maxLength: 100 }) } : null;
export function configurationProjection(context) {
  return { guildId: context.guild.id,
    channels: context.admin ? [...context.channels.values()].filter(channel => channel && visible(context, channel) && (TEXT_TYPES.has(channel.type) || VOICE_TYPES.has(channel.type))).slice(0, 500).map(channel => ({ ...channelProjection(channel), type: VOICE_TYPES.has(channel.type) ? 'voice' : 'text' })) : [],
    roles: context.admin ? [...context.roles.values()].slice(0, 250).map(role => ({ id: role.id, name: plainText(role.name, { maxLength: 100 }) })) : [] };
}
export function snapshotProjection(client, context, revision, ordering) {
  const id = context.guild.id;
  const player = client.lavalink?.getPlayer(id);
  const allowed = visibleSession(context, player);
  const saved = savedSession(client.library, id);
  const savedVisible = saved && visibleSession(context, saved);
  const settings = client.library.settings(id);
  const voice = context.channels.get(actorVoiceId(context.member));
  const sameVoice = Boolean(context.member && voice && VOICE_TYPES.has(voice.type) && visible(context, voice) && (!player?.voiceChannelId || player.voiceChannelId === voice.id));
  const botVoiceAccess = voice && voice.joinable !== false && voice.speakable !== false;
  const musicChannel = context.channels.get(settings.musicTextChannelId);
  const canAdd = Boolean(allowed && sameVoice && botVoiceAccess && (player || (writable(context, musicChannel) && visible(context, musicChannel))));
  const preset = getAudioPreset(player);
  const current = allowed ? player?.queue?.current : null;
  const recovering = Boolean(player && isPlaybackRecovering(player));
  const controllerState = getControllerRecord(id)?.state;
  const status = !allowed || !player ? 'idle' : recovering ? 'recovering' : controllerState === 'unavailable' || player.node?.connected === false ? 'unavailable' : !current ? 'idle' : player.paused ? 'paused' : 'playing';
  const starting = status === 'playing' && opening.has(current);
  const listeners = allowed ? [...(context.channels.get(player?.voiceChannelId)?.members?.values() || [])].filter(member => !member.user.bot).slice(0, 100).map(member => actorProjection({ ...member.user, id: member.id, displayName: member.displayName, avatarUrl: member.user.displayAvatarURL?.() })).filter(Boolean) : [];
  const reason = !allowed ? 'The listening channel is not visible to you.' : !context.member ? 'Join this server to control playback.' : !sameVoice ? 'Join the listening voice channel to control playback.' : !player && !canAdd ? 'An administrator must configure a visible music text channel.' : !djAccess(context, client) ? 'Playback controls require the DJ role.' : null;
  const configuration = configurationProjection(context);
  return { guild: guildProjection(context), revision, ...(ordering ? { ordering } : {}),
    session: { status, voiceChannel: allowed ? channelProjection(context.channels.get(player?.voiceChannelId)) : null, textChannel: allowed ? channelProjection(context.channels.get(player?.textChannelId)) : null,
      current: current ? trackProjection(current, isAutoplayTrack(player, current)) : null, queue: allowed ? (player?.queue?.tracks || []).slice(0, LIBRARY_LIMITS.queue).map(track => trackProjection(track, isAutoplayTrack(player, track))) : [],
      suggestions: allowed && player ? suggestionProjection(player) : [],
      // Back returns to an earlier track of this session when one exists.
      hasPrevious: Boolean(allowed && player?.queue?.previous?.length),
      positionMs: current ? boundedNumber(status === 'playing' && !starting ? playingPosition(player) : player.lastPosition ?? player.position, 0, boundedNumber(current.info?.duration) || Number.MAX_SAFE_INTEGER) : 0,
      // A song still loading: its position holds until the audio moves.
      starting, durationMs: current ? boundedNumber(current.info?.duration) : 0, volume: allowed ? boundedNumber(player?.volume, settings.volume, 100) : 100,
      filter: allowed ? FILTERS.find(filter => filter.label === preset.label)?.id || 'custom' : 'off', repeat: allowed && ['off', 'track', 'queue'].includes(player?.repeatMode) ? player.repeatMode : 'off',
      radio: allowed && Boolean(player && autoplayActive(client, player)), autoplay: autoplayMode(client, id), fairQueue: allowed && settings.fairQueue, listeners,
      sleep: allowed ? sleepTimer(player) : null,
      canAdd, canControl: Boolean(allowed && player && sameVoice && djAccess(context, client)), canVote: Boolean(allowed && current && sameVoice), reason,
      // The viewer's own voice channel here, so a client can offer to move its music in.
      viewerVoice: context.member && voice && VOICE_TYPES.has(voice.type) && visible(context, voice) ? channelProjection(voice) : null },
    savedSession: { exists: Boolean(savedVisible), savedAt: savedVisible ? saved.savedAt : null, positionMs: savedVisible ? saved.position : 0, paused: savedVisible ? saved.paused : false,
      trackCount: savedVisible ? saved.tracks.length : 0, voiceChannel: savedVisible ? channelProjection(context.channels.get(saved.voiceChannelId)) : null,
      canResume: Boolean(savedVisible && voice?.id === saved.voiceChannelId && botVoiceAccess && writable(context, context.channels.get(saved.textChannelId)) && djAccess(context, client) && !(player?.queue?.current || player?.queue?.tracks?.length)) },
    settings: context.admin ? { volume: boundedNumber(settings.volume, 100, 100), fairQueue: Boolean(settings.fairQueue), autoplay: autoplayMode(client, id), djRoleId: settings.djRoleId || null, musicTextChannelId: settings.musicTextChannelId || null } : null,
    channels: configuration.channels, roles: configuration.roles };
}

export function activityProjection(client, guildId) {
  return { items: client.library.readGuild(guildId).activity.slice(0, LIBRARY_LIMITS.activity).map(item => ({ id: plainText(item.id, { maxLength: 40 }), at: boundedNumber(item.at),
    actor: { id: item.actor.id, displayName: plainText(item.actor.displayName, { maxLength: 80 }) }, action: item.action === 'settings' ? 'settings' : 'queue',
    detail: item.action === 'settings' ? 'Listening defaults updated.' : 'Listening queue updated.' })) };
}

export function libraryProjection(client, context) {
  const guild = client.library.readGuild(context.guild.id);
  return { favorites: client.library.favorites(context.user.id).slice(0, LIBRARY_LIMITS.favorites).map(track => trackProjection(track)),
    mixes: context.member ? Object.entries(guild.mixes).slice(0, LIBRARY_LIMITS.mixes).map(([name, mix]) => ({ id: name, name, ownerId: mix.ownerId, version: mixVersion(mix), tracks: mix.tracks.map(track => trackProjection(track)), canEdit: mix.ownerId === context.user.id || context.guildAdmin })) : [],
    history: guild.history.filter(item => visibleHistory(context, item)).map(item => ({ id: item.id, playedAt: item.playedAt, voiceChannel: channelProjection(context.channels.get(item.voiceChannelId)), track: trackProjection(item.track) })) };
}

export const STATS_WINDOW_IDS = Object.freeze([...Object.keys(STATS_WINDOWS), 'all']);
const statEntry = item => ({ track: trackProjection(item.track), plays: boundedNumber(item.plays), lastPlayedAt: boundedNumber(item.lastPlayedAt) });

// Server favorites and the actor's own request stats. Only plays in voice
// channels this actor can currently see contribute; requester identities of
// other listeners never leave the bot.
export function statsProjection(client, context, window = '30d', now = Date.now()) {
  const stats = client.stats;
  const unavailable = () => fail(503, 'stats_unavailable', 'Listening stats are unavailable right now. Playback is unaffected.');
  if (!stats?.available) unavailable();
  try {
    const guildId = context.guild.id;
    const visibleChannelIds = context.member ? stats.voiceChannelIds(guildId).filter(id => visibleHistory(context, { voiceChannelId: id })) : [];
    const since = window === 'all' ? 0 : now - STATS_WINDOWS[window];
    const server = stats.serverFavorites(guildId, { visibleChannelIds, now });
    const scope = { since, visibleChannelIds };
    const favorites = client.library.favorites(context.user.id);
    return {
      serverFavorites: { onRepeat: server.onRepeat.map(statEntry), forgottenGems: server.forgottenGems.map(statEntry) },
      personal: { window,
        topTracks: stats.topTracks(guildId, context.user.id, { ...scope, limit: 25 }).map(statEntry),
        topArtists: stats.topArtists(guildId, context.user.id, { ...scope, limit: 10 }).map(artist => ({ name: plainText(artist.artist, { fallback: 'Unknown artist', maxLength: 120 }),
          plays: boundedNumber(artist.plays), lastPlayedAt: boundedNumber(artist.lastPlayedAt), track: trackProjection(artist.track) })),
        rediscover: stats.rediscover(context.user.id, favorites, { now }).map(item => ({ index: item.index, track: trackProjection(item.track),
          requests: boundedNumber(item.requests), lastRequestedAt: item.lastRequestedAt === null ? null : boundedNumber(item.lastRequestedAt) })),
        playlists: personalPlaylists(stats, { guildId, userId: context.user.id, favorites, visibleChannelIds, since, now }).map(list => ({
          id: list.id, kind: list.kind, title: plainText(list.title, { maxLength: 130 }), artist: list.artist === null ? null : plainText(list.artist, { fallback: 'Unknown artist', maxLength: 120 }),
          tracks: list.tracks.map(trackProjection), refreshesAt: list.refreshesAt })) },
    };
  } catch (error) {
    if (error instanceof PortalError) throw error;
    return unavailable();
  }
}

export const RECAP_WINDOW_IDS = Object.freeze(Object.keys(STATS_WINDOWS));

// A listening recap over one window, under the same rules as statsProjection:
// visible voice channels only, the actor's own requests for personal numbers,
// and no requester identity in server numbers.
export function recapProjection(client, context, window = '30d', now = Date.now()) {
  const stats = client.stats;
  const unavailable = () => fail(503, 'stats_unavailable', 'Listening stats are unavailable right now. Playback is unaffected.');
  if (!stats?.available) unavailable();
  try {
    const guildId = context.guild.id;
    const visibleChannelIds = context.member ? stats.voiceChannelIds(guildId).filter(id => visibleHistory(context, { voiceChannelId: id })) : [];
    const since = now - STATS_WINDOWS[window];
    const { personal, server } = stats.recap(guildId, context.user.id, { since, visibleChannelIds });
    const totals = part => ({ plays: boundedNumber(part.plays), playedMs: boundedNumber(part.playedMs), songs: boundedNumber(part.songs) });
    return { window, since,
      personal: { ...totals(personal), topTracks: personal.topTracks.map(statEntry),
        topArtists: personal.topArtists.map(artist => ({ name: plainText(artist.artist, { fallback: 'Unknown artist', maxLength: 120 }),
          plays: boundedNumber(artist.plays), lastPlayedAt: boundedNumber(artist.lastPlayedAt), track: trackProjection(artist.track) })) },
      server: { ...totals(server), topTracks: server.topTracks.map(statEntry) } };
  } catch (error) {
    if (error instanceof PortalError) throw error;
    return unavailable();
  }
}
