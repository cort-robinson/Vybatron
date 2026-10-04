import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildHistoryPayload } from '../utils/history.js';

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription('Browse recent tracks and queue one to replay next');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  return interaction.reply({ ...buildHistoryPayload(player, 0, interaction.user.id), flags: MessageFlags.Ephemeral });
}
