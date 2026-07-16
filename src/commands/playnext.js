import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { autocompleteTracks } from '../utils/autocomplete.js';
import { textPayload } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';
import { safeText } from '../utils/presentation.js';

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

  const track = result.tracks[0];
  const starting = !player.playing && !player.paused && !player.queue.current;
  await player.queue.splice(0, 0, track);
  if (!player.playing && !player.paused) await player.play();
  await refresh(interaction.client, player);
  const title = safeText(track.info.title, { maxLength: 140 });
  const acknowledgement = starting
    ? `Starting **${title}**.`
    : `Added **${title}** at queue position 1.`;
  return interaction.editReply(textPayload(
    withControllerLink(acknowledgement, interaction, player)
  ));
}
