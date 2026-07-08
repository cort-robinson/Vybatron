import { SlashCommandBuilder } from '@discordjs/builders';
import { player } from '../index.js';
import { useLavalink } from '../lavalink.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';
import ytdl from 'ytdl-core';
import ytdlDiscord from 'ytdl-core-discord';

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
    const lavalink = useLavalink();
    const member = interaction.member;
    const guild = interaction.guild;
    const textChannelId = interaction.channel.id;
    const voiceChannelId = channel.id;

    let playerLL = lavalink.players.get(guild.id);
    if (!playerLL) {
      playerLL = lavalink.createPlayer({
        guildId: guild.id,
        voiceChannelId,
        textChannelId,
        selfDeaf: true,
      });
      await playerLL.connect();
    } else if (playerLL.voiceChannelId !== voiceChannelId) {
      playerLL.setVoiceChannel(voiceChannelId);
      await playerLL.connect();
    }

    const result = await lavalink.search(query, { requester: interaction.user });
    if (!result || !result.tracks?.length) {
      return interaction.reply({ embeds: [errorEmbed('No results found.')] });
    }
    const track = result.tracks[0];
    playerLL.queue.add(track);
    if (!playerLL.playing && !playerLL.paused) {
      await playerLL.play();
    }

    await interaction.reply({ embeds: [successEmbed('Enqueued', `**${track.title}**`)] });
  } catch (e) {
    await interaction.reply({ embeds: [errorEmbed(e.message || 'Something went wrong.')] });
  }
}
