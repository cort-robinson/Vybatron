import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { safeText } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current track');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const skipped = player.queue.current;
  if (!skipped) {
    return interaction.reply(ephemeralText('Nothing is playing. Add something with /play.'));
  }

  if (player.queue.tracks.length > 0) {
    await player.skip();
  } else {
    await player.stopPlaying(true, false);
  }
  const suffix = player.queue.tracks.length === 0 ? ' The queue is now empty.' : '';
  return interaction.reply(ephemeralText(withControllerLink(
    `Skipped **${safeText(skipped.info.title, { maxLength: 140 })}**.${suffix}`,
    interaction,
    player
  )));
}
