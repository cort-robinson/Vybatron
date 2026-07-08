import { SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('playnext')
  .setDescription('Add a song to the front of the queue')
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

  const track = result.tracks[0];
  await player.queue.splice(0, 0, track);
  await interaction.editReply({
    embeds: [successEmbed('Playing Next', `**${track.info.title}**`)],
  });

  if (!player.playing && !player.paused) await player.play();
}
