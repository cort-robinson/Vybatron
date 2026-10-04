import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { buildPlayerPayload, ephemeralText } from '../utils/messages.js';
import { getControllerRecord, getMessageLink } from '../utils/player-controller.js';

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
  const payload = buildPlayerPayload(player, {
    state: ['recovering', 'unavailable'].includes(record?.state) ? record.state : player.paused ? 'paused' : 'playing',
    track,
    startedAt: record?.startedAt || Date.now(),
    reason: record?.reason,
  });
  const link = getMessageLink(interaction.guildId);
  const components = link
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel('Open player').setStyle(ButtonStyle.Link).setURL(link)
    )]
    : [];
  return interaction.reply({
    ...payload,
    components,
    flags: MessageFlags.Ephemeral,
  });
}
