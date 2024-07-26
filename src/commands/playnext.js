import { SlashCommandBuilder } from '@discordjs/builders';
import { useQueue, useMainPlayer } from 'discord-player';

export const data = new SlashCommandBuilder()
  .setName('playnext')
  .setDescription('Play a song next')
  .addStringOption(option =>
    option.setName('query')
      .setDescription('The URL or name of the song')
      .setRequired(true));

export async function execute(interaction) {
  const channel = interaction.member.voice.channel;
  if (!channel) return interaction.reply('You need to join a voice channel first!');
  const query = interaction.options.getString('query');

  try {
    const player = useMainPlayer();
    const queue = useQueue(interaction.guild.id);

    const searchResult = await player.search(query, {
      requestedBy: interaction.user,
    });

    if (!searchResult || !searchResult.tracks.length) {
      return interaction.reply('No results found!');
    }

    const track = searchResult.tracks[0];

    if (queue) {
      queue.insertTrack(track, 0);
      interaction.reply(`**${track.title}** will play next!`);
    } else {
      await player.play(channel, track.url, {
        nodeOptions: {
          metadata: interaction,
        },
      });
    }
  } catch (e) {
    interaction.reply(`Something went wrong: ${e.message}`);
  }
}
