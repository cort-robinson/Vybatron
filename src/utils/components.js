import { MessageFlags } from 'discord.js';
import { requireControl } from './guards.js';
import {
  buildEmptyQueuePayload,
  buildQueuePayload,
  ephemeralText,
} from './messages.js';
import {
  end,
  refresh,
} from './player-controller.js';
import { safeText, trackIdentity } from './presentation.js';

async function disableStaleComponents(interaction) {
  await interaction.message?.edit?.({ components: [] }).catch(() => {});
}

async function rejectEndedSession(interaction) {
  await disableStaleComponents(interaction);
  return interaction.reply(ephemeralText('This playback session has ended. Add something with /play.'));
}

async function handlePlayerComponent(interaction, action) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) return rejectEndedSession(interaction);

  if (action === 'queue') {
    return interaction.reply({
      ...buildQueuePayload(player, 0),
      flags: MessageFlags.Ephemeral,
    });
  }

  const controlledPlayer = await requireControl(interaction);
  if (!controlledPlayer) return null;

  if (action === 'toggle') {
    const wasPaused = controlledPlayer.paused;
    await interaction.deferUpdate();
    if (wasPaused) await controlledPlayer.resume();
    else await controlledPlayer.pause();
    await refresh(interaction.client, controlledPlayer);
    return interaction.followUp(ephemeralText(wasPaused ? 'Playback resumed.' : 'Playback paused.'));
  }

  if (action === 'skip') {
    const skipped = controlledPlayer.queue.current;
    if (!skipped || controlledPlayer.queue.tracks.length === 0) {
      await refresh(interaction.client, controlledPlayer);
      return interaction.reply(ephemeralText('No queued track is available to skip to.'));
    }
    await interaction.deferUpdate();
    await controlledPlayer.skip();
    return interaction.followUp(ephemeralText(
      `Skipped ${safeText(skipped.info?.title, { fallback: 'the current track', maxLength: 120 })}.`
    ));
  }

  if (action === 'stop') {
    const cleared = controlledPlayer.queue.tracks.length;
    const username = safeText(interaction.user?.globalName || interaction.user?.username, {
      fallback: 'a listener',
      maxLength: 80,
    });
    await interaction.deferUpdate();
    try {
      await end(interaction.client, controlledPlayer, `Stopped by ${username}.`);
    } finally {
      await controlledPlayer.destroy();
    }
    return interaction.followUp(ephemeralText(
      `Stopped playback, cleared ${cleared} ${cleared === 1 ? 'track' : 'tracks'}, and disconnected.`
    ));
  }

  return null;
}

async function handleQueueNavigation(interaction, page) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) {
    await interaction.update(buildEmptyQueuePayload());
    return interaction.followUp(ephemeralText('This playback session has ended. Add something with /play.'));
  }
  return interaction.update(buildQueuePayload(player, page));
}

async function handleQueueJump(interaction, page) {
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
    await interaction.update(buildQueuePayload(player, page));
    return interaction.followUp(ephemeralText('The queue changed; choose a track again.'));
  }

  await interaction.deferUpdate();
  await player.skip(index);
  await interaction.editReply(buildQueuePayload(player, page));
  return interaction.followUp(ephemeralText(
    `Jumped to ${safeText(target.info?.title, { fallback: 'the selected track', maxLength: 120 })}.`
  ));
}

export async function handleMessageComponent(interaction) {
  const customId = interaction.customId || '';
  const playerMatch = /^player:v1:(toggle|skip|queue|stop)$/.exec(customId);
  if (playerMatch) return handlePlayerComponent(interaction, playerMatch[1]);

  const pageMatch = /^queue:v1:(?:page|refresh):(\d+)(?::(?:previous|next))?$/.exec(customId);
  if (pageMatch && interaction.isButton()) {
    return handleQueueNavigation(interaction, Number.parseInt(pageMatch[1], 10));
  }

  const jumpMatch = /^queue:v1:jump:(\d+)$/.exec(customId);
  if (jumpMatch && interaction.isStringSelectMenu()) {
    return handleQueueJump(interaction, Number.parseInt(jumpMatch[1], 10));
  }

  return null;
}
