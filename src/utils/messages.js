import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
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
  brand: 0x009e85,
  error: 0xed4245,
  info: 0x5865f2,
  neutral: 0x6d6f78,
});

export const QUEUE_PAGE_SIZE = 10;

const PLAYER_IDS = Object.freeze({
  toggle: 'player:v1:toggle',
  skip: 'player:v1:skip',
  queue: 'player:v1:queue',
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
    case 'paused': return { label: 'Paused', color: COLORS.info };
    case 'queue-finished': return { label: 'Queue Finished', color: COLORS.neutral };
    case 'unavailable': return { label: 'Playback Unavailable', color: COLORS.error };
    case 'ended': return { label: 'Session Ended', color: COLORS.neutral };
    default: return { label: 'Now Playing', color: COLORS.brand };
  }
}

function playerComponents(player, state, track) {
  const active = state === 'playing' || state === 'paused';
  const sessionClosed = state === 'ended' || state === 'unavailable';
  const hasQueue = (player?.queue?.tracks?.length || 0) > 0;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.toggle)
      .setLabel(state === 'paused' ? 'Resume' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!active || !track),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.skip)
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!active || !track || !hasQueue),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.queue)
      .setLabel('View queue')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(sessionClosed || (!track && !hasQueue)),
    new ButtonBuilder()
      .setCustomId(PLAYER_IDS.stop)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(sessionClosed)
  );

  const trackUrl = safeUrl(track?.info?.uri);
  if (trackUrl) {
    row.addComponents(
      new ButtonBuilder().setLabel('Open track').setStyle(ButtonStyle.Link).setURL(trackUrl)
    );
  }
  return [row];
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

    const queued = player?.queue?.tracks?.length || 0;
    const volume = Number.isFinite(player?.volume) ? Math.round(player.volume) : 100;
    const lines = [
      safeText(info.author, { fallback: 'Unknown artist', maxLength: 160 }),
      `\`${formatDuration(player?.position, info.isStream)} / ${formatDuration(info.duration, info.isStream)}\` • ${queued} ${pluralize(queued, 'track')} queued • Volume ${volume}%`,
    ];
    if (notice) lines.push(`> ${safeText(notice, { maxLength: 500 })}`);
    if (reason) lines.push(safeText(reason, { maxLength: 500 }));
    embed.setDescription(lines.join('\n'));

    const requester = requesterName(track);
    if (requester) embed.setFooter({ text: `Requested by ${requester}` });
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

export function buildQueuePayload(player, requestedPage = 0) {
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
    .setColor(COLORS.info)
    .setTitle('Queue')
    .setDescription(lines.join('\n'));
  const artwork = safeUrl(current?.info?.artworkUrl);
  if (artwork) embed.setThumbnail(artwork);

  const maxPage = Math.max(0, Math.ceil(total / QUEUE_PAGE_SIZE) - 1);
  const navigation = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue:v1:page:${Math.max(0, page - 1)}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`queue:v1:page:${Math.min(maxPage, page + 1)}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= maxPage),
    new ButtonBuilder()
      .setCustomId(`queue:v1:refresh:${page}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [navigation];
  if (pageTracks.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`queue:v1:jump:${page}`)
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
