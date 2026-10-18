import { MessageFlags } from 'discord.js';
import { requireControl, requireSessionVisibility } from './guards.js';
import {
  buildEmptyQueuePayload,
  buildQueuePayload,
  buildSeekModal,
  buildSessionMixModal,
  buildStopConfirmationPayload,
  SESSION_MIX_MODAL_ID,
  ephemeralText,
  textPayload,
} from './messages.js';
import {
  requestControllerEnd,
  getControllerRecord,
  getMessageLink,
  refresh,
  requestControllerRefresh,
} from './player-controller.js';
import {
  goBack,
  nextLoopMode,
  setLoopMode,
  seekToTimestamp,
  shuffleQueue,
  skipCurrent,
  togglePlayback,
} from './operations.js';
import { formatDuration, safeText, trackIdentity } from './presentation.js';
import { updateTrackPresence } from './presence.js';
import { clearVoiceStatusBeforeLeaving, updateVoiceStatus } from './voice-status.js';
import { buildHelpPayload } from './help.js';
import { inviteUrlFor } from './invite.js';
import { buildHistoryPayload, historySessionKey, replayHistoryTrack } from './history.js';
import { buildLyricsPayload, findSessionTrack, trackLyrics } from './lyrics.js';
import { cancelGuildMutations } from './requests.js';
import { retirePresentationPlayer } from './presentation-updates.js';

async function disableStaleComponents(interaction) {
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
}

async function rejectEndedSession(interaction) {
  await interaction.reply(ephemeralText('This playback session has ended. Add something with /play.'));
  await disableStaleComponents(interaction);
  return null;
}

