import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { commandTimingSpan } from '../portal/timing.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume playback');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (!player.paused) {
    return interaction.reply(ephemeralText(
      withControllerLink('Playback is already running.', interaction, player)
    ));
  }
  await commandTimingSpan('playback', () => player.resume());
  await directControlPresentation(interaction, player, { presence: true, voice: true });
  return interaction.reply(ephemeralText(
    withControllerLink('Playback resumed.', interaction, player)
  ));
}
