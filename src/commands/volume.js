import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { commandTimingSpan } from '../portal/timing.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Set playback volume')
  .addIntegerOption((option) =>
    option
      .setName('level')
      .setDescription('Volume 0-100')
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(true)
  );

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const level = interaction.options.getInteger('level');
  await commandTimingSpan('playback', () => player.setVolume(level));
  await directControlPresentation(interaction, player);
  return interaction.reply(ephemeralText(withControllerLink(
    level === 0 ? 'Muted.' : `Volume set to ${level}%.`,
    interaction,
    player
  )));
}
