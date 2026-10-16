import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { canInvite, clientInviteUrl } from '../utils/invite.js';
import { NO_MENTIONS } from '../utils/presentation.js';

export const data = new SlashCommandBuilder()
  .setName('invite')
  .setDescription('Add Vybatron to another server (bot owner only)');

export async function execute(interaction) {
  if (!(await canInvite(interaction.client, interaction.user?.id))) {
    return interaction.reply({ content: 'Vybatron is private, so only its owner can add it to new servers. Ask them if you’d like it somewhere else.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
  const url = clientInviteUrl(interaction.client);
  if (!url) {
    return interaction.reply({ content: 'The invite link isn’t available yet. Try again in a moment.', flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
  return interaction.reply({
    content: 'Pick any server where you have **Manage Server** permission. Discord shows the permissions Vybatron asks for before you confirm.',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Add Vybatron to a server').setURL(url))],
    flags: MessageFlags.Ephemeral,
    allowedMentions: NO_MENTIONS,
  });
}
