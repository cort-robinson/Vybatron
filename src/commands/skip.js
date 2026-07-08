import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { infoEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current song');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There is no song playing!');
  queue.node.skip();
  interaction.reply({ embeds: [infoEmbed('Skipped', 'Skipped the current song.')] });
}
