import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('skipto')
  .setDescription('Skip to a specific track in the queue')
  .addIntegerOption((option) =>
    option
      .setName('index')
      .setDescription('Queue position to jump to (see /queue)')
      .setMinValue(1)
      .setRequired(true)
  );

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const index = interaction.options.getInteger('index');
  if (index < 1 || index > player.queue.tracks.length) {
    return interaction.reply({
      embeds: [errorEmbed(`Index must be between 1 and ${player.queue.tracks.length}.`)],
      ephemeral: true,
    });
  }

  const target = player.queue.tracks[index - 1];
  await player.skip(index);
  return interaction.reply({
    embeds: [successEmbed('Skipped To', `**${target.info.title}**`)],
  });
}
