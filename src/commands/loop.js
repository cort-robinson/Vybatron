import { SlashCommandBuilder } from 'discord.js';
import { requireControl } from '../utils/guards.js';
import { ephemeralText } from '../utils/messages.js';
import { setLoopMode } from '../utils/operations.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Set the loop mode')
  .addStringOption((option) => option
    .setName('mode')
    .setDescription('What to repeat')
    .setRequired(true)
    .addChoices(
      { name: 'Off', value: 'off' },
      { name: 'Current track', value: 'track' },
      { name: 'Entire queue', value: 'queue' }
    ));

export async function execute(interaction) {
  const player = await requireControl(interaction);
  if (!player) return;
  const mode = interaction.options.getString('mode');
  await setLoopMode(player, mode);
  await refresh(interaction.client, player);
  return interaction.reply(ephemeralText(withControllerLink(
    `Loop mode set to **${mode}**.`, interaction, player
  )));
}
