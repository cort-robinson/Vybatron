import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildHelpPayload, HELP_TOPICS } from '../utils/help.js';
import { inviteUrlFor } from '../utils/invite.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Explore Vybatron controls, your library, and supported sources')
  .addStringOption((option) => option
    .setName('topic')
    .setDescription('Choose what to explore')
    .addChoices(...HELP_TOPICS.map(({ label: name, value }) => ({ name, value }))));

export async function execute(interaction) {
  return interaction.reply({
    ...buildHelpPayload(interaction.client, interaction.options.getString('topic') || 'start', interaction.user.id, { inviteUrl: await inviteUrlFor(interaction.client, interaction.user.id) }),
    flags: MessageFlags.Ephemeral,
  });
}
