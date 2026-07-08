import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { infoEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('skipto')
  .setDescription('Skip to a specific song in the queue')
  .addIntegerOption(option =>
    option.setName('index')
      .setDescription('The song number to skip to')
      .setRequired(true));

export async function execute(interaction) {
  const index = interaction.options.getInteger('index');
  if (isNaN(index) || index < 1) {
    return interaction.reply({ embeds: [errorEmbed('Please provide a valid song number to skip to.')] });
  }

  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There is no song playing!');

  if (index > queue.tracks.size) {
    return interaction.reply({ embeds: [errorEmbed('The specified song number is out of range.')] });
  }

  queue.node.skipTo(index - 1);
  interaction.reply({ embeds: [infoEmbed('Skipped', `Skipped to song number ${index}.`)] });
}
