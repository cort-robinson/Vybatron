import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { addCurrentFavorite, collectionPayload, loadCollection } from '../utils/library-actions.js';
import { ephemeralText } from '../utils/messages.js';
import { commitImport, importLink, previewImport } from '../utils/playlist-import.js';

export const data = new SlashCommandBuilder().setName('favorite').setDescription('Your personal music shelf, saved across restarts')
  .addSubcommand(s => s.setName('add').setDescription('Save the current song or an upcoming queue entry')
    .addIntegerOption(o => o.setName('position').setDescription('Upcoming queue position; omit to save the current song').setMinValue(1).setMaxValue(500)))
  .addSubcommand(s => s.setName('list').setDescription('Browse your global private favorites').addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(100)))
  .addSubcommand(s => s.setName('play').setDescription('Queue a saved favorite').addIntegerOption(o => o.setName('index').setDescription('Number from /favorite list').setMinValue(1).setMaxValue(1000).setRequired(true)))
  .addSubcommand(s => s.setName('remove').setDescription('Remove a saved favorite').addIntegerOption(o => o.setName('index').setDescription('Number from /favorite list').setMinValue(1).setMaxValue(1000).setRequired(true)))
  .addSubcommand(s => s.setName('import').setDescription('Preview and save a public playlist to your favorites')
    .addStringOption(o => o.setName('link').setDescription('Public YouTube, YouTube Music, Spotify or SoundCloud playlist link').setMaxLength(200).setRequired(true)))
  .addSubcommand(s => s.setName('clear').setDescription('Clear your personal favorites').addBooleanOption(o => o.setName('confirm').setDescription('Confirm removal of all your saved favorites').setRequired(true)));

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === 'add') return addCurrentFavorite(interaction, null, interaction.options.getInteger('position'));
  if (action === 'import') {
    // The portal confirms a preview it showed; Discord confirms with a button.
    if (interaction.portalImportId) return commitImport(interaction, interaction.portalImportId, { kind: 'favorites', key: undefined, link: importLink(interaction.options.getString('link')) });
    return previewImport(interaction, { kind: 'favorites' });
  }
  const library = interaction.client.library;
  const tracks = library.favorites(interaction.user.id);
  const overflow = library.favoriteOverflowCount(interaction.user.id);
  if (action === 'list') return interaction.reply(collectionPayload('Your favorites', tracks, interaction.options.getInteger('page') || 1, `Only you can view this shelf${overflow ? ` · ${overflow} migrated tracks preserved and restored as space opens` : ''}`));
  if (action === 'clear') {
    if (!interaction.options.getBoolean('confirm')) return interaction.reply(ephemeralText('Your favorites are still saved. Set confirm to true to clear them.'));
    await library.updateFavorites(interaction.user.id, async list => { await interaction.portalRecheck?.(); list.length = 0; }, { clearOverflow: true });
    return interaction.reply(ephemeralText('Cleared your global favorites.'));
  }
  const index = interaction.options.getInteger('index');
  const track = tracks[index - 1];
  interaction.portalAssertFavorite?.(track);
  if (!track) return interaction.reply(ephemeralText('Choose a saved track number from /favorite list.'));
  if (action === 'remove') {
    await library.updateFavorites(interaction.user.id, async list => {
      await interaction.portalRecheck?.();
      interaction.portalAssertFavorite?.(list[index - 1]);
      if (list[index - 1]?.uri !== track.uri) throw new Error('Your favorites changed. Refresh before removing a track.');
      list.splice(index - 1, 1);
    });
    return interaction.reply(ephemeralText('Removed that track from your favorites.'));
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return loadCollection(interaction, channel, [track], 'your favorites');
}
