import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { infoEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue || queue.tracks.size === 0) return interaction.reply({ content: 'There are no songs in the queue!', ephemeral: true });
  const tracks = queue.tracks.toArray().map((track, i) => `${i + 1}. ${track.title}`).join('\n');
  interaction.reply({ embeds: [infoEmbed('Current Queue', tracks).setThumbnail(queue.currentTrack?.thumbnail || null)] });
}
