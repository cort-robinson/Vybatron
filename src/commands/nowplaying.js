import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { infoEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show the currently playing track');

export async function execute(interaction) {
  const queue = player.nodes.get(interaction.guild.id);
  if (!queue || !queue.currentTrack) {
    return interaction.reply({ content: 'Nothing is playing right now.', ephemeral: true });
  }

  const track = queue.currentTrack;
  const progress = queue.node.createProgressBar?.({ timecodes: true }) || '';

  const embed = infoEmbed('Now Playing', `**${track.title}**\n${progress}`);
  if (track.url) embed.setURL(track.url);
  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return interaction.reply({
    embeds: [embed],
  });
}


