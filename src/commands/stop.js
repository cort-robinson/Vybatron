import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playing and clear the queue');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There is no song playing!');
  queue.delete();
  interaction.reply('Stopped the music and cleared the queue!');
}
