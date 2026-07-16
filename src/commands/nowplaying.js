import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildPlayerPayload, ephemeralText } from '../utils/messages.js';
import { getControllerRecord } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show the current track');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  const track = player?.queue?.current;
  if (!track) {
    return interaction.reply(ephemeralText('Nothing is playing. Add something with /play.'));
  }
  const record = getControllerRecord(interaction.guildId);
  return interaction.reply({
    ...buildPlayerPayload(player, {
      state: player.paused ? 'paused' : 'playing',
      track,
      startedAt: record?.startedAt || Date.now(),
    }),
    flags: MessageFlags.Ephemeral,
  });
}
