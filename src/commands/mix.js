import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireLibrarySource, requireUserVoice } from '../utils/guards.js';
import { LIBRARY_LIMITS, trackReference } from '../utils/library.js';
import { loadCollection, mayEditMix, mixKey } from '../utils/library-actions.js';
import { COLORS, ephemeralText } from '../utils/messages.js';
import { NO_MENTIONS, safeText } from '../utils/presentation.js';

const nameOption = o => o.setName('name').setDescription('A memorable name, such as late night drive').setMaxLength(40).setRequired(true);
export const data = new SlashCommandBuilder().setName('mix').setDescription('Save and replay named mixes with your server')
  .addSubcommand(s => s.setName('save').setDescription('Save the current song and queue as a reusable mix').addStringOption(nameOption).addBooleanOption(o => o.setName('replace').setDescription('Replace a mix you previously saved')))
  .addSubcommand(s => s.setName('list').setDescription('Browse this server’s saved mixes'))
  .addSubcommand(s => s.setName('load').setDescription('Queue a saved mix, resolving fresh playable tracks').addStringOption(nameOption))
  .addSubcommand(s => s.setName('delete').setDescription('Delete a mix you own, or manage as a server admin').addStringOption(nameOption));

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  const library = interaction.client.library;
  const mixes = library.readGuild(interaction.guildId).mixes;
  if (action === 'list') {
    const lines = Object.entries(mixes).map(([name, mix]) => `**${safeText(name, { maxLength: 80 })}** · ${mix.tracks.length} tracks`);
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(COLORS.brand).setTitle('Server mixes').setDescription(lines.join('\n') || 'Save a listening session with /mix save, then bring it back whenever the mood fits.').setFooter({ text: 'Queue a mix with /mix load' })], flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS });
  }
  const key = mixKey(interaction.options.getString('name'));
  const existing = Object.hasOwn(mixes, key) ? mixes[key] : null;
  if (action === 'save') {
    const player = await requireLibrarySource(interaction); if (!player) return;
    if (!mayEditMix(interaction, existing)) return interaction.reply(ephemeralText('That mix belongs to another listener. Choose a new name.'));
    if (existing && !interaction.options.getBoolean('replace')) return interaction.reply(ephemeralText('That mix already exists. Set replace to true to update your saved mix.'));
    const raw = [player.queue.current, ...player.queue.tracks].filter(Boolean);
    if (raw.length > LIBRARY_LIMITS.mixTracks) return interaction.reply(ephemeralText(`A mix holds at most ${LIBRARY_LIMITS.mixTracks} tracks. Trim this queue first.`));
    const tracks = raw.map(trackReference).filter(Boolean);
    if (!tracks.length) return interaction.reply(ephemeralText('Add a playable song before saving a mix.'));
    const stored = await library.updateGuild(interaction.guildId, async guild => {
      const fresh = await requireLibrarySource(interaction);
      if (!fresh) return false;
      const live = [fresh.queue.current, ...fresh.queue.tracks].filter(Boolean);
      if (fresh !== player || live.length !== raw.length || live.some((track, index) => track !== raw[index])) throw new Error('Your mix changed. Refresh before saving it.');
      if (!existing && Object.keys(guild.mixes).length >= LIBRARY_LIMITS.mixes) throw new Error(`This server can save ${LIBRARY_LIMITS.mixes} mixes. Remove an unused mix first.`);
      guild.mixes[key] = { ownerId: existing?.ownerId || interaction.user.id, tracks, savedAt: Date.now() };
      return true;
    });
    if (!stored) return;
    return interaction.reply(ephemeralText(`Saved **${safeText(key)}** with ${tracks.length} tracks.${raw.length !== tracks.length ? ' Tracks without public catalog links were left out.' : ''}`));
  }
  if (!existing) return interaction.reply(ephemeralText('That mix does not exist. Browse saved names with /mix list.'));
  if (action === 'delete') {
    if (!mayEditMix(interaction, existing)) return interaction.reply(ephemeralText('Only the mix owner or a server manager can delete it.'));
    await library.updateGuild(interaction.guildId, async guild => {
      await interaction.portalRecheck?.();
      interaction.portalAssertMix?.(guild.mixes[key]);
      delete guild.mixes[key];
    });
    return interaction.reply(ephemeralText(`Deleted **${safeText(key)}**.`));
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: true }); if (!channel) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return loadCollection(interaction, channel, existing.tracks, key);
}
