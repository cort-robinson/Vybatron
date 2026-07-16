import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { autocompleteTracks } from '../utils/autocomplete.js';
import { textPayload } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';
import { safeText } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song or playlist (YouTube, YouTube Music, Spotify, SoundCloud)')
  .addStringOption((option) =>
    option
      .setName('query')
      .setDescription('URL or search terms')
      .setMaxLength(200)
      .setAutocomplete(true)
      .setRequired(true)
  );

export const autocomplete = autocompleteTracks;

export async function execute(interaction) {
  const channel = await requireUserVoice(interaction);
  if (!channel) return;
  const query = interaction.options.getString('query');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    return interaction.editReply(textPayload(
      `No matches for “${safeText(query, { maxLength: 120 })}”. Try a title and artist, or paste a supported link.`
    ));
  }

  const starting = !player.playing && !player.paused && !player.queue.current;
  const firstPosition = player.queue.tracks.length + 1;
  let acknowledgement;

  if (result.loadType === 'playlist') {
    player.queue.add(result.tracks);
    const playlistName = safeText(result.playlist?.name || 'Playlist', { maxLength: 120 });
    acknowledgement = starting
      ? `Added ${result.tracks.length} tracks from **${playlistName}**. Starting playback.`
      : `Added ${result.tracks.length} tracks from **${playlistName}** at queue positions ${firstPosition}–${firstPosition + result.tracks.length - 1}.`;
  } else {
    const track = result.tracks[0];
    player.queue.add(track);
    const title = safeText(track.info.title, { maxLength: 140 });
    acknowledgement = starting
      ? `Starting **${title}**.`
      : `Added **${title}** at queue position ${firstPosition}.`;
  }

  if (!player.playing && !player.paused) await player.play();
  await refresh(interaction.client, player);
  return interaction.editReply(textPayload(
    withControllerLink(acknowledgement, interaction, player)
  ));
}
