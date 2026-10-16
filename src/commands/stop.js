import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { requestControllerEnd, withControllerLink } from '../utils/player-controller.js';
import { plainText } from '../utils/presentation.js';
import { clearVoiceStatusBeforeLeaving } from '../utils/voice-status.js';
import { cancelGuildMutations } from '../utils/requests.js';
import { retirePresentationPlayer } from '../utils/presentation-updates.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback, clear the queue, and disconnect');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;
  cancelGuildMutations(interaction.guildId);
  player.setData?.('vybertron.stopping', true);
  retirePresentationPlayer(player);

  const cleared = player.queue.tracks.length;
  const username = plainText(interaction.user?.globalName || interaction.user?.username, {
    fallback: 'a listener',
    maxLength: 80,
  });
  const confirmation = withControllerLink(
    `Stopped playback, cleared ${cleared} ${cleared === 1 ? 'track' : 'tracks'}, and disconnected.`, interaction, player
  );
  try {
    await player.stopPlaying?.(true, false);
    // The controller writer settles independently of physical shutdown. The
    // voice status must clear first: Discord rejects it once the bot has left.
    requestControllerEnd(interaction.client, player, `Stopped by ${username}.`);
    await clearVoiceStatusBeforeLeaving(interaction.client, player);
  } finally {
    await player.destroy();
  }
  await interaction.client.library?.updateGuild?.(interaction.guildId, guild => { guild.session = null; });
  return interaction.reply(ephemeralText(confirmation));
}
