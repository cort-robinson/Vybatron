import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { seekToTimestamp } from '../utils/operations.js';
import { formatDuration } from '../utils/presentation.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { commandTimingSpan } from '../portal/timing.js';

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

  const result = await commandTimingSpan('playback', () => seekToTimestamp(player, interaction.options.getString('timestamp')));
  if (result.error) return interaction.reply(ephemeralText(result.error));

  await directControlPresentation(interaction, player, { presence: true });
  return interaction.reply(ephemeralText(withControllerLink(
    `Jumped to ${formatDuration(result.position)}.`, interaction, player
  )));
}