function isEphemeralMessage(message) {
  if (typeof message?.flags?.has === 'function') {
    return message.flags.has(MessageFlags.Ephemeral);
  }
  const flags = Number(message?.flags?.bitfield ?? message?.flags ?? 0);
  return (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
}

async function rejectOrphanedController(interaction) {
  const link = getMessageLink(interaction.guildId);
  const guidance = link
    ? ` Open player: ${link}`
    : ' Start a new session with /play.';
  await interaction.reply(ephemeralText(
    `This controller is no longer active.${guidance}`
  ));
  await disableStaleComponents(interaction);
  return null;
}

async function handlePlayerComponent(interaction, action, expectedIdentity = null) {
  const messageId = interaction.message?.id;
  if (messageId && !isEphemeralMessage(interaction.message)) {
    const record = getControllerRecord(interaction.guildId);
    if (record?.messageId !== messageId) {
      return rejectOrphanedController(interaction);
    }
  }

  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) return rejectEndedSession(interaction);

  if (action === 'stop-cancel') {
    return interaction.update({ content: 'Stop cancelled.', components: [] });
  }

  // Saving a mix needs library access to the session, not shared controls;
  // the modal submission checks it before writing.
  if (action === 'stop-save') return interaction.showModal(buildSessionMixModal());

  if (action === 'queue') {
    return interaction.reply({
      ...buildQueuePayload(player, 0, interaction.user?.id),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'refresh') {
    await interaction.deferUpdate();
    requestControllerRefresh(interaction.client, player);
    return null;
  }

  const controlledPlayer = await requireControl(interaction, { checkDJ: action !== 'favorite' });
  if (!controlledPlayer) return null;

  if (getControllerRecord(interaction.guildId)?.state === 'recovering'
    && !['skip', 'stop', 'stop-confirm'].includes(action)) {
    return interaction.reply(ephemeralText('Audio is reconnecting. You can skip this track or stop playback while it recovers.'));
  }

  if (action === 'favorite') {
    const track = controlledPlayer.queue.current;
    if (!track || trackIdentity(track) !== expectedIdentity) {
      return interaction.reply(ephemeralText('The track changed; refresh the player before saving a favorite.'));
    }
    const { addCurrentFavorite } = await import('./library-actions.js');
    return addCurrentFavorite(interaction, expectedIdentity);
  }

  if (action === 'seek') {
    const track = controlledPlayer.queue.current;
    if (!track || track.info?.isStream || track.info?.isSeekable === false
      || !Number.isFinite(track.info?.duration) || track.info.duration <= 0) {
      return interaction.reply(ephemeralText('This track does not support seeking.'));
    }
    return interaction.showModal(buildSeekModal(controlledPlayer));
  }

  if (action === 'toggle') {
    await interaction.deferUpdate();
    await togglePlayback(controlledPlayer);
    updateTrackPresence(interaction.client, controlledPlayer);
    await refresh(interaction.client, controlledPlayer);
    await updateVoiceStatus(interaction.client, controlledPlayer);
    return null;
  }

  if (action === 'skip') {
    const skipped = controlledPlayer.queue.current;
    if (!skipped) {
      await refresh(interaction.client, controlledPlayer);
      return interaction.reply(ephemeralText('Nothing is playing.'));
    }
    await interaction.deferUpdate();
    await skipCurrent(controlledPlayer, interaction.client);
    return null;
  }

  if (action === 'back') {
    await interaction.deferUpdate();
    const result = await goBack(controlledPlayer);
    if (result.error) return interaction.followUp(ephemeralText(result.error));
    if (result.restarted) {
      updateTrackPresence(interaction.client, controlledPlayer);
      await refresh(interaction.client, controlledPlayer);
    }
    return null;
  }

  if (action === 'shuffle') {
    if (controlledPlayer.queue.tracks.length < 2) {
      return interaction.reply(ephemeralText('Add at least two queued tracks before shuffling.'));
    }
    await interaction.deferUpdate();
    await shuffleQueue(controlledPlayer);
    await refresh(interaction.client, controlledPlayer);
    return null;
  }

  if (action === 'loop') {
    const mode = nextLoopMode(controlledPlayer.repeatMode);
    await interaction.deferUpdate();
    await setLoopMode(controlledPlayer, mode);
    await refresh(interaction.client, controlledPlayer);
    return null;
  }

  if (action === 'stop') {
    return interaction.reply(buildStopConfirmationPayload());
  }

  if (action === 'stop-confirm') {
    cancelGuildMutations(interaction.guildId);
    controlledPlayer.setData?.('vybertron.stopping', true);
    retirePresentationPlayer(controlledPlayer);
    const cleared = controlledPlayer.queue.tracks.length;
    const username = safeText(interaction.user?.globalName || interaction.user?.username, {
      fallback: 'a listener',
      maxLength: 80,
    });
    try {
      await controlledPlayer.stopPlaying?.(true, false);
      await interaction.update({ content: 'Stopping playback…', components: [] });
      requestControllerEnd(interaction.client, controlledPlayer, `Stopped by ${username}.`);
      await clearVoiceStatusBeforeLeaving(interaction.client, controlledPlayer);
    } finally {
      await controlledPlayer.destroy();
    }
    return interaction.followUp(ephemeralText(`Stopped playback, cleared ${cleared} ${cleared === 1 ? 'track' : 'tracks'}, and disconnected.`));
  }

  return null;
}

async function handleQueueNavigation(interaction, page, ownerId = 'any') {
  if (ownerId !== 'any' && interaction.user?.id !== ownerId) {
    return interaction.reply(ephemeralText('Only the person who opened this queue can change pages.'));
  }
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) {
    await interaction.update(buildEmptyQueuePayload());
    return interaction.followUp(ephemeralText('This playback session has ended. Add something with /play.'));
  }
  return interaction.update(buildQueuePayload(player, page, ownerId));
}

async function handleQueueJump(interaction, page, ownerId = 'any') {
  if (ownerId !== 'any' && interaction.user?.id !== ownerId) {
    return interaction.reply(ephemeralText('Only the person who opened this queue can use it.'));
  }
  const existingPlayer = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!existingPlayer) {
    await interaction.update(buildEmptyQueuePayload());
    return interaction.followUp(ephemeralText('This playback session has ended. Add something with /play.'));
  }
  const player = await requireControl(interaction);
  if (!player) return null;

  const [indexText, expectedIdentity] = String(interaction.values?.[0] || '').split(':');
  const index = Number.parseInt(indexText, 10);
  const target = player.queue.tracks[index - 1];
  if (!Number.isInteger(index) || index < 1 || !target || trackIdentity(target) !== expectedIdentity) {
    await interaction.update(buildQueuePayload(player, page, ownerId));
    return interaction.followUp(ephemeralText('The queue changed; choose a track again.'));
  }

  await interaction.deferUpdate();
  await player.skip(index);
  await interaction.editReply(buildQueuePayload(player, page, ownerId));
  return null;
}

