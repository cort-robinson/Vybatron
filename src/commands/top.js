import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { collectionPayload, loadCollection } from '../utils/library-actions.js';
import { ephemeralText, textPayload } from '../utils/messages.js';

export const SERVER_FAVORITE_LISTS = Object.freeze({ 'on-repeat': 'On repeat', 'forgotten-gems': 'Forgotten gems' });
const listOption = o => o.setName('list').setDescription('On repeat (default) or forgotten gems')
  .addChoices(...Object.entries(SERVER_FAVORITE_LISTS).map(([value, name]) => ({ name, value })));

export const data = new SlashCommandBuilder().setName('top').setDescription('Play what this server keeps coming back to')
  .addSubcommand(s => s.setName('show').setDescription('See this server’s favorites from sessions you can see').addStringOption(listOption)
    .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(3)))
  .addSubcommand(s => s.setName('play').setDescription('Queue a server favorites list').addStringOption(listOption)
    .addBooleanOption(o => o.setName('shuffle').setDescription('Shuffle the list before queuing it')));

// Plays in voice channels hidden from this member never feed their lists.
export function visibleStatsChannels(interaction) {
  const cache = interaction.guild?.channels?.cache;
  return (interaction.client.stats?.voiceChannelIds(interaction.guildId) || []).filter(id => {
    const channel = cache?.get(id);
    return channel?.guildId === interaction.guildId && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)
      && channel.permissionsFor?.(interaction.member)?.has(PermissionFlagsBits.ViewChannel);
  });
}

export function serverFavoriteTracks(interaction, list) {
  const lists = interaction.client.stats.serverFavorites(interaction.guildId, { visibleChannelIds: visibleStatsChannels(interaction) });
  return (list === 'forgotten-gems' ? lists.forgottenGems : lists.onRepeat).map(entry => entry.track);
}

function shuffled(tracks) {
  const copy = [...tracks];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

const EMPTY = {
  'on-repeat': 'Nothing is on repeat yet. Songs appear here after they play in voice channels you can see.',
  'forgotten-gems': 'No forgotten gems yet. Songs that were popular two to four months ago, with no plays since, appear here.',
};

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  const list = interaction.options.getString('list') || 'on-repeat';
  const label = SERVER_FAVORITE_LISTS[list];
  if (!interaction.client.stats?.available) return interaction.reply(ephemeralText('Server favorites are unavailable right now. Playback is unaffected.'));
  if (action === 'show') {
    const tracks = serverFavoriteTracks(interaction, list);
    if (!tracks.length) return interaction.reply(ephemeralText(EMPTY[list]));
    return interaction.reply(collectionPayload(`${label} in this server`, tracks, interaction.options.getInteger('page') || 1, 'From sessions you can see · Queue it with /top play'));
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const tracks = serverFavoriteTracks(interaction, list);
  if (!tracks.length) return interaction.editReply(textPayload(EMPTY[list]));
  return loadCollection(interaction, channel, interaction.options.getBoolean('shuffle') ? shuffled(tracks) : tracks, label);
}
