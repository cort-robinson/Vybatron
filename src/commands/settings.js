import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { canManageMusic } from '../utils/guards.js';
import { DEFAULT_SETTINGS } from '../utils/library.js';
import { fairOrder } from '../utils/enqueue.js';
import { ephemeralText } from '../utils/messages.js';

export const data = new SlashCommandBuilder().setName('settings').setDescription('Set your server’s listening defaults').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('show').setDescription('Show volume, fair queue and DJ settings'))
  .addSubcommand(s => s.setName('volume').setDescription('Default volume for new sessions').addIntegerOption(o => o.setName('value').setDescription('Default volume percent').setMinValue(0).setMaxValue(100).setRequired(true)))
  .addSubcommand(s => s.setName('fairqueue').setDescription('Take turns between listeners while keeping each person’s song order').addBooleanOption(o => o.setName('enabled').setDescription('Enable fair queue ordering').setRequired(true)))
  .addSubcommand(s => s.setName('djrole').setDescription('Restrict playback controls to a DJ role; omit the role to clear it').addRoleOption(o => o.setName('role').setDescription('DJ role for playback controls')))
  .addSubcommand(s => s.setName('reset').setDescription('Restore open controls, volume 100 and normal queue order'));

export async function execute(interaction) {
  if (!canManageMusic(interaction)) return interaction.reply(ephemeralText('Manage Server permission is required to change listening defaults.'));
  const action = interaction.options.getSubcommand();
  const library = interaction.client.library;
  if (action !== 'show') await library.updateGuild(interaction.guildId, guild => {
    if (action === 'volume') guild.settings.volume = interaction.options.getInteger('value');
    if (action === 'fairqueue') guild.settings.fairQueue = interaction.options.getBoolean('enabled');
    if (action === 'djrole') guild.settings.djRoleId = interaction.options.getRole('role')?.id || null;
    if (action === 'reset') guild.settings = { ...DEFAULT_SETTINGS };
  });
  const settings = library.settings(interaction.guildId);
  const player = interaction.client.lavalink.getPlayer(interaction.guildId);
  if (action === 'fairqueue' && settings.fairQueue && player && interaction.member?.voice?.channel?.id === player.voiceChannelId) {
    player.queue.tracks.splice(0, player.queue.tracks.length, ...fairOrder(player.queue.tracks, player.queue.current?.requester?.id));
    await player.queue.utils?.save?.();
  }
  return interaction.reply(ephemeralText(`Default volume: ${settings.volume}%\nFair queue: ${settings.fairQueue ? 'on — listeners take turns' : 'off — songs keep arrival order'}\nControls: ${settings.djRoleId ? `DJ role (ID ${settings.djRoleId}) and server managers` : 'everyone in the voice channel'}\n${action === 'volume' ? 'The volume default applies to new sessions. Use /volume for the current session.' : 'Listeners can always add music, save favorites and use /voteskip.'}`));
}
