import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { goBack } from '../utils/operations.js';
import { withControllerLink } from '../utils/player-controller.js';
import { safeText } from '../utils/presentation.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { commandTimingSpan } from '../portal/timing.js';

export const data = new SlashCommandBuilder()
  .setName('back')
  .setDescription('Go back to the previous track, or restart this one after its first few seconds');

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;

  const portal = typeof interaction.portalRecheck === 'function';
  const result = await commandTimingSpan('playback', () => goBack(player, portal ? { restartAfterMs: Infinity } : undefined));
  if (result.error) return interaction.reply(ephemeralText(result.error));
  // A new track refreshes the controller from its trackStart event.
  if (result.restarted) await directControlPresentation(interaction, player, { presence: true });
  const title = safeText(result.track.info?.title, { fallback: 'the track', maxLength: 140 });
  return interaction.reply(ephemeralText(withControllerLink(
    result.restarted ? `Restarted **${title}**.` : `Went back to **${title}**.`,
    interaction,
    player
  )));
}