async function handleHistoryComponent(interaction, action, ownerId, session, page) {
  if (ownerId !== 'any' && interaction.user?.id !== ownerId) {
    return interaction.reply(ephemeralText('Only the person who opened this history can use it.'));
  }
  const existingPlayer = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!existingPlayer || historySessionKey(existingPlayer) !== session) {
    await interaction.update({ ...buildHistoryPayload(null), components: [] });
    return interaction.followUp(ephemeralText('This playback session has ended. Open /history for the current session.'));
  }
  if (action !== 'replay') return interaction.update(buildHistoryPayload(existingPlayer, page, ownerId));

  const player = await requireControl(interaction);
  if (!player) return null;
  const [positionText, identity] = String(interaction.values?.[0] || '').split(':');
  if (!/^\d+$/.test(positionText) || !/^[a-f0-9]{12}$/.test(identity || '')) {
    return interaction.reply(ephemeralText('Choose a recent track from /history.'));
  }
  await interaction.deferUpdate();
  const result = await replayHistoryTrack(player, Number(positionText), identity);
  await interaction.editReply(buildHistoryPayload(player, page, ownerId));
  if (result.error) return interaction.followUp(ephemeralText(result.error));
  await refresh(interaction.client, player);
  return interaction.followUp(ephemeralText(
    `${result.started ? 'Replaying' : 'Queued'} ${safeText(result.track.info.title, { maxLength: 180 })}${result.started ? '.' : ' to replay next.'}`
  ));
}

async function handleLyricsPage(interaction, ownerId, identity, page) {
  if (ownerId !== 'any' && interaction.user?.id !== ownerId) {
    return interaction.reply(ephemeralText('Only the person who opened these lyrics can turn the page.'));
  }
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!await requireSessionVisibility(interaction, player)) return null;
  const track = findSessionTrack(player, identity);
  if (!track) {
    await interaction.update({ components: [] });
    return interaction.followUp(ephemeralText('That song has left the session. Use /lyrics for the current song.'));
  }
  await interaction.deferUpdate();
  const result = await trackLyrics(player.node, track);
  if (!await requireSessionVisibility(interaction, player)) return null;
  return interaction.editReply(buildLyricsPayload(track, result, page, ownerId));
}

