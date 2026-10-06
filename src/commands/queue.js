import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildQueuePayload, ephemeralText } from '../utils/messages.js';
import { requireSessionVisibility } from '../utils/guards.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!await requireSessionVisibility(interaction, player)) return;
  const current = player?.queue?.current;
  if (!player || (!current && player.queue.tracks.length === 0)) {
    return interaction.reply(ephemeralText('Queue is empty. Add something with /play.'));
  }
  return interaction.reply({ ...buildQueuePayload(player, 0, interaction.user.id), flags: MessageFlags.Ephemeral });
}
