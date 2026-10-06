import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { moveQueuedTrack } from '../utils/operations.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { safeText } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('move')
  .setDescription('Move an upcoming track to another queue position')
  .addIntegerOption((option) => option
    .setName('from').setDescription('Current position').setMinValue(1).setRequired(true))
  .addIntegerOption((option) => option
    .setName('to').setDescription('Final position').setMinValue(1).setRequired(true));

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;
  const from = interaction.options.getInteger('from');
  const to = interaction.options.getInteger('to');
  const length = player.queue.tracks.length;
  if (from > length || to > length) {
    return interaction.reply(ephemeralText(`Choose positions between 1 and ${length}.`));
  }
  if (from === to) {
    return interaction.reply(ephemeralText('That track is already in that position.'));
  }
  const track = await moveQueuedTrack(player, from, to);
  await directControlPresentation(interaction, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Moved **${safeText(track.info?.title, { maxLength: 140 })}** from ${from} to ${to}.`,
    interaction,
    player
  )));
}
