import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { canManageMusic, hasDJAccess } from '../utils/guards.js';
import { DEFAULT_SETTINGS } from '../utils/library.js';
import { fairOrder, withTimeout } from '../utils/enqueue.js';
import { ephemeralText } from '../utils/messages.js';
import { trackedChannelRead } from '../utils/channel-reads.js';
import { refreshSuggestions, resetAutoplay } from '../utils/radio.js';

export const AUTOPLAY_LABELS = Object.freeze({
  off: 'off — the session ends when the queue does',
  on: 'on — related songs keep playing after the queue ends',
  listening: 'on while someone is listening — stops adding songs when everyone is deafened',
});

export const data = new SlashCommandBuilder().setName('settings').setDescription('Set your server’s listening defaults').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('show').setDescription('Show volume, fair queue, autoplay and DJ settings'))
  .addSubcommand(s => s.setName('volume').setDescription('Default volume for new sessions').addIntegerOption(o => o.setName('value').setDescription('Default volume percent').setMinValue(0).setMaxValue(100).setRequired(true)))
  .addSubcommand(s => s.setName('fairqueue').setDescription('Take turns between listeners while keeping each person’s song order').addBooleanOption(o => o.setName('enabled').setDescription('Enable fair queue ordering').setRequired(true)))
  .addSubcommand(s => s.setName('autoplay').setDescription('Keep the music going with related songs after the queue ends').addStringOption(o => o.setName('mode').setDescription('When autoplay adds related songs').setRequired(true)
    .addChoices({ name: 'Off', value: 'off' }, { name: 'On', value: 'on' }, { name: 'Only while someone is listening', value: 'listening' })))
  .addSubcommand(s => s.setName('djrole').setDescription('Restrict playback controls to a DJ role; omit the role to clear it').addRoleOption(o => o.setName('role').setDescription('DJ role for playback controls')))
  .addSubcommand(s => s.setName('musicchannel').setDescription('Choose the controller text channel for web-started sessions').addChannelOption(o => o.setName('channel').setDescription('Bot-readable and writable music text channel; omit to clear').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('reset').setDescription('Restore open controls, volume 100, normal queue order and autoplay off'));

export async function execute(interaction) {
  if (!canManageMusic(interaction)) return interaction.reply(ephemeralText('Manage Server permission is required to change listening defaults.'));
  const action = interaction.options.getSubcommand();
  const library = interaction.client.library;
  let channel = interaction.options.getChannel?.('channel');
  if (action === 'musicchannel' && channel) {
    const target = channel.id;
    const read = () => interaction.guild.channels.fetch(target, { force: true });
    // A native read writes the cache portal Gateway authority trusts, so it is
    // tracked (ADR-0011). The portal's request-local view is already a tracked
    // policy read; wrapping it again could clear a mark too early.
    channel = await withTimeout(interaction.portalRecheck ? read() : trackedChannelRead(interaction.client, interaction.guildId, [target], read), 5000);
    // cache:false leaves the Gateway-maintained bot member untouched (ADR-0011).
    const me = await withTimeout(interaction.guild.members.fetchMe({ force: true, cache: false }), 5000);
    const permissions = channel?.permissionsFor?.(me);
    if (channel?.guildId !== interaction.guildId || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
      || !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return interaction.reply(ephemeralText('Choose a text channel in this server where Vybatron can view, send messages and embed links.'));
    }
    await interaction.portalRecheck?.();
  }
  if (action !== 'show') await library.updateGuild(interaction.guildId, async guild => {
    await interaction.portalRecheck?.();
    if (action === 'volume') guild.settings.volume = interaction.options.getInteger('value');
    if (action === 'fairqueue') guild.settings.fairQueue = interaction.options.getBoolean('enabled');
    if (action === 'autoplay') guild.settings.autoplay = interaction.options.getString('mode');
    if (action === 'djrole') guild.settings.djRoleId = interaction.options.getRole('role')?.id || null;
    if (action === 'musicchannel') guild.settings.musicTextChannelId = channel?.id || null;
    if (action === 'reset') guild.settings = { ...DEFAULT_SETTINGS };
  });
  const settings = library.settings(interaction.guildId);
  const player = interaction.client.lavalink.getPlayer(interaction.guildId);
  if (player && ['autoplay', 'reset'].includes(action)) {
    // A new mode re-arms a paused session and drops picks made under the old one.
    resetAutoplay(player);
    void refreshSuggestions(player, interaction.client).catch(() => {});
  }
  if (action === 'fairqueue' && settings.fairQueue && player && interaction.member?.voice?.channel?.id === player.voiceChannelId && hasDJAccess(interaction)) {
    player.queue.tracks.splice(0, player.queue.tracks.length, ...fairOrder(player.queue.tracks, player.queue.current?.requester?.id));
    await player.queue.utils?.save?.();
  }
  const note = action === 'volume' ? 'The volume default applies to new sessions. Use /volume for the current session.'
    : action === 'autoplay' ? 'Songs people queue always play first. /radio on or off overrides this for the current session.'
      : 'Listeners can always add music, save favorites and use /voteskip.';
  return interaction.reply(ephemeralText(`Default volume: ${settings.volume}%\nFair queue: ${settings.fairQueue ? 'on — listeners take turns' : 'off — songs keep arrival order'}\nAutoplay: ${AUTOPLAY_LABELS[settings.autoplay] || AUTOPLAY_LABELS.off}\nControls: ${settings.djRoleId ? `DJ role (ID ${settings.djRoleId}) and server managers` : 'everyone in the voice channel'}\nMusic text channel: ${settings.musicTextChannelId || 'not configured'}\n${note}`));
}
