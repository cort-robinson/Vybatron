import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume the current track');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue || !queue.node.isPaused()) {
    return interaction.reply({ content: 'Playback is not paused.', ephemeral: true });
  }
  queue.node.setPaused(false);
  return interaction.reply('Resumed playback.');
}


