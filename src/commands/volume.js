import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { infoEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Set the volume level')
  .addIntegerOption(option =>
    option.setName('level')
      .setDescription('Volume level between 0 and 100')
      .setRequired(true));

export async function execute(interaction) {
  const volume = interaction.options.getInteger('level');
  if (isNaN(volume) || volume < 0 || volume > 100) {
    return interaction.reply({ embeds: [errorEmbed('Please provide a valid volume level between 0 and 100.')] });
  }
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There is no song playing!');
  queue.node.setVolume(volume);
  interaction.reply({ embeds: [infoEmbed('Volume', `Volume set to ${volume}%`)] });
}
