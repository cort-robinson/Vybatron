import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { successEmbed, errorEmbed } from '../utils/embeds.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current track');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const skipped = player.queue.current;
  if (!skipped) {
    return interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
  }

  if (player.queue.tracks.length > 0) {
    await player.skip();
  } else {
    await player.stopPlaying(true, false);
  }
  return interaction.reply({
    embeds: [successEmbed('Skipped', `**${skipped.info.title}**`)],
  });
}
