import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  formatDuration,
  NO_MENTIONS,
  plainText,
  playbackRate,
  pluralize,
  progressBar,
  remainingTrackDuration,
  requesterName,
  safeText,
  safeUrl,
  trackIdentity,
} from './presentation.js';
import { getAudioPreset } from './filters.js';
import { sleepTimer } from './sleep-timer.js';
import { config } from '../config.js';

export const COLORS = Object.freeze({
  // Restrained from the app icon: electric cyan carries active product state,
  // magenta is the Vybatron signature, and amber is reserved for pause/warning.
  brand: 0x00c8ff,
  accent: 0xf20aa7,
  paused: 0xffb84d,
  recovering: 0xffb84d,
  error: 0xed4245,
  info: 0xf20aa7,
  neutral: 0x6d6f78,
});

export const QUEUE_PAGE_SIZE = 10;

const PLAYER_IDS = Object.freeze({
  toggle: 'player:v1:toggle',
  skip: 'player:v1:skip',
  back: 'player:v1:back',
  shuffle: 'player:v1:shuffle',
  loop: 'player:v1:loop',
  seek: 'player:v1:seek',
  queue: 'player:v1:queue',
  refresh: 'player:v1:refresh',
  stop: 'player:v1:stop',
});

export function textPayload(content) {
  return {
    content: plainText(content, { maxLength: 1900 }),
    allowedMentions: NO_MENTIONS,
  };
}

export function ephemeralText(content) {
  return { ...textPayload(content), flags: MessageFlags.Ephemeral };
}

export function errorPayload(message, referenceId) {
  const description = referenceId
    ? `${safeText(message, { maxLength: 3500 })}\n\nReference: \`${safeText(referenceId, { maxLength: 16 })}\``
    : safeText(message, { maxLength: 3900 });
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.error).setTitle('Couldn’t complete that action').setDescription(description)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS,
  };
}

function playerStatus(state) {
  switch (state) {
    case 'paused': return { label: 'Paused', color: COLORS.paused };
    case 'recovering': return { label: 'Recovering audio', color: COLORS.recovering };
    case 'queue-finished': return { label: 'Queue Finished', color: COLORS.neutral };
    case 'unavailable': return { label: 'Playback Unavailable', color: COLORS.error };
    case 'ended': return { label: 'Session Ended', color: COLORS.neutral };
    default: return { label: 'Now Playing', color: COLORS.brand };
  }
}

