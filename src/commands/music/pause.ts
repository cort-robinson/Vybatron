import { EmbedGenerator } from '../../utils/EmbedGenerator';
import type { CommandData, SlashCommandProps } from 'commandkit';
import { useQueue } from 'discord-player';

export const data: CommandData = {
  name: 'pause',
  description: 'Pause the currently playing song',
};

export async function run({ interaction }: SlashCommandProps) {
  if (!interaction.inCachedGuild()) return;
  const queue = useQueue(interaction.guildId);

  if (!queue || !queue.isPlaying()) {
    const embed = EmbedGenerator.Error({
      title: 'No track is playing',
      description: 'There is no track currently playing',
    }).withAuthor(interaction.user);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  queue.node.pause();

  const embed = EmbedGenerator.Info({
    title: 'Track paused',
    description: 'The track has been paused',
  }).withAuthor(interaction.user);

  return interaction.reply({ embeds: [embed] });
}
