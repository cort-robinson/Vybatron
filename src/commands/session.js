import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { requireUserVoice, hasDJAccess, recheckEnqueueRequest, requireSessionVisibility } from '../utils/guards.js';
import { savedSession } from '../utils/sessions.js';
import { enqueueTracks, getOrCreatePlayer, resolveReferences } from '../utils/enqueue.js';
import { collectionPayload } from '../utils/library-actions.js';
import { ephemeralText, textPayload } from '../utils/messages.js';
import { refresh, withControllerLink } from '../utils/player-controller.js';

export const data = new SlashCommandBuilder().setName('session').setDescription('Recover a listening session after a bot restart')
  .addSubcommand(s => s.setName('show').setDescription('Preview the latest checkpoint; kept for 72 hours'))
  .addSubcommand(s => s.setName('resume').setDescription('Rejoin the saved voice channel and restore the queue at its checkpoint'))
  .addSubcommand(s => s.setName('discard').setDescription('Discard the saved session checkpoint'));

export async function execute(interaction) {
  const action = interaction.options.getSubcommand();
  const library = interaction.client.library;
  const saved = savedSession(library, interaction.guildId);
  if (!saved) return interaction.reply(ephemeralText('No recent listening session is saved. Start one with /play.'));
  if (!await requireSessionVisibility(interaction, saved)) return;
  if (action === 'show') return interaction.reply(collectionPayload('Saved listening session', saved.tracks, 1, 'Saved for 72 hours · /session resume'));
  if (!hasDJAccess(interaction)) return interaction.reply(ephemeralText('The server’s DJ role or Manage Server permission is required to manage this session.'));
  const channel = await requireUserVoice(interaction, { checkBotAccess: true }); if (!channel) return;
  if (channel.id !== saved.voiceChannelId) return interaction.reply(ephemeralText('Join the voice channel where this session was saved, then try again.'));
  if (action === 'discard') {
    await library.updateGuild(interaction.guildId, async guild => { await interaction.portalRecheck?.(); guild.session = null; });
    return interaction.reply(ephemeralText('Discarded the saved listening session. Your favorites and mixes stay saved.'));
  }
  const existing = interaction.client.lavalink.getPlayer(interaction.guildId);
  if (existing?.queue.current || existing?.queue.tracks.length) return interaction.reply(ephemeralText('A listening session is already active. Stop it before restoring a saved one.'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { player, created } = getOrCreatePlayer(interaction, channel, { textChannelId: saved.textChannelId });
  let added = false;
  try {
    const { tracks, missing } = await resolveReferences(player, saved.tracks, interaction.user, { limit: 501 });
    if (!tracks.length) return interaction.editReply(textPayload('The saved tracks are unavailable. Start a fresh session with /play.'));
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    // Current + 500 upcoming tracks fit the same live queue limit.
    const first = tracks.shift();
    const exactFirst = first.info?.sourceName === saved.tracks[0].sourceName && first.info?.identifier === saved.tracks[0].identifier;
    interaction.portalMutationStarted?.();
    await enqueueTracks(interaction.client, player, tracks, { fair: false }); added = true;
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    if (!player.connected) await player.connect();
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    await player.setVolume(saved.volume);
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    await player.setRepeatMode(saved.repeatMode);
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    const position = exactFirst && !first.info.isStream && saved.position > 0 && saved.position < first.info.duration ? saved.position : 0;
    await player.play({ clientTrack: first, position, paused: saved.paused });
    if (!await recheckEnqueueRequest(interaction, player, channel, { checkDJ: true })) return;
    await refresh(interaction.client, player);
    return interaction.editReply(textPayload(withControllerLink(`Restored ${tracks.length + 1} tracks${saved.paused ? ' and kept playback paused' : ' at the last checkpoint'}.${missing.length ? ` ${missing.length} unavailable tracks were left out.` : ''}`, interaction, player)));
  } finally { if (created && !added) await player.destroy('unused-request-disconnect').catch(() => {}); }
}
