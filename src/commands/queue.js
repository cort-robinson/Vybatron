import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue) return interaction.reply('There are no songs in the queue!');
  const tracks = queue.tracks.map((track, i) => `${i + 1}. ${track.title}`).join('\n');
  interaction.reply(`**Current Queue:**\n${tracks}`);
}
