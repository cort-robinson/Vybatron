import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause playback');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (player.paused) {
    return interaction.reply(ephemeralText(
      withControllerLink('Playback is already paused.', interaction, player)
    ));
  }
  await player.pause();
  await refresh(interaction.client, player);
  return interaction.reply(ephemeralText(
    withControllerLink('Playback paused.', interaction, player)
  ));
}
