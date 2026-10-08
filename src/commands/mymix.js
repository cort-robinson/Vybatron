import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice } from '../utils/guards.js';
import { collectionPayload, loadCollection } from '../utils/library-actions.js';
import { ephemeralText, textPayload } from '../utils/messages.js';
import { personalPlaylist } from '../utils/auto-playlists.js';
import { STATS_WINDOWS } from '../utils/play-stats.js';
import { shuffled, visibleStatsChannels } from './top.js';

export const PERSONAL_PLAYLISTS = Object.freeze({ mix: 'Your mix', top: 'Your top tracks', rediscover: 'Rediscover', artist: 'Artist mix' });
const WINDOW_LABELS = { '7d': 'Past week', '30d': 'Past month', '90d': 'Past 3 months', '365d': 'Past year', all: 'All time' };
const playlistOption = o => o.setName('playlist').setDescription('Your mix (default), top tracks, rediscover, or an artist mix')
  .addChoices(...Object.entries(PERSONAL_PLAYLISTS).map(([value, name]) => ({ name, value })));
const artistOption = o => o.setName('artist').setDescription('Artist for an artist mix (default: your most requested)').setMaxLength(100);
const windowOption = o => o.setName('window').setDescription('Time range for your top tracks (default: past month)')
  .addChoices(...Object.entries(WINDOW_LABELS).map(([value, name]) => ({ name, value })));

export const data = new SlashCommandBuilder().setName('mymix').setDescription('Your personal playlists, built from your requests and favorites')
  .addSubcommand(s => s.setName('show').setDescription('See one of your personal playlists').addStringOption(playlistOption).addStringOption(artistOption)
    .addStringOption(windowOption).addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1).setMaxValue(3)))
  .addSubcommand(s => s.setName('play').setDescription('Queue one of your personal playlists').addStringOption(playlistOption).addStringOption(artistOption)
    .addStringOption(windowOption).addBooleanOption(o => o.setName('shuffle').setDescription('Shuffle the playlist before queuing it')));

const EMPTY = {
  mix: 'Your mix fills in once you request songs here or save favorites. It picks new songs every Monday.',
  top: 'You have not requested songs in voice channels you can see in this time range. Try a longer range.',
  rediscover: 'Nothing to rediscover yet. Favorites you have not requested for 30 days appear here.',
  artist: 'No artist mix yet. Request a few songs by an artist, or favorite them, and their mix appears here.',
};
const FOOTERS = {
  mix: 'Changes every Monday · Queue it with /mymix play',
  top: 'Your requests only · Queue it with /mymix play playlist:top',
  rediscover: 'Favorites you have not requested in 30 days',
  artist: 'Your favorites and this server’s plays by this artist',
};

// Request stats belong to the person asking. Plays in voice channels hidden
// from them never contribute, the same rule as /top and the portal.
export function resolvePersonalPlaylist(interaction, kind) {
  const window = interaction.options.getString('window') || '30d';
  return personalPlaylist(interaction.client.stats, kind, {
    guildId: interaction.guildId, userId: interaction.user.id, favorites: interaction.client.library.favorites(interaction.user.id),
    visibleChannelIds: visibleStatsChannels(interaction), since: window === 'all' ? 0 : Date.now() - STATS_WINDOWS[window],
    artist: interaction.options.getString('artist')?.trim() || null,
  });
}

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  const kind = interaction.options.getString('playlist') || 'mix';
  if (!interaction.client.stats?.available) return interaction.reply(ephemeralText('Personal playlists are unavailable right now. Playback is unaffected.'));
  if (action === 'show') {
    const playlist = resolvePersonalPlaylist(interaction, kind);
    if (!playlist?.tracks.length) return interaction.reply(ephemeralText(EMPTY[kind]));
    return interaction.reply(collectionPayload(playlist.title, playlist.tracks, interaction.options.getInteger('page') || 1, FOOTERS[kind]));
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const playlist = resolvePersonalPlaylist(interaction, kind);
  if (!playlist?.tracks.length) return interaction.editReply(textPayload(EMPTY[kind]));
  return loadCollection(interaction, channel, interaction.options.getBoolean('shuffle') ? shuffled(playlist.tracks) : playlist.tracks, playlist.title);
}
