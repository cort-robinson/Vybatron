import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { seekToTimestamp } from '../utils/operations.js';
import { formatDuration } from '../utils/presentation.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';
import { updateTrackPresence } from '../utils/presence.js';

export const data = new SlashCommandBuilder()
  .setName('seek')
  .setDescription('Jump to a timestamp in the current track')
  .addStringOption((option) => option
    .setName('timestamp')
    .setDescription('Position as mm:ss or hh:mm:ss')
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(12));

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const result = await seekToTimestamp(player, interaction.options.getString('timestamp'));
  if (result.error) return interaction.reply(ephemeralText(result.error));

  updateTrackPresence(interaction.client, player);
  await refresh(interaction.client, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Jumped to ${formatDuration(result.position)}.`, interaction, player
  )));
}