export async function handleMessageComponent(interaction) {
  const customId = interaction.customId || '';
  const playerMatch = /^player:v1:(toggle|skip|back|shuffle|loop|seek|queue|refresh|stop|stop-confirm|stop-cancel|stop-save)$/.exec(customId);
  if (playerMatch) return handlePlayerComponent(interaction, playerMatch[1]);

  const favoriteMatch = /^player:v2:favorite:([a-f0-9]{12})$/.exec(customId);
  if (favoriteMatch && interaction.isButton()) return handlePlayerComponent(interaction, 'favorite', favoriteMatch[1]);

  const helpMatch = /^help:v2:topic:([^:]+)$/.exec(customId);
  if (helpMatch && interaction.isStringSelectMenu()) {
    if (helpMatch[1] !== 'any' && interaction.user?.id !== helpMatch[1]) {
      return interaction.reply(ephemeralText('Only the person who opened this help can change topics.'));
    }
    return interaction.update(buildHelpPayload(interaction.client, interaction.values?.[0], helpMatch[1], { inviteUrl: await inviteUrlFor(interaction.client, interaction.user?.id) }));
  }

  const historyMatch = /^history:v2:(page|refresh|replay):([^:]+):([a-f0-9]{12}):(\d+)(?::(?:previous|next))?$/.exec(customId);
  if (historyMatch && (historyMatch[1] === 'replay' ? interaction.isStringSelectMenu() : interaction.isButton())) {
    return handleHistoryComponent(interaction, historyMatch[1], historyMatch[2], historyMatch[3], Number(historyMatch[4]));
  }

  const lyricsMatch = /^lyrics:v1:page:([^:]+):([a-f0-9]{12}):(\d+):(?:previous|next)$/.exec(customId);
  if (lyricsMatch && interaction.isButton()) return handleLyricsPage(interaction, lyricsMatch[1], lyricsMatch[2], Number(lyricsMatch[3]));

  const pageMatch = /^queue:v1:(?:page|refresh):(\d+)(?::(?:previous|next))?$/.exec(customId);
  if (pageMatch && interaction.isButton()) {
    return handleQueueNavigation(interaction, Number.parseInt(pageMatch[1], 10));
  }

  const jumpMatch = /^queue:v1:jump:(\d+)$/.exec(customId);
  if (jumpMatch && interaction.isStringSelectMenu()) {
    return handleQueueJump(interaction, Number.parseInt(jumpMatch[1], 10));
  }

  const ownedPageMatch = /^queue:v2:(?:page|refresh):([^:]+):(\d+)(?::(?:previous|next))?$/.exec(customId);
  if (ownedPageMatch && interaction.isButton()) {
    return handleQueueNavigation(
      interaction,
      Number.parseInt(ownedPageMatch[2], 10),
      ownedPageMatch[1]
    );
  }

  const ownedJumpMatch = /^queue:v2:jump:([^:]+):(\d+)$/.exec(customId);
  if (ownedJumpMatch && interaction.isStringSelectMenu()) {
    return handleQueueJump(
      interaction,
      Number.parseInt(ownedJumpMatch[2], 10),
      ownedJumpMatch[1]
    );
  }

  return null;
}

export async function handleModalSubmit(interaction) {
  if (interaction.customId === SESSION_MIX_MODAL_ID) {
    const [{ saveMix }, { mixKey }] = await Promise.all([import('../commands/mix.js'), import('./library-actions.js')]);
    return saveMix(interaction, mixKey(interaction.fields.getTextInputValue('name')), { session: true });
  }
  const match = /^player:v1:seek-submit:([a-f0-9]{12})$/.exec(interaction.customId || '');
  if (!match) return null;

  const player = await requireControl(interaction);
  if (!player) return null;
  if (getControllerRecord(interaction.guildId)?.state === 'recovering') {
    return interaction.reply(ephemeralText('Audio is reconnecting. Open Seek again after playback resumes.'));
  }
  const track = player.queue.current;
  if (!track || trackIdentity(track) !== match[1]) {
    return interaction.reply(ephemeralText('The track changed; open Seek again.'));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!player.queue.current || trackIdentity(player.queue.current) !== match[1]) {
    return interaction.editReply(textPayload('The track changed; open Seek again.'));
  }
  const result = await seekToTimestamp(player, interaction.fields.getTextInputValue('timestamp'));
  if (result.error) return interaction.editReply(textPayload(result.error));

  updateTrackPresence(interaction.client, player);
  await refresh(interaction.client, player);
  const link = getMessageLink(interaction.guildId);
  const suffix = link ? ` Open player: ${link}` : '';
  return interaction.editReply(textPayload(`Jumped to ${formatDuration(result.position)}.${suffix}`));
}
