import { SlashCommandBuilder } from '@discordjs/builders';
import { useQueue, useMainPlayer } from 'discord-player';
import { successEmbed, errorEmbed } from '../utils/embeds.js';
import ytdl from 'ytdl-core';
import ytdlDiscord from 'ytdl-core-discord';

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
      return interaction.reply({ embeds: [errorEmbed('No results found.')] });
    }

    const track = searchResult.tracks[0];

    if (queue) {
      queue.insertTrack(track, 0);
      interaction.reply({ embeds: [successEmbed('Play Next', `**${track.title}** will play next.`)] });
    } else {
      await player.play(channel, track.url, {
        nodeOptions: {
          metadata: interaction,
          onBeforeCreateStream: async (t) => {
            const url = t.url;
            const isYouTube = url && (/youtu\.be\//i.test(url) || /youtube\.com/i.test(url) || ytdl.validateURL(url));
            if (!isYouTube) return null;
            try {
              return await ytdlDiscord(url, { highWaterMark: 1 << 25, quality: 'highestaudio' });
            } catch {
              try {
                return ytdl(url, { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 });
              } catch {
                return null;
              }
            }
          },
        },
      });
    }
  } catch (e) {
    interaction.reply({ embeds: [errorEmbed(e.message || 'Something went wrong.')] });
  }
}
