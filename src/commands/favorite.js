import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { addCurrentFavorite, collectionPayload, loadCollection } from '../utils/library-actions.js';
import { ephemeralText } from '../utils/messages.js';

export const data = new SlashCommandBuilder().setName('favorite').setDescription('Your personal music shelf, saved across restarts')
  .addSubcommand(s => s.setName('add').setDescription('Save the current song to your favorites'))
  .addSubcommand(s => s.setName('list').setDescription('Browse your favorites in this server').addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)))
  .addSubcommand(s => s.setName('play').setDescription('Queue a saved favorite').addIntegerOption(o => o.setName('index').setDescription('Number from /favorite list').setMinValue(1).setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a saved favorite').addIntegerOption(o => o.setName('index').setDescription('Number from /favorite list').setMinValue(1).setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear your personal favorites').addBooleanOption(o => o.setName('confirm').setDescription('Confirm removal of all your saved favorites').setRequired(true)));

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'add') return addCurrentFavorite(interaction);
  const library = interaction.client.library;
  const tracks = library.readGuild(interaction.guildId).favorites[interaction.user.id] || [];
  if (action === 'list') return interaction.reply(collectionPayload('Your favorites', tracks, interaction.options.getInteger('page') || 1, 'Only you can view this shelf'));
  if (action === 'clear') {
    if (!interaction.options.getBoolean('confirm')) return interaction.reply(ephemeralText('Your favorites are still saved. Set confirm to true to clear them.'));
    await library.updateGuild(interaction.guildId, guild => { delete guild.favorites[interaction.user.id]; });
    return interaction.reply(ephemeralText('Cleared your favorites in this server.'));
  }
  const index = interaction.options.getInteger('index');
  const track = tracks[index - 1];
  if (!track) return interaction.reply(ephemeralText('Choose a saved track number from /favorite list.'));
  if (action === 'remove') {
    await library.updateGuild(interaction.guildId, guild => { guild.favorites[interaction.user.id].splice(index - 1, 1); });
    return interaction.reply(ephemeralText('Removed that track from your favorites.'));
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return loadCollection(interaction, channel, [track], 'your favorites');
}
