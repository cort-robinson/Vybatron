import { EmbedGenerator } from '../../utils/EmbedGenerator';
import type { CommandData, SlashCommandProps } from 'commandkit';
import { useQueue } from 'discord-player';

export const data: CommandData = {
  name: 'queue',
  description: 'Display the current song queue',
};

export async function run({ interaction }: SlashCommandProps) {
  if (!interaction.inCachedGuild()) return;
  const queue = useQueue(interaction.guildId);

  if (!queue || !queue.isPlaying()) {
    const embed = EmbedGenerator.Error({
      title: 'No track in queue',
      description: 'There are currently no tracks in the queue',
    }).withAuthor(interaction.user);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  console.log(queue.tracks);

  const tracks = queue.tracks.map((track, index) => ({
    name: `${index + 1}. ${track.title}`,
    value: `Requested by: ${track.requestedBy?.tag}`,
  }));

  const embed = EmbedGenerator.Info({
    title: 'Current Queue',
    description: `Current tracks in the queue:`,
    fields: tracks,
  }).withAuthor(interaction.user);

  return interaction.reply({ embeds: [embed] });
}
