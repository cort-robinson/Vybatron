import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('resume')
  .setDescription('Resume playback');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (!player.paused) {
    return interaction.reply({ embeds: [errorEmbed('Not paused.')], ephemeral: true });
  }
  await player.resume();
  return interaction.reply({ embeds: [successEmbed('Resumed', 'Back to the music!')] });
}
