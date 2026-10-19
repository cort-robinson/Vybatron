import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice, recheckEnqueueRequest } from '../utils/guards.js';
import { autocompleteTracks } from '../utils/autocomplete.js';
import { textPayload } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { safeText } from '../utils/presentation.js';
import { resolveTrackQuery, searchFailureMessage, validatePlaybackQuery } from '../utils/search.js';
import { enqueueTracks, getOrCreatePlayer } from '../utils/enqueue.js';
import { hasDJAccess } from '../utils/guards.js';

export const data = new SlashCommandBuilder()
  .setName('playnext')
  .setDescription('Add a song to the front of the queue')
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
  if (!hasDJAccess(interaction)) return interaction.reply({ ...textPayload('The server’s DJ role controls play-next priority. Use /play to add a song to the queue.'), flags: MessageFlags.Ephemeral });
  const query = interaction.options.getString('query');
  const invalid = validatePlaybackQuery(query);
  if (invalid) return interaction.reply({ ...textPayload(invalid), flags: MessageFlags.Ephemeral });

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { player, created } = getOrCreatePlayer(interaction, channel);
  let added = false;
  try {
    const { result, expired } = await resolveTrackQuery(player, query, interaction.user);
    if (expired) {
      return interaction.editReply(textPayload(
        'That search suggestion expired. Type your search again and choose a fresh result.'
      ));
    }
    if (!result?.tracks?.length) {
      return interaction.editReply(textPayload(searchFailureMessage(result, query)));
    }

    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    const track = result.tracks[0];
    const starting = !player.playing && !player.paused && !player.queue.current;
    interaction.portalMutationStarted?.();
    await enqueueTracks(interaction.client, player, track, { next: true }); added = true;
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    if (!player.connected) await player.connect();
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    if (!player.playing && !player.paused) await player.play();
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    await directControlPresentation(interaction, player);
    const title = safeText(track.info.title, { maxLength: 140 });
    let acknowledgement = starting
      ? `Starting **${title}**.`
      : `Added **${title}** at queue position 1.`;
    if (result.spotifyImport?.notice) acknowledgement += `\n${result.loadType === 'playlist' ? 'Play-next uses the first matched track from this collection. ' : ''}${result.spotifyImport.notice}`;
    return interaction.editReply(textPayload(
      withControllerLink(acknowledgement, interaction, player)
    ));
  } finally {
    if (created && !added && !player.queue.current && !player.queue.tracks.length) await player.destroy('unused-request-disconnect').catch(() => {});
  }
}
