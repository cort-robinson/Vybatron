import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import {
  formatDuration, NO_MENTIONS, plainText, requesterName, safeText, trackIdentity,
} from './presentation.js';
import { LIBRARY_LIMITS } from './library.js';

export const HISTORY_PAGE_SIZE = 8;
const sessions = new WeakMap();

export function historySessionKey(player) {
  if (!player) return null;
  let key = sessions.get(player);
  if (!key) {
    key = randomBytes(6).toString('hex');
    sessions.set(player, key);
  }
  return key;
}

export function historyTracks(player) {
  return Array.isArray(player?.queue?.previous) ? player.queue.previous : [];
}

export function buildHistoryPayload(player, requestedPage = 0, ownerId = 'any') {
  const tracks = historyTracks(player);
  const maxPage = Math.max(0, Math.ceil(tracks.length / HISTORY_PAGE_SIZE) - 1);
  const page = Math.min(Math.max(Number.parseInt(requestedPage, 10) || 0, 0), maxPage);
  const start = page * HISTORY_PAGE_SIZE;
  const visible = tracks.slice(start, start + HISTORY_PAGE_SIZE);
  const lines = ['Recent finished, skipped, or attempted tracks. Most recent first.'];
  if (!visible.length) lines.push('', 'No recent tracks in this session yet. Add something with `/play`.');
  for (const [offset, track] of visible.entries()) {
    const requester = requesterName(track);
    lines.push(`**${start + offset + 1}.** ${safeText(track?.info?.title, { fallback: 'Unknown track', maxLength: 130 })} — ${safeText(track?.info?.author, { fallback: 'Unknown artist', maxLength: 70 })} • \`${formatDuration(track?.info?.duration, track?.info?.isStream)}\`${requester ? ` • ${safeText(requester, { maxLength: 50 })}` : ''}`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xf20aa7)
    .setTitle('Session history')
    .setDescription(lines.join('\n'))
    .setFooter({ text: tracks.length ? `${start + 1}–${start + visible.length} of ${tracks.length} • Replay queues a track next` : 'History belongs to this playback session' });
  const session = historySessionKey(player);
  const components = [];
  if (session) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`history:v2:page:${ownerId}:${session}:${Math.max(0, page - 1)}:previous`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId(`history:v2:page:${ownerId}:${session}:${Math.min(maxPage, page + 1)}:next`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page >= maxPage),
      new ButtonBuilder().setCustomId(`history:v2:refresh:${ownerId}:${session}:${page}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    ));
  }
  if (visible.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`history:v2:replay:${ownerId}:${session}:${page}`)
      .setPlaceholder('Replay a recent track next…')
      .addOptions(visible.map((track, offset) => ({
        label: plainText(track?.info?.title, { fallback: 'Unknown track', maxLength: 100 }),
        description: plainText(`${track?.info?.author || 'Unknown artist'} • ${formatDuration(track?.info?.duration, track?.info?.isStream)}`, { maxLength: 100 }),
        value: `${start + offset + 1}:${trackIdentity(track)}`,
      })))));
  }
  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

export async function replayHistoryTrack(player, position = 1, expectedIdentity = null) {
  if (!Number.isInteger(position) || position < 1) return { error: 'Choose a recent track from /history.' };
  const original = historyTracks(player)[position - 1];
  if (!original?.info || (expectedIdentity && trackIdentity(original) !== expectedIdentity)) {
    return { error: 'History changed; choose a track again.' };
  }
  if ((player.queue.tracks?.length || 0) >= LIBRARY_LIMITS.queue) {
    return { error: `The queue holds at most ${LIBRARY_LIMITS.queue} upcoming tracks. Remove one before replaying a track.` };
  }
  const track = {
    ...original,
    info: { ...original.info, position: 0 },
    pluginInfo: { ...original.pluginInfo },
  };
  if (original.pluginInfo?.clientData) {
    track.pluginInfo.clientData = { ...original.pluginInfo.clientData };
    delete track.pluginInfo.clientData.previousTrack;
  }
  await player.queue.add(track, 0);
  if (!player.playing && !player.paused && !player.queue.current) await player.play({ position: 0 });
  return { track, started: player.queue.current === track };
}
