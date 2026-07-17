import { MessageFlags } from 'discord.js';
import { requireControl } from './guards.js';
import {
  buildEmptyQueuePayload,
  buildQueuePayload,
  buildSeekModal,
  buildStopConfirmationPayload,
  ephemeralText,
  textPayload,
} from './messages.js';
import {
  end,
  getControllerRecord,
  getMessageLink,
  refresh,
} from './player-controller.js';
import {
  nextLoopMode,
  setLoopMode,
  seekToTimestamp,
  shuffleQueue,
  skipCurrent,
  togglePlayback,
} from './operations.js';
import { formatDuration, safeText, trackIdentity } from './presentation.js';
import { updateTrackPresence } from './presence.js';
import { clearVoiceStatus, updateVoiceStatus } from './voice-status.js';

async function disableStaleComponents(interaction) {
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
}

async function rejectEndedSession(interaction) {
  await disableStaleComponents(interaction);
  return interaction.reply(ephemeralText('This playback session has ended. Add something with /play.'));
}

function isEphemeralMessage(message) {
  if (typeof message?.flags?.has === 'function') {
    return message.flags.has(MessageFlags.Ephemeral);
  }
  const flags = Number(message?.flags?.bitfield ?? message?.flags ?? 0);
  return (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
}

async function rejectOrphanedController(interaction) {
  await disableStaleComponents(interaction);
  const link = getMessageLink(interaction.guildId);
  const guidance = link
    ? ` Open player: ${link}`
    : ' Start a new session with /play.';
  return interaction.reply(ephemeralText(
    `This controller is no longer active.${guidance}`
  ));
}

async function handlePlayerComponent(interaction, action) {
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

  if (action === 'queue') {
    return interaction.reply({
      ...buildQueuePayload(player, 0, interaction.user?.id),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === 'refresh') {
    await interaction.deferUpdate();
    await refresh(interaction.client, player);
    return null;
  }

  const controlledPlayer = await requireControl(interaction);
  if (!controlledPlayer) return null;

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
    await skipCurrent(controlledPlayer);
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
    const cleared = controlledPlayer.queue.tracks.length;
    const username = safeText(interaction.user?.globalName || interaction.user?.username, {
      fallback: 'a listener',
      maxLength: 80,
    });
    await interaction.update({ content: 'Stopping playback…', components: [] });
    try {
      await clearVoiceStatus(interaction.client, controlledPlayer);
      await end(interaction.client, controlledPlayer, `Stopped by ${username}.`);
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

export async function handleMessageComponent(interaction) {
  const customId = interaction.customId || '';
  const playerMatch = /^player:v1:(toggle|skip|shuffle|loop|seek|queue|refresh|stop|stop-confirm|stop-cancel)$/.exec(customId);
  if (playerMatch) return handlePlayerComponent(interaction, playerMatch[1]);

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
  const match = /^player:v1:seek-submit:([a-f0-9]{12})$/.exec(interaction.customId || '');
  if (!match) return null;

  const player = await requireControl(interaction);
  if (!player) return null;
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
