import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

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
    return interaction.reply('Please provide a valid song number to skip to.');
  }

  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There is no song playing!');

  if (index > queue.tracks.length) {
    return interaction.reply('The specified song number is out of range.');
  }

  queue.node.skipTo(index - 1);
  interaction.reply(`Skipped to song number ${index}!`);
}
