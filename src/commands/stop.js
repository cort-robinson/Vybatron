import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback, clear the queue, and disconnect');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  await interaction.reply({ embeds: [successEmbed('Stopped', 'Queue cleared. Goodbye!')] });
  await player.destroy();
}
