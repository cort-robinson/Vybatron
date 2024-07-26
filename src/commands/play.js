import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song')
  .addStringOption(option =>
    option.setName('query')
      .setDescription('The URL or name of the song')
      .setRequired(true));

export async function execute(interaction) {
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply('You need to join a voice channel first!');
  const query = interaction.options.getString('query');

  try {
    const { track } = await player.play(channel, query, {
      nodeOptions: {
        metadata: interaction,
      },
    });

    await interaction.reply(`**${track.title}** enqueued!`);
  } catch (e) {
    await interaction.reply(`Something went wrong: ${e.message}`);
  }
}
