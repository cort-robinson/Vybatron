import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause the current track');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue || !queue.node.isPlaying()) {
    return interaction.reply({ content: 'Nothing is playing.', ephemeral: true });
  }
  queue.node.setPaused(true);
  return interaction.reply('Paused playback.');
}


