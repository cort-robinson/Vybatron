import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  const current = player?.queue?.current;
  if (!player || (!current && player.queue.tracks.length === 0)) {
    return interaction.reply({ content: 'There are no songs in the queue!', ephemeral: true });
  }

  const lines = [];
  if (current) lines.push(`**Now:** ${current.info.title}`);
  player.queue.tracks.slice(0, 10).forEach((track, i) => {
    lines.push(`${i + 1}. ${track.info.title}`);
  });
  const remaining = player.queue.tracks.length - 10;
  if (remaining > 0) lines.push(`…and ${remaining} more`);

  const embed = infoEmbed('Current Queue', lines.join('\n'));
  if (current?.info?.artworkUrl) embed.setThumbnail(current.info.artworkUrl);
  return interaction.reply({ embeds: [embed] });
}