function playerComponents(player, state, track) {
  const active = state === 'playing' || state === 'paused';
  const recovering = state === 'recovering';
  const disabled = !active || !track;
  const playbackRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.toggle)
      .setLabel(state === 'paused' ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.skip)
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled && !recovering),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.queue)
      .setLabel('View queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active && !recovering),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.stop)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!active && !recovering),
    new ButtonBuilder()
      .setCustomId(`player:v2:favorite:${trackIdentity(track)}`)
      .setLabel('Favorite')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
  const utilityRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.back)
      .setLabel('Back')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.shuffle)
      .setLabel('Shuffle')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.loop)
      .setLabel(`Loop: ${player?.repeatMode || 'off'}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.seek)
      .setLabel('Seek')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(
        disabled
        || track?.info?.isStream
        || track?.info?.isSeekable === false
        || !Number.isFinite(track?.info?.duration)
        || track.info.duration <= 0
      ),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.refresh)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active && !recovering)
  );

  // Both control rows are full, so outbound links share their own row.
  const linkRow = new ActionRowBuilder();
  if (config.portalOrigin) {
    linkRow.addComponents(
      new ButtonBuilder().setLabel('Open web player').setStyle(ButtonStyle.Link).setURL(config.portalOrigin)
    );
  }
  const trackUrl = safeUrl(track?.info?.uri, { maxLength: 512 });
  if (trackUrl) {
    linkRow.addComponents(
      new ButtonBuilder().setLabel('Open track').setStyle(ButtonStyle.Link).setURL(trackUrl)
    );
  }
  return linkRow.components.length ? [playbackRow, utilityRow, linkRow] : [playbackRow, utilityRow];
}

export function buildSeekModal(player) {
  const track = player?.queue?.current;
  const timestamp = new TextInputBuilder()
    .setCustomId('timestamp')
    .setLabel('Position (mm:ss or hh:mm:ss)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(12)
    .setValue(formatDuration(displayPosition(player)));

  return new ModalBuilder()
    .setCustomId(`player:v1:seek-submit:${trackIdentity(track)}`)
    .setTitle('Seek within track')
    .addComponents(new ActionRowBuilder().addComponents(timestamp));
}

export const SESSION_MIX_MODAL_ID = 'mix:v1:session-save';
// Names a shared mix of this session: songs already played, the current song and the queue.
export function buildSessionMixModal() {
  const name = new TextInputBuilder()
    .setCustomId('name')
    .setLabel('Mix name')
    .setPlaceholder('Late night drive')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(40);
  return new ModalBuilder()
    .setCustomId(SESSION_MIX_MODAL_ID)
    .setTitle('Save this session as a mix')
    .addComponents(new ActionRowBuilder().addComponents(name));
}

function playbackState(player) {
  return player?.paused ? 'paused' : player?.playing === false ? 'unavailable' : 'playing';
}

function displayPosition(player, state = playbackState(player)) {
  const reported = player?.lastPosition;
  const fallback = Number.isSafeInteger(reported) && reported >= 0 ? reported : 0;
  // Lavalink-client's position getter adds elapsed time even after audio stops.
  if (state !== 'playing' || player?.paused || player?.playing === false) return fallback;
  const live = player?.position;
  return Number.isFinite(live) && live >= 0 ? live : fallback;
}

function remainingCurrentDuration(player, track, state = playbackState(player)) {
  return remainingTrackDuration({ position: displayPosition(player, state), filterManager: player?.filterManager }, track);
}

function playbackLine(player, info, state) {
  const position = formatDuration(displayPosition(player, state), info.isStream);
  const duration = formatDuration(info.duration, info.isStream);
  if (!['playing', 'paused'].includes(state)) {
    return state === 'recovering' ? 'Keeping your queue while the audio reconnects.' : `${position} / ${duration}`;
  }
  if (info.isStream) return state === 'paused' ? 'Paused • Live' : 'Live';
  if (state === 'paused') return `Paused at \`${position} / ${duration}\``;
  const remaining = remainingCurrentDuration(player, { info }, state);
  if (player?.repeatMode === 'track') return `\`${position} / ${duration}\` • Track loop on`;
  if (remaining === null) return `\`${position} / ${duration}\``;
  const endsAt = Math.floor((Date.now() + remaining) / 1000);
  return `\`${position} / ${duration}\` • Ends <t:${endsAt}:R>`;
}

function playerQueuePreview(player, state) {
  const tracks = player?.queue?.tracks || [];
  if (tracks.length === 0) {
    return '**Up next**\nNothing queued — add something with `/play`.';
  }

  const preview = tracks.slice(0, 2).map((queuedTrack, index) => {
    const info = queuedTrack?.info || {};
    const title = safeText(info.title, { fallback: 'Unknown track', maxLength: 90 });
    const author = safeText(info.author, { fallback: 'Unknown artist', maxLength: 60 });
    return `${index + 1}. ${title} — ${author}`;
  });
  const remaining = remainingQueueDuration(player, { state });
  const summary = [
    `${tracks.length} ${pluralize(tracks.length, 'track')} queued`,
    player?.repeatMode && player.repeatMode !== 'off' ? `Loop: ${player.repeatMode}` : remaining === null ? 'Remaining time unknown' : `${formatDuration(remaining)} remaining`,
  ];
  return ['**Up next**', ...preview, `_${summary.join(' • ')}_`].join('\n');
}

