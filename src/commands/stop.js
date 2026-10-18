import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { plainText } from '../utils/presentation.js';
import { stopListeningSession } from '../utils/session-stop.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback, clear the queue, and disconnect');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const cleared = player.queue.tracks.length;
  const username = plainText(interaction.user?.globalName || interaction.user?.username, {
    fallback: 'a listener',
    maxLength: 80,
  });
  const confirmation = withControllerLink(
    `Stopped playback, cleared ${cleared} ${cleared === 1 ? 'track' : 'tracks'}, and disconnected.`, interaction, player
  );
  await stopListeningSession(interaction.client, player, `Stopped by ${username}.`);
  return interaction.reply(ephemeralText(confirmation));
}
