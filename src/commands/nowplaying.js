import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { buildPlayerPayload, ephemeralText } from '../utils/messages.js';
import { controllerSessionStatus, getControllerRecord, getMessageLink } from '../utils/player-controller.js';
import { SESSION_STATUS } from '../utils/session-status.js';
import { requireSessionVisibility } from '../utils/guards.js';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show the current track');

export async function execute(interaction) {
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!await requireSessionVisibility(interaction, player)) return;
  const track = player?.queue?.current;
  if (!track) {
    return interaction.reply(ephemeralText('Nothing is playing. Add something with /play.'));
  }
  const record = getControllerRecord(interaction.guildId);
  const status = controllerSessionStatus(player);
  const payload = buildPlayerPayload(player, {
    // A track is current here, so a finished-queue label is already out of date.
    state: status === SESSION_STATUS.QUEUE_FINISHED ? player.paused ? 'paused' : 'playing' : status,
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