export function remainingQueueDuration(player, { state = playbackState(player) } = {}) {
  const current = player?.queue?.current;
  const tracks = player?.queue?.tracks || [];
  if (player?.repeatMode && player.repeatMode !== 'off') return null;
  const rate = playbackRate(player);
  if (!rate) return null;
  let total = current ? remainingCurrentDuration(player, current, state) : 0;
  if (total === null) return null;
  for (const queued of tracks) {
    const info = queued?.info;
    if (!info || info.isStream || !Number.isFinite(info.duration) || info.duration <= 0) return null;
    total += info.duration / rate;
  }
  return total;
}

function queueStartDelay(player, index) {
  if (player?.paused || player?.playing === false || (player?.repeatMode && player.repeatMode !== 'off')) return null;
  const rate = playbackRate(player);
  if (!rate) return null;
  let delay = player?.queue?.current ? remainingCurrentDuration(player, player.queue.current) : 0;
  if (delay === null) return null;
  const tracks = player?.queue?.tracks || [];
  for (let previous = 0; previous < index; previous += 1) {
    const info = tracks[previous]?.info;
    if (!info || info.isStream || !Number.isFinite(info.duration) || info.duration <= 0) return null;
    delay += info.duration / rate;
  }
  return delay;
}

export function buildPlayerPayload(player, {
  state = player?.paused ? 'paused' : 'playing',
  track = player?.queue?.current || null,
  startedAt = Date.now(),
  notice = null,
  reason = null,
} = {}) {
  const status = playerStatus(state);
  const embed = new EmbedBuilder().setColor(status.color).setAuthor({ name: status.label });

  if (track?.info) {
    const info = track.info;
    embed.setTitle(safeText(info.title, { fallback: 'Unknown track', maxLength: 256 }));
    const uri = safeUrl(info.uri);
    if (uri) embed.setURL(uri);
    const artwork = safeUrl(info.artworkUrl);
    if (artwork) embed.setThumbnail(artwork);

    const volume = Number.isFinite(player?.volume) ? Math.round(player.volume) : 100;
    const lines = [
      safeText(info.author, { fallback: 'Unknown artist', maxLength: 160 }),
      playbackLine(player, info, state),
      '',
      playerQueuePreview(player, state),
    ];
    const progress = !info.isStream && ['playing', 'paused'].includes(state)
      ? progressBar(displayPosition(player, state), info.duration)
      : null;
    if (progress) lines.splice(2, 0, `\`${progress}\``);
    const sleep = state === 'ended' ? null : sleepTimer(player);
    if (sleep) lines.push('', sleep.mode === 'track' ? 'Sleep timer: stops after this track' : `Sleep timer: stops <t:${Math.ceil(sleep.endsAt / 1000)}:R>`);
    if (notice) lines.push('', `> ${safeText(notice, { maxLength: 500 })}`);
    if (reason) lines.push('', safeText(reason, { maxLength: 500 }));
    embed.setDescription(lines.join('\n'));

    const requester = requesterName(track);
    const audio = getAudioPreset(player);
    const source = info.sourceName ? ` • ${plainText(info.sourceName, { maxLength: 30 })}` : '';
    const preset = audio.label !== 'Original' ? ` • ${audio.label}` : '';
    const footer = `${requester ? `Requested by ${requester} • ` : ''}Volume ${volume}%${preset}${source}`;
    embed.setFooter({ text: footer });
    if (Number.isFinite(startedAt)) embed.setTimestamp(startedAt);
  } else {
    const fallback = reason || (state === 'queue-finished'
      ? 'No tracks remain. Add something within five minutes to keep this session open.'
      : 'This playback session is no longer active.');
    embed.setTitle(status.label).setDescription(safeText(fallback, { maxLength: 1000 }));
  }

  return { embeds: [embed], components: playerComponents(player, state, track), allowedMentions: NO_MENTIONS };
}

export function clampQueuePage(player, page) {
  const total = player?.queue?.tracks?.length || 0;
  const maxPage = Math.max(0, Math.ceil(total / QUEUE_PAGE_SIZE) - 1);
  return Math.min(Math.max(Number.parseInt(page, 10) || 0, 0), maxPage);
}

