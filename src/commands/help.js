import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildHelpPayload, HELP_TOPICS } from '../utils/help.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Explore Vybertron controls, your library, and supported sources')
  .addStringOption((option) => option
    .setName('topic')
    .setDescription('Choose what to explore')
    .addChoices(...HELP_TOPICS.map(({ label: name, value }) => ({ name, value }))));

export async function execute(interaction) {
  return interaction.reply({
    ...buildHelpPayload(interaction.client, interaction.options.getString('topic') || 'start', interaction.user.id),
    flags: MessageFlags.Ephemeral,
  });
}
