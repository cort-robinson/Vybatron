import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Shuffle the queue');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  if (player.queue.tracks.length < 2) {
    return interaction.reply({
      embeds: [errorEmbed('Need at least 2 queued tracks to shuffle.')],
      ephemeral: true,
    });
  }
  await player.queue.shuffle();
  return interaction.reply({
    embeds: [successEmbed('Shuffled', `${player.queue.tracks.length} tracks randomized.`)],
  });
}
