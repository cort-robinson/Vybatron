import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { applyAudioPreset, AUDIO_PRESETS, getAudioPreset } from '../utils/filters.js';
import { ephemeralText, textPayload } from '../utils/messages.js';
import { withControllerLink } from '../utils/player-controller.js';
import { directControlPresentation } from '../utils/presentation-updates.js';
import { commandTimingSpan } from '../portal/timing.js';

export const data = new SlashCommandBuilder()
  .setName('filter')
  .setDescription('Choose an audio preset, reset effects, or show the current preset')
  .addStringOption((option) => option
    .setName('preset')
    .setDescription('Replaces all effects; Original resets everything')
    .addChoices(...Object.entries(AUDIO_PRESETS).map(([value, preset]) => ({ name: preset.label, value }))));

export async function execute(interaction) {
  const key = interaction.options.getString('preset');
  if (!key) {
    const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
    if (!player) return interaction.reply(ephemeralText('Nothing is playing. Add something with /play.'));
    const preset = getAudioPreset(player);
    return interaction.reply(ephemeralText(`Current audio: ${preset.label}. ${preset.description} Use /filter preset:Original to reset every effect.`));
  }

  const player = await requireControl(interaction);
  if (!player) return null;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await commandTimingSpan('playback', () => applyAudioPreset(player, key));
  if (result.error) return interaction.editReply(textPayload(result.error));
  await directControlPresentation(interaction, player);
  const message = key === 'off'
    ? 'Restored the original sound and cleared every effect and EQ band.'
    : `${result.preset.label} on. ${result.preset.description} This affects everyone in the voice channel. Use /filter preset:Original to reset.`;
  return interaction.editReply(textPayload(withControllerLink(message, interaction, player)));
}
