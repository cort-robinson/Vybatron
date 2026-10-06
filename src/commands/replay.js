import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireControl, recheckEnqueueRequest } from '../utils/guards.js';
import { enqueueTracks, resolveReferences } from '../utils/enqueue.js';
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
  if (interaction.portalHistory) {
    const item = interaction.portalHistory[position - 1];
    interaction.portalAssertHistory?.(item);
    if (!item) return interaction.reply(ephemeralText('No visible track at that history position. Refresh history first.'));
    const channel = interaction.member.voice.channel;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { tracks } = await resolveReferences(player, [item.track], interaction.user);
    if (!tracks.length) return interaction.editReply(textPayload('That historical recording is currently unavailable.'));
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    // A visibility change can shift the actor's filtered history without a
    // guild queue revision change. Keep the original reference bound to the
    // freshly authorized position before committing the resolved recording.
    const freshItem = interaction.portalHistory[position - 1];
    interaction.portalAssertHistory?.(freshItem);
    if (freshItem?.id !== item.id) return interaction.portalReject('Your visible history changed while loading. Refresh before replaying.');
    interaction.portalMutationStarted?.();
    await enqueueTracks(interaction.client, player, tracks, { next: true, fair: false });
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    if (!player.playing && !player.paused && !player.queue.current) await player.play();
    await refresh(interaction.client, player);
    return interaction.editReply(textPayload('Queued the historical recording to replay next.'));
  }
  const original = historyTracks(player)[position - 1];
  if (!original) return interaction.reply(ephemeralText('No track at that history position. Open /history to choose a recent track.'));
  const identity = trackIdentity(original);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  interaction.portalMutationStarted?.();
  const result = await replayHistoryTrack(player, position, identity);
  if (result.error) return interaction.editReply(textPayload(result.error));
  await refresh(interaction.client, player);
  return interaction.editReply(textPayload(withControllerLink(
    `${result.started ? 'Replaying' : 'Queued'} ${safeText(result.track.info.title, { maxLength: 180 })}${result.started ? '.' : ' to replay next.'}`, interaction, player
  )));
}
