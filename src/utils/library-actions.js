import { EmbedBuilder, MessageFlags } from 'discord.js';
import { requireLibrarySource, recheckEnqueueRequest, canManageMusic } from './guards.js';
import { LIBRARY_LIMITS, trackReference } from './library.js';
import { COLORS, ephemeralText, textPayload } from './messages.js';
import { safeText, trackIdentity, NO_MENTIONS } from './presentation.js';
import { enqueueTracks, getOrCreatePlayer, resolveReferences } from './enqueue.js';
import { refresh, withControllerLink } from './player-controller.js';
import { historyTracks } from './history.js';

export function collectionPayload(title, tracks, page = 1, footer = '') {
  const totalPages = Math.max(1, Math.ceil(tracks.length / 10));
  const selected = Math.max(1, Math.min(totalPages, page));
  const start = (selected - 1) * 10;
  const lines = tracks.slice(start, start + 10).map((track, i) => `**${start + i + 1}.** ${safeText(track.title, { maxLength: 130 })} — ${safeText(track.author, { maxLength: 70 })}`);
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle(title).setDescription(lines.join('\n') || 'Nothing saved yet. Favorite a playing track to start your collection.').setFooter({ text: `Page ${selected}/${totalPages} · ${tracks.length} tracks${footer ? ` · ${footer}` : ''}` })],
    allowedMentions: NO_MENTIONS, flags: MessageFlags.Ephemeral,
  };
}

export async function addCurrentFavorite(interaction, expectedIdentity = null, position = null) {
  const player = await requireLibrarySource(interaction, { queued: position !== null });
  if (!player) return null;
  const current = position === null ? player.queue.current : player.queue.tracks[position - 1];
  if (position !== null && (!Number.isSafeInteger(position) || position < 1 || position > player.queue.tracks.length)) {
    return interaction.reply(ephemeralText('Choose an existing upcoming queue position.'));
  }
  if (!current || (expectedIdentity && trackIdentity(current) !== expectedIdentity)) {
    return interaction.reply(ephemeralText('The track changed. Favorite the song on the current player.'));
  }
  const reference = trackReference(current);
  if (!reference) return interaction.reply(ephemeralText('This source does not provide a public track link that can be saved.'));
  const result = await interaction.client.library.updateFavorites(interaction.user.id, async list => {
    // Global saves can wait behind another guild. Track-end and Stop do not
    // wait for this guild's ordinary request lane.
    const fresh = await requireLibrarySource(interaction, { queued: position !== null });
    if (!fresh) return null;
    if (fresh !== player || (position === null ? fresh.queue.current : fresh.queue.tracks[position - 1]) !== current) {
      throw new Error('Your favorites changed. Refresh before saving a track.');
    }
    if (list.some(t => t.uri === reference.uri)) return false;
    if (list.length >= LIBRARY_LIMITS.favorites || interaction.client.library.favoriteOverflowCount?.(interaction.user.id)) throw new Error(`Your favorites hold at most ${LIBRARY_LIMITS.favorites} tracks. Remove one first.`);
    list.push(reference); return true;
  });
  if (result === null) return null;
  return interaction.reply(ephemeralText(result ? `Saved **${safeText(reference.title, { maxLength: 140 })}** to your favorites. Find it with /favorite list.` : 'This song is already in your favorites.'));
}

export function mixKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(key)) throw new Error('Name your mix with 1–40 letters, numbers, spaces, hyphens or underscores.');
  return key;
}

/**
 * What a saved mix captures: the current song and queue, and with `session` the
 * songs already played this session first (oldest first, each song once). When
 * the 100-track limit is tight, the oldest played songs are left out.
 * @returns {{ tracks: object[], played: number, sources: object[] }} sources are the live player tracks it was built from
 */
export function sessionMixTracks(player, { session = false } = {}) {
  const live = [player.queue.current, ...player.queue.tracks].filter(Boolean);
  const upcoming = live.map(trackReference).filter(Boolean);
  if (!session) return { tracks: upcoming, played: 0, sources: live };
  const history = historyTracks(player);
  const taken = new Set(upcoming.map(reference => reference.uri));
  const earlier = [];
  // History is most recent first, so the oldest songs are the ones left out.
  for (const track of history) {
    if (earlier.length >= LIBRARY_LIMITS.mixTracks - upcoming.length) break;
    const reference = trackReference(track);
    if (!reference || taken.has(reference.uri)) continue;
    taken.add(reference.uri); earlier.unshift(reference);
  }
  return { tracks: [...earlier, ...upcoming], played: earlier.length, sources: [...history, ...live] };
}

export function mayEditMix(interaction, mix) { return !mix || mix.ownerId === interaction.user.id || canManageMusic(interaction); }

export async function loadCollection(interaction, channel, references, label) {
  const { player, created } = getOrCreatePlayer(interaction, channel);
  let added = false;
  try {
    const { tracks, missing } = await resolveReferences(player, references, interaction.user);
    if (!tracks.length) return interaction.editReply(textPayload('These saved tracks are currently unavailable. Try /play with a fresh result.'));
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    interaction.portalMutationStarted?.();
    await enqueueTracks(interaction.client, player, tracks); added = true;
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    if (!player.connected) await player.connect();
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    if (!player.playing && !player.paused) await player.play();
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    await refresh(interaction.client, player);
    return interaction.editReply(textPayload(withControllerLink(`Added ${tracks.length} ${tracks.length === 1 ? 'track' : 'tracks'} from **${safeText(label, { maxLength: 100 })}**.${missing.length ? ` ${missing.length} unavailable tracks were left out.` : ''}`, interaction, player)));
  } finally {
    if (created && !added && !player.queue.current && !player.queue.tracks.length) await player.destroy('unused-request-disconnect').catch(() => {});
  }
}
