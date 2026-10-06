import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { setRadio, radioArtist } from '../utils/radio.js';
import { ephemeralText } from '../utils/messages.js';
import { safeText } from '../utils/presentation.js';
import { refresh, requestControllerRefresh } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder().setName('radio').setDescription('Keep the vibe going with opt-in artist radio')
  .addSubcommand(s => s.setName('on').setDescription('Pick fresh songs based on the current artist when your queue ends'))
  .addSubcommand(s => s.setName('off').setDescription('Stop automatic discovery; keep all queued songs'));

export async function execute(interaction) {
  const player = await requireControl(interaction); if (!player) return;
  const enabled = interaction.options.getSubcommand() === 'on';
  const seed = player.queue.current || player.queue.previous?.[0];
  if (enabled && (!seed || !radioArtist(seed))) return interaction.reply(ephemeralText('Play a song first so artist radio has a starting point.'));
  setRadio(player, enabled, seed);
  // Urgent cancellation bypasses the ordinary lane. It must not retain a
  // per-command waiter behind a stalled cosmetic writer.
  if (enabled) await refresh(interaction.client, player);
  else requestControllerRefresh(interaction.client, player);
  return interaction.reply(ephemeralText(enabled ? `Artist radio is on, starting from **${safeText(radioArtist(seed))}**. It adds one fresh pick when the queue ends. Your requests play first; use /radio off to end discovery.` : 'Artist radio is off. Songs already queued will keep playing.'));
}
