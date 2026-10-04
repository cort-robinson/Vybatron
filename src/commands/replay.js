import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { historyTracks, replayHistoryTrack } from '../utils/history.js';
import { ephemeralText, textPayload } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';
import { safeText, trackIdentity } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('replay')
  .setDescription('Queue a recent track next; keeps the current track playing')
  .addIntegerOption((option) => option
    .setName('position')
    .setDescription('History position, newest first (default: 1)')
    .setMinValue(1)
    .setMaxValue(100));

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return null;
  const position = interaction.options.getInteger('position') || 1;
  const original = historyTracks(player)[position - 1];
  if (!original) return interaction.reply(ephemeralText('No track at that history position. Open /history to choose a recent track.'));
  const identity = trackIdentity(original);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await replayHistoryTrack(player, position, identity);
  if (result.error) return interaction.editReply(textPayload(result.error));
  await refresh(interaction.client, player);
  return interaction.editReply(textPayload(withControllerLink(
    `${result.started ? 'Replaying' : 'Queued'} ${safeText(result.track.info.title, { maxLength: 180 })}${result.started ? '.' : ' to replay next.'}`, interaction, player
  )));
}
