import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause playback');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (player.paused) {
    return interaction.reply({ embeds: [errorEmbed('Already paused.')], ephemeral: true });
  }
  await player.pause();
  return interaction.reply({ embeds: [successEmbed('Paused', 'Use /resume to continue.')] });
}
