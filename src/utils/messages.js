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
  pluralize,
  requesterName,
  safeText,
  safeUrl,
  trackIdentity,
} from './presentation.js';

export const COLORS = Object.freeze({
  // Restrained from the app icon: electric cyan carries active product state,
  // magenta is the Vybertron signature, and amber is reserved for pause/warning.
  brand: 0x00c8ff,
  accent: 0xf20aa7,
  paused: 0xffb84d,
  error: 0xed4245,
  info: 0xf20aa7,
  neutral: 0x6d6f78,
});

export const QUEUE_PAGE_SIZE = 10;

const PLAYER_IDS = Object.freeze({
  toggle: 'player:v1:toggle',
  skip: 'player:v1:skip',
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
    case 'queue-finished': return { label: 'Queue Finished', color: COLORS.neutral };
    case 'unavailable': return { label: 'Playback Unavailable', color: COLORS.error };
    case 'ended': return { label: 'Session Ended', color: COLORS.neutral };
    default: return { label: 'Now Playing', color: COLORS.brand };
  }
}

function playerComponents(player, state, track) {
  const active = state === 'playing' || state === 'paused';
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
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.queue)
      .setLabel('View queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.stop)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
  const utilityRow = new ActionRowBuilder().addComponents(
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
      .setDisabled(disabled)
  );

  const trackUrl = safeUrl(track?.info?.uri);
  if (trackUrl) {
    utilityRow.addComponents(
      new ButtonBuilder().setLabel('Open track').setStyle(ButtonStyle.Link).setURL(trackUrl)
    );
  }
  return [playbackRow, utilityRow];
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
    .setValue(formatDuration(player?.position || 0));

  return new ModalBuilder()
    .setCustomId(`player:v1:seek-submit:${trackIdentity(track)}`)
    .setTitle('Seek within track')
    .addComponents(new ActionRowBuilder().addComponents(timestamp));
}

function playbackLine(player, info, state) {
  const position = formatDuration(player?.position, info.isStream);
  const duration = formatDuration(info.duration, info.isStream);
  if (info.isStream) return state === 'paused' ? 'Paused • Live' : 'Live';
  if (state === 'paused') return `Paused at \`${position} / ${duration}\``;
  const remaining = Math.max(0, (info.duration || 0) - (player?.position || 0));
  const endsAt = Math.floor((Date.now() + remaining) / 1000);
  return `\`${position} / ${duration}\` • Ends <t:${endsAt}:R>`;
}

function playerQueuePreview(player) {
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
  const remaining = remainingQueueDuration(player);
  const summary = [
    `${tracks.length} ${pluralize(tracks.length, 'track')} queued`,
    remaining === null ? 'Remaining time unknown' : `${formatDuration(remaining)} remaining`,
  ];
  return ['**Up next**', ...preview, `_${summary.join(' • ')}_`].join('\n');
}

export function remainingQueueDuration(player) {
  const current = player?.queue?.current;
  const tracks = player?.queue?.tracks || [];
  if (current?.info?.isStream || tracks.some((queued) => queued?.info?.isStream)) return null;
  let total = current ? Math.max(0, (current.info?.duration || 0) - (player?.position || 0)) : 0;
  for (const queued of tracks) total += Math.max(0, queued?.info?.duration || 0);
  return total;
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
    embed.setTitle(plainText(info.title, { fallback: 'Unknown track', maxLength: 256 }));
    const uri = safeUrl(info.uri);
    if (uri) embed.setURL(uri);
    const artwork = safeUrl(info.artworkUrl);
    if (artwork) embed.setThumbnail(artwork);

    const volume = Number.isFinite(player?.volume) ? Math.round(player.volume) : 100;
    const lines = [
      safeText(info.author, { fallback: 'Unknown artist', maxLength: 160 }),
      playbackLine(player, info, state),
      '',
      playerQueuePreview(player),
    ];
    if (notice) lines.push('', `> ${safeText(notice, { maxLength: 500 })}`);
    if (reason) lines.push('', safeText(reason, { maxLength: 500 }));
    embed.setDescription(lines.join('\n'));

    const requester = requesterName(track);
    const footer = requester ? `Requested by ${requester} • Volume ${volume}%` : `Volume ${volume}%`;
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

function queueLine(track, index) {
  const info = track?.info || {};
  const title = safeText(info.title, { fallback: 'Unknown track', maxLength: 110 });
  const author = safeText(info.author, { fallback: 'Unknown artist', maxLength: 70 });
  const duration = formatDuration(info.duration, info.isStream);
  const requester = requesterName(track);
  const requestedBy = requester ? ` • ${safeText(requester, { maxLength: 50 })}` : '';
  return `**${index}.** ${title} — ${author} • \`${duration}\`${requestedBy}`;
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
  pageTracks.forEach((track, offset) => lines.push(queueLine(track, start + offset + 1)));

  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('Queue')
    .setDescription(lines.join('\n'));
  const remaining = remainingQueueDuration(player);
  embed.setFooter({
    text: `${total} upcoming • ${remaining === null ? 'Unknown remaining' : `${formatDuration(remaining)} remaining`}`,
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
    content: 'Stop playback, clear the queue, and disconnect?',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('player:v1:stop-confirm')
        .setLabel('Stop and disconnect')
        .setStyle(ButtonStyle.Danger),
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
