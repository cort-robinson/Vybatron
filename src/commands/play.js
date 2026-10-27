import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice, recheckEnqueueRequest } from '../utils/guards.js';
import { autocompleteTracks } from '../utils/autocomplete.js';
import { textPayload } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { safeText } from '../utils/presentation.js';
import { resolveTrackQuery, searchFailureMessage, validatePlaybackQuery } from '../utils/search.js';
import { enqueueTracks, getOrCreatePlayer } from '../utils/enqueue.js';

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
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  const query = interaction.options.getString('query');
  const invalid = validatePlaybackQuery(query);
  if (invalid) return interaction.reply({ ...textPayload(invalid), flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { player, created } = getOrCreatePlayer(interaction, channel);
  let added = false;
  try {
    const lookup = () => resolveTrackQuery(player, query, interaction.user);
    // For an existing session the slow lookup runs outside the playback lane,
    // so Pause, Skip or Volume don't wait on it. The rechecks and the queue
    // write below run back inside the lane. A new session keeps the lane: its
    // player exists only for this request until something is queued.
    const { result, expired } = await (!created && interaction.outsideMutationLane ? interaction.outsideMutationLane(lookup) : lookup());
    if (expired) {
      return interaction.editReply(textPayload(
        'That search suggestion expired. Type your search again and choose a fresh result.'
      ));
    }
    if (!result?.tracks?.length) {
      return interaction.editReply(textPayload(searchFailureMessage(result, query)));
    }

    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    const starting = !player.playing && !player.paused && !player.queue.current;
    const previousQueueSize = player.queue.tracks.length;
    const firstPosition = previousQueueSize + 1;
    const fairQueue = interaction.client.library?.settings(interaction.guildId).fairQueue;
    interaction.portalMutationStarted?.();
    let acknowledgement;

    if (result.loadType === 'playlist') {
      await enqueueTracks(interaction.client, player, result.tracks); added = true;
      const playlistName = safeText(result.playlist?.name || 'Playlist', { maxLength: 120 });
      acknowledgement = starting
        ? `Added ${result.tracks.length} tracks from **${playlistName}**. Starting playback.`
        : fairQueue ? `Added ${result.tracks.length} tracks from **${playlistName}**. Fair queue lets listeners take turns.`
        : `Added ${result.tracks.length} tracks from **${playlistName}** at queue positions ${firstPosition}–${firstPosition + result.tracks.length - 1}.`;
    } else {
      const track = result.tracks[0];
      await enqueueTracks(interaction.client, player, track); added = true;
      const title = safeText(track.info.title, { maxLength: 140 });
      const position = player.queue.tracks.indexOf(track) + 1;
      acknowledgement = starting && previousQueueSize === 0
        ? `Starting **${title}**.`
        : `Added **${title}** at queue position ${position}.${starting ? ' Starting your queue.' : ''}`;
    }

    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    if (!player.connected) await player.connect();
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    if (!player.playing && !player.paused) await player.play();
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    await directControlPresentation(interaction, player);
    if (result.spotifyImport?.notice) acknowledgement += `\n${result.spotifyImport.notice}`;
    return interaction.editReply(textPayload(
      withControllerLink(acknowledgement, interaction, player)
    ));
  } finally {
    if (created && !added && !player.queue.current && !player.queue.tracks.length) await player.destroy('unused-request-disconnect').catch(() => {});
  }
}