function queueLine(track, index, delay = null) {
  const info = track?.info || {};
  const title = safeText(info.title, { fallback: 'Unknown track', maxLength: 110 });
  const author = safeText(info.author, { fallback: 'Unknown artist', maxLength: 70 });
  const duration = formatDuration(info.duration, info.isStream);
  const requester = requesterName(track);
  const requestedBy = requester ? ` • ${safeText(requester, { maxLength: 50 })}` : '';
  const eta = delay === null ? '' : ` • in ~${formatDuration(delay)}`;
  return `**${index}.** ${title} — ${author} • \`${duration}\`${eta}${requestedBy}`;
}

function currentQueueLine(track) {
  const info = track?.info || {};
  const requester = requesterName(track);
  const requestedBy = requester ? ` • ${safeText(requester, { maxLength: 50 })}` : '';
  return `${safeText(info.title, { fallback: 'Unknown track', maxLength: 150 })} — ${safeText(info.author, { fallback: 'Unknown artist', maxLength: 90 })} • \`${formatDuration(info.duration, info.isStream)}\`${requestedBy}`;
}

export function buildQueuePayload(player, requestedPage = 0, ownerId = 'any') {
  const current = player?.queue?.current || null;
  const tracks = player?.queue?.tracks || [];
  const page = clampQueuePage(player, requestedPage);
  const start = page * QUEUE_PAGE_SIZE;
  const pageTracks = tracks.slice(start, start + QUEUE_PAGE_SIZE);
  const end = start + pageTracks.length;
  const total = tracks.length;

  const lines = [];
  if (current?.info) {
    lines.push(`**Now playing**\n${currentQueueLine(current)}`);
  }
  lines.push(total > 0 ? `**Up next • ${start + 1}–${end} of ${total}**` : '**Up next**\nNo tracks queued.');
  pageTracks.forEach((track, offset) => lines.push(queueLine(track, start + offset + 1, queueStartDelay(player, start + offset))));

  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Queue')
    .setDescription(lines.join('\n'));
  const remaining = remainingQueueDuration(player);
  embed.setFooter({
    text: `${total} upcoming • ${player?.repeatMode && player.repeatMode !== 'off' ? `Loop: ${player.repeatMode}` : remaining === null ? 'Unknown remaining' : `${formatDuration(remaining)} remaining`}${player?.paused ? ' • Paused' : ''}`,
  });
  const artwork = safeUrl(current?.info?.artworkUrl);
  if (artwork) embed.setThumbnail(artwork);

  const maxPage = Math.max(0, Math.ceil(total / QUEUE_PAGE_SIZE) - 1);
  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:v2:page:${ownerId}:${Math.max(0, page - 1)}:previous`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`queue:v2:page:${ownerId}:${Math.min(maxPage, page + 1)}:next`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= maxPage),
    new ButtonBuilder()
      .setCustomId(`queue:v2:refresh:${ownerId}:${page}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [navigation];
  if (pageTracks.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`queue:v2:jump:${ownerId}:${page}`)
      .setPlaceholder('Jump to a track…')
      .addOptions(pageTracks.map((track, offset) => {
        const absoluteIndex = start + offset + 1;
        return {
          label: plainText(track?.info?.title, { fallback: 'Unknown track', maxLength: 100 }),
          description: plainText(
            `${track?.info?.author || 'Unknown artist'} • ${formatDuration(track?.info?.duration, track?.info?.isStream)}`,
            { maxLength: 100 }
          ),
          value: `${absoluteIndex}:${trackIdentity(track)}`,
        };
      }));
    components.push(new ActionRowBuilder().addComponents(select));
  }

  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

export function buildStopConfirmationPayload() {
  return {
    content: 'Stop playback, clear the queue, and disconnect? Save as mix keeps this session’s songs as a shared mix first.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('player:v1:stop-confirm')
        .setLabel('Stop and disconnect')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('player:v1:stop-save')
        .setLabel('Save as mix…')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('player:v1:stop-cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    )],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS,
  };
}

export function buildEmptyQueuePayload() {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.neutral)
      .setTitle('Queue is empty')
      .setDescription('Add something with `/play`.')],
    components: [],
    allowedMentions: NO_MENTIONS,
  };
}
