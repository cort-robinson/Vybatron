import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { removeQueuedTrack } from '../utils/operations.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { safeText } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Remove an upcoming track from the queue')
  .addIntegerOption((option) => option
    .setName('position')
    .setDescription('Queue position to remove')
    .setMinValue(1)
    .setRequired(true));

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;
  const position = interaction.options.getInteger('position');
  if (position > player.queue.tracks.length) {
    return interaction.reply(ephemeralText(
      `Choose a queue position between 1 and ${player.queue.tracks.length}.`
    ));
  }
  const track = await removeQueuedTrack(player, position);
  await directControlPresentation(interaction, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Removed **${safeText(track.info?.title, { maxLength: 140 })}** from position ${position}.`,
    interaction,
    player
  )));
}
