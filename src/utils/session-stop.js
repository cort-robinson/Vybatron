import { requestControllerEnd } from './player-controller.js';
import { clearVoiceStatusBeforeLeaving } from './voice-status.js';
import { cancelGuildMutations } from './requests.js';
import { retirePresentationPlayer } from './presentation-updates.js';

// An intentional Stop: cancel waiting requests, clear the queue, end the
// controller, leave voice and discard the session checkpoint.
export async function stopListeningSession(client, player, endReason) {
  cancelGuildMutations(player.guildId);
  player.setData?.('vybertron.stopping', true);
  retirePresentationPlayer(player);
  try {
    await player.stopPlaying?.(true, false);
    // The controller writer settles independently of physical shutdown. The
    // voice status must clear first: Discord rejects it once the bot has left.
    requestControllerEnd(client, player, endReason);
    await clearVoiceStatusBeforeLeaving(client, player);
  } finally {
    await player.destroy();
  }
  await client.library?.updateGuild?.(player.guildId, guild => { guild.session = null; });
}
