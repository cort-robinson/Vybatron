import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder()
  .setName('clear')
  .setDescription('Clear upcoming tracks while keeping the current song playing');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;
  const count = player.queue.tracks.length;
  if (!count) return interaction.reply(ephemeralText('There are no upcoming tracks to clear.'));
  await player.queue.splice(0, count);
  await refresh(interaction.client, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Cleared ${count} upcoming ${count === 1 ? 'track' : 'tracks'}.`, interaction, player
  )));
}
