import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { playQuery, sessionHasMusic } from '../commands/play.js';
import { getTrackChoices, resolveAutocompleteTrack } from './autocomplete.js';
import { hasDJAccess, requireUserVoice } from './guards.js';
import { historySessionKey } from './history.js';
import { ephemeralText, textPayload } from './messages.js';
import { formatDuration, isUrl } from './presentation.js';
import { guardedMutation } from './requests.js';
import { sharedChannelIds } from './room-taste.js';
import { validatePlaybackQuery } from './search.js';

// Each private picker admits one choice. Eviction and expiry both close the picker.
const openPickers = new Map();
const PICKER_LIMIT = 500;
const PICKER_LIFETIME_MS = 5 * 60_000;

export function startCard() {
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:v1:add').setLabel('Add a song').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('music:v1:mix').setLabel('Play our mix').setStyle(ButtonStyle.Secondary),
  );
  return { ...textPayload('Join voice, then add a song or start a mix for the room. Your requests play before autoplay picks.'), components: [buttons] };
}

function scope(interaction, channel) {
  const player = interaction.client.lavalink.getPlayer(interaction.guildId);
  return `${channel.id}:${historySessionKey(player) || 'idle'}`;
}

function songModal(mode, binding) {
  const input = new TextInputBuilder().setCustomId('query').setLabel('Song and artist, or a music link')
    .setStyle(TextInputStyle.Short).setMaxLength(200).setRequired(true);
  return new ModalBuilder().setCustomId(`music:v1:submit:${mode}:${binding}`)
    .setTitle(mode === 'mix' ? 'Choose a starting song' : 'Add a song').addComponents(new ActionRowBuilder().addComponents(input));
}

function roomFavorites(interaction, channel) {
  const stats = interaction.client.stats;
  if (!stats?.available) return [];
  // channel.members silently omits voice states whose member is missing from cache.
  const members = [];
  for (const state of interaction.guild.voiceStates.cache.values()) {
    if (state.channelId !== channel.id) continue;
    if (!state.member) return [];
    if (!state.member.user.bot) members.push(state.member);
  }
  const visibleChannelIds = sharedChannelIds(stats, interaction.guild, members);
  return stats.serverFavorites(interaction.guildId, { visibleChannelIds }).onRepeat;
}

export async function openMusicCard(interaction, mode) {
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return;
  const binding = scope(interaction, channel);
  if (mode === 'add') return interaction.showModal(songModal(mode, binding));
  if (!hasDJAccess(interaction)) return interaction.reply(ephemeralText('Starting autoplay needs the DJ role. Choose Add a song to queue a request.'));
  const player = interaction.client.lavalink.getPlayer(interaction.guildId);
  if (sessionHasMusic(player)) {
    return interaction.reply(ephemeralText('A session is already going. Choose Add a song to join the queue.'));
  }
  const favorites = roomFavorites(interaction, channel);
  if (!favorites.length) return interaction.showModal(songModal(mode, binding));
  const seed = favorites[Math.floor(Math.random() * Math.min(5, favorites.length))].track;
  return guardedMutation(interaction, async request => {
    if (!await checkScope(request, binding, mode)) return;
    return playQuery(request, seed.uri, {
      roomMix: true, automaticSeed: true,
      seedAvailable: () => roomFavorites(request, channel).some(entry => entry.track.uri === seed.uri),
    });
  }, { playback: true, ordered: true, privateReply: true });
}

async function checkScope(interaction, binding, mode) {
  const channel = await requireUserVoice(interaction, { checkBotAccess: true });
  if (!channel) return false;
  // Two people can open the idle card before either one finishes a request.
  if (mode === 'add' && binding === `${channel.id}:idle`) return true;
  if (scope(interaction, channel) === binding) return true;
  const message = 'The voice session changed. Open the music controls again.';
  if (interaction.deferred) await interaction.editReply({ ...textPayload(message), components: [] });
  else await interaction.reply(ephemeralText(message));
  return false;
}

export async function submitSong(interaction) {
  const [, , , mode, voice, session] = interaction.customId.split(':');
  const binding = `${voice}:${session}`;
  const query = interaction.fields.getTextInputValue('query').trim();
  const invalid = validatePlaybackQuery(query);
  if (invalid) return interaction.reply(ephemeralText(invalid));
  if (isUrl(query)) return queueSong(interaction, binding, mode, query);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!await checkScope(interaction, binding, mode)) return;
  const choices = await getTrackChoices(interaction, { search: query, timeoutMs: 8000 });
  if (!choices.length) return interaction.editReply(textPayload('No recordings found. Try a song and artist, or paste a music link.'));
  if (openPickers.size >= PICKER_LIMIT) openPickers.delete(openPickers.keys().next().value);
  openPickers.set(interaction.id, Date.now() + PICKER_LIFETIME_MS);
  const select = new StringSelectMenuBuilder().setCustomId(`music:v1:pick:${mode}:${binding}:${interaction.user.id}:${interaction.id}`)
    .setPlaceholder('Choose a recording').addOptions(choices.map(({ name, value }) => {
      const duration = resolveAutocompleteTrack(value, interaction.user.id).track?.info.duration;
      return { label: name, value, ...(duration > 0 && { description: formatDuration(duration) }) };
    }));
  return interaction.editReply({ ...textPayload('Which recording do you want?'), components: [new ActionRowBuilder().addComponents(select)] });
}

export async function pickSong(interaction) {
  const [, , , mode, voice, session, owner, pickerId] = interaction.customId.split(':');
  if (owner !== interaction.user.id) return interaction.reply(ephemeralText('Open Add a song to choose your own recording.'));
  return queueSong(interaction, `${voice}:${session}`, mode, interaction.values[0], pickerId);
}

function queueSong(interaction, binding, mode, query, pickerId) {
  return guardedMutation(interaction, async request => {
    if (!await checkScope(request, binding, mode)) return;
    // A pick is already private. Clear the menu as soon as it is accepted.
    if (interaction.isStringSelectMenu?.()) {
      const expiresAt = openPickers.get(pickerId);
      openPickers.delete(pickerId);
      if (!expiresAt || expiresAt <= Date.now()) return request.followUp(ephemeralText('This picker was already used or expired. Open Add a song to choose again.'));
      await request.editReply({ ...textPayload('Adding your recording…'), components: [] });
    }
    return playQuery(request, query, { roomMix: mode === 'mix' });
  }, { playback: true, ordered: true, lookupOutsideLane: true });
}
