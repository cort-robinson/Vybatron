import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { ephemeralText } from '../utils/messages.js';
import { requireSessionVisibility } from '../utils/guards.js';
import { LIBRARY_LIMITS } from '../utils/library.js';
import { buildLyricsPayload, sessionTrack, trackLyrics } from '../utils/lyrics.js';

export const data = new SlashCommandBuilder()
  .setName('lyrics')
  .setDescription('Show lyrics for the current song, privately')
  .addIntegerOption((option) => option
    .setName('position')
    .setDescription('An upcoming queue position instead of the current song')
    .setMinValue(1)
    .setMaxValue(LIBRARY_LIMITS.queue));

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!await requireSessionVisibility(interaction, player)) return;
  const position = interaction.options.getInteger('position');
  const track = sessionTrack(player, position);
  if (!track) {
    return interaction.reply(ephemeralText(position
      ? `There is no song at position ${position} in the queue. Check /queue.`
      : 'Nothing is playing. Add something with /play.'));
  }
  if (!track.encoded) {
    return interaction.reply(ephemeralText('That song hasn’t loaded yet. Try /lyrics again when it plays.'));
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await trackLyrics(player.node, track);
  // Access may change during a slow lookup. Recheck before disclosure.
  if (!await requireSessionVisibility(interaction, player)) return;
  return interaction.editReply(buildLyricsPayload(track, result, 0, interaction.user.id));
}
