import type { ValidationProps } from 'commandkit';
import { EmbedGenerator } from '../utils/EmbedGenerator';

export default async function ({ interaction, commandObj }: ValidationProps) {
  if (interaction.isAutocomplete()) return;
  if (commandObj.category !== 'music') return false;
  if (!interaction.inCachedGuild()) return true;

  const selfChannel = interaction.guild.members.me?.voice.channel;
  const memberChannel = interaction.member.voice.channel;

  if (!selfChannel && !memberChannel) {
    const embed = EmbedGenerator.Error({
      title: 'Error!',
      description: 'You must join a voice channel to use this command.',
    }).withAuthor(interaction.user);

    await interaction.reply({ embeds: [embed] });
    return true;
  }

  if (
    (selfChannel && !memberChannel) ||
    (selfChannel && memberChannel && selfChannel.id !== memberChannel.id)
  ) {
    const embed = EmbedGenerator.Error({
      title: 'Error!',
      description: `You must join ${selfChannel.toString()} to use this command.`,
    }).withAuthor(interaction.user);

    await interaction.reply({ embeds: [embed] });
    return true;
  }
}
