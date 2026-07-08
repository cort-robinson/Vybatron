import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Shuffle the current queue');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue || queue.tracks.size === 0) {
    return interaction.reply({ content: 'No tracks to shuffle.', ephemeral: true });
  }
  queue.tracks.shuffle();
  return interaction.reply('Shuffled the queue.');
}


