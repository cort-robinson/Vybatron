import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice, recheckEnqueueRequest } from '../utils/guards.js';
import { enqueueTracks, getOrCreatePlayer, resolveReferences } from '../utils/enqueue.js';
import { textPayload } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';
import { fail } from './errors.js';

// Portal-only: moves a listener's own browser session into their voice channel,
// like casting. It is never deployed as a slash command. The queue arrives as
// public catalog links in the body's `tracks`; everything else uses the same
// guards and restore path as /session resume.
export const TRANSFER_TRACKS = 100;
export const MAX_POSITION_MS = 24 * 60 * 60_000;
export const data = new SlashCommandBuilder().setName('transfer').setDescription('Move this device’s session into your voice channel')
  .addIntegerOption(o => o.setName('position').setDescription('Position in the first song, in milliseconds').setRequired(true).setMinValue(0).setMaxValue(MAX_POSITION_MS))
  .addBooleanOption(o => o.setName('paused').setDescription('Keep playback paused').setRequired(true))
  .addIntegerOption(o => o.setName('volume').setDescription('Volume').setRequired(true).setMinValue(0).setMaxValue(100))
  .addStringOption(o => o.setName('repeat').setDescription('Repeat mode').setRequired(true)
    .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' }));

export function validTransferTracks(tracks) {
  return Array.isArray(tracks) && tracks.length >= 1 && tracks.length <= TRANSFER_TRACKS && tracks.every(uri => {
    if (typeof uri !== 'string' || uri.length > 512 || /[\u0000-\u001f\u007f\s]/.test(uri)) return false;
    try { return new URL(uri).protocol === 'https:'; } catch { return false; }
  });
}

export async function execute(interaction) {
  const channel = await requireUserVoice(interaction, { checkBotAccess: true }); if (!channel) return;
  const existing = interaction.client.lavalink.getPlayer(interaction.guildId);
  // Moving in never replaces what other listeners are hearing.
  if (existing?.queue.current || existing?.queue.tracks.length) fail(409, 'session_active', 'Music is already playing in this server. Join that session, or add your songs to its queue.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { player, created } = getOrCreatePlayer(interaction, channel);
  let added = false;
  try {
    const { tracks, missing } = await resolveReferences(player, interaction.portalTracks.map(uri => ({ uri })), interaction.user, { limit: TRANSFER_TRACKS });
    if (!tracks.length) return interaction.editReply(textPayload('None of these songs are available to play in Discord.'));
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    const first = tracks.shift();
    // Only the song the listener was hearing keeps its place.
    const exactFirst = !missing.some(ref => ref.uri === interaction.portalTracks[0]);
    const value = key => interaction.options.getInteger(key);
    interaction.portalMutationStarted?.();
    await enqueueTracks(interaction.client, player, tracks, { fair: false }); added = true;
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    if (!player.connected) await player.connect();
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    await player.setVolume(value('volume'));
    await player.setRepeatMode(interaction.options.getString('repeat'));
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    const position = exactFirst && !first.info.isStream && value('position') < first.info.duration ? value('position') : 0;
    const paused = interaction.options.getBoolean('paused');
    await player.play({ clientTrack: first, position, paused });
    if (!await recheckEnqueueRequest(interaction, player, channel)) return;
    await refresh(interaction.client, player);
    return interaction.editReply(textPayload(withControllerLink(`Moved ${tracks.length + 1} ${tracks.length ? 'songs' : 'song'} to ${channel.name}${paused ? ', paused' : ''}.${missing.length ? ` ${missing.length} unavailable ${missing.length === 1 ? 'song was' : 'songs were'} left out.` : ''}`, interaction, player)));
  } finally { if (created && !added) await player.destroy('unused-request-disconnect').catch(() => {}); }
}
