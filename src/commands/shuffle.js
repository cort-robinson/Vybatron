import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Shuffle the queue');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (player.queue.tracks.length < 2) {
    return interaction.reply(ephemeralText('Add at least two queued tracks before shuffling.'));
  }
  await player.queue.shuffle();
  await refresh(interaction.client, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Shuffled ${player.queue.tracks.length} queued tracks.`,
    interaction,
    player
  )));
}
