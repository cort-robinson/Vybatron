import { SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song or playlist (YouTube, YouTube Music, Spotify, SoundCloud)')
  .addStringOption((option) =>
    option.setName('query').setDescription('URL or search terms').setRequired(true)
  );

export async function execute(interaction) {
  const channel = await requireUserVoice(interaction);
  if (!channel) return;
  const query = interaction.options.getString('query');

  await interaction.deferReply();

  const lavalink = interaction.client.lavalink;
  const player =
    lavalink.getPlayer(interaction.guildId) ??
    lavalink.createPlayer({
      guildId: interaction.guildId,
      voiceChannelId: channel.id,
      textChannelId: interaction.channelId,
      selfDeaf: true,
      volume: 100,
    });

  if (!player.connected) await player.connect();

  const result = await player.search({ query }, interaction.user);
  if (!result?.tracks?.length) {
    return interaction.editReply({ embeds: [errorEmbed('No results found.')] });
  }

  if (result.loadType === 'playlist') {
    player.queue.add(result.tracks);
    await interaction.editReply({
      embeds: [
        successEmbed(
          'Playlist Enqueued',
          `**${result.playlist?.name || 'Playlist'}** — ${result.tracks.length} tracks`
        ),
      ],
    });
  } else {
    const track = result.tracks[0];
    player.queue.add(track);
    await interaction.editReply({
      embeds: [successEmbed('Enqueued', `**${track.info.title}**`)],
    });
  }

  if (!player.playing && !player.paused) await player.play();
}
