import { ephemeralText } from './messages.js';
import { PermissionFlagsBits } from 'discord.js';
import { isPlaybackRecovering } from '../playback-recovery.js';

export function canManageMusic(interaction) {
  return Boolean(interaction.portalAdmin === true || (interaction.user?.id && interaction.guild?.ownerId === interaction.user.id) || interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
    || interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

export function hasDJAccess(interaction) {
  // Maintainer configuration access never grants a playback/DJ override.
  if ((interaction.user?.id && interaction.guild?.ownerId === interaction.user.id) || interaction.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
    || interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  const roleId = interaction.client.library?.settings(interaction.guildId)?.djRoleId;
  return !roleId || Boolean(interaction.member?.roles?.cache?.has?.(roleId));
}

async function reject(interaction, message) {
  if (interaction.portalReject) return interaction.portalReject(message);
  const payload = ephemeralText(message);
  try {
    if (interaction.deferred && !interaction.isMessageComponent?.()) {
      const { flags, ...edit } = payload;
      await interaction.editReply(edit);
    } else if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {}
  return null;
}

// V3: user must be in a voice channel.
export async function requireUserVoice(interaction, { checkBotAccess = false } = {}) {
  await interaction.portalRecheck?.();
  const channel = interaction.member?.voice?.channel;
  if (!channel) return reject(interaction, 'Join a voice channel, then try again.');
  const active = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (active?.voiceChannelId && active.voiceChannelId !== channel.id) {
    return reject(interaction, 'Join the bot’s voice channel to add music or control this session.');
  }
  if (checkBotAccess && channel.joinable === false) {
    return reject(
      interaction,
      'Vybatron can’t join that voice channel. Check its View Channel and Connect permissions, and make sure the channel isn’t full.'
    );
  }
  if (checkBotAccess && channel.speakable === false) {
    return reject(
      interaction,
      'Vybatron can’t play audio in that voice channel. Grant it the Speak permission, then try again.'
    );
  }
  return channel;
}

// V8: control commands require an active player and the invoker in its voice channel.
export async function requireControl(interaction, { checkDJ = true } = {}) {
  const channel = await requireUserVoice(interaction);
  if (!channel) return null;
  interaction.portalAssertRevision?.();
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!player) return reject(interaction, 'Nothing is playing. Add something with /play.');
  if (player.voiceChannelId && player.voiceChannelId !== channel.id) {
    return reject(interaction, 'Join the bot’s voice channel to control playback.');
  }
  if (checkDJ && !hasDJAccess(interaction)) {
    return reject(interaction, 'Playback controls are reserved for this server’s DJ role. You can still add songs, save favorites, or use /voteskip.');
  }
  if (isPlaybackRecovering(player)) {
    const safe = new Set(['skip', 'skipto', 'stop', 'clear', 'voteskip', 'favorite', 'mix', 'replay', 'remove', 'move', 'shuffle', 'loop', 'radio']);
    const safeComponent = /^player:v1:(skip|stop|stop-confirm)$/.test(interaction.customId || '')
      || /^queue:v[12]:jump:/.test(interaction.customId || '') || /^history:v2:replay:/.test(interaction.customId || '');
    if (!safe.has(interaction.commandName) && !safeComponent) return reject(interaction, 'Audio is reconnecting. Your queue is safe; wait a moment, or use Skip or Stop.');
  }
  if (interaction.commandName !== 'replay') interaction.portalMutationStarted?.();
  return player;
}

// Saving a public reference does not require joining voice. Discord buttons
// retain their session/voice binding; slash/web library forms only need View
// Channel for the source session, just like the portal's library read policy.
export async function requireLibrarySource(interaction, { queued = false } = {}) {
  if (interaction.isMessageComponent?.()) return requireControl(interaction, { checkDJ: false });
  await interaction.portalRecheck?.();
  const player = interaction.client.lavalink?.getPlayer(interaction.guildId);
  if (!(queued ? player?.queue?.tracks?.length : player?.queue?.current)) return reject(interaction, 'Nothing is playing. Add something with /play.');
  if (!await requireSessionVisibility(interaction, player)) return null;
  interaction.portalAssertRevision?.();
  return player;
}

export async function requireSessionVisibility(interaction, source) {
  if (!source) return true;
  const channels = interaction.guild?.channels?.cache;
  const visible = [source.voiceChannelId, source.textChannelId].every(id => {
    const channel = channels?.get(id);
    return channel?.guildId === interaction.guildId && channel.permissionsFor?.(interaction.member)?.has(PermissionFlagsBits.ViewChannel);
  });
  if (!visible) { await reject(interaction, 'The listening channel is not visible to you.'); return false; }
  return true;
}

export async function recheckEnqueueRequest(interaction, player, expectedChannel, { checkDJ = false } = {}) {
  if (interaction.client.runtimeState?.draining) {
    await reject(interaction, 'Vybatron is updating. Your saved music is safe; try again in a minute.');
    return false;
  }
  if (player.getData?.('vybertron.stopping') === true) {
    await reject(interaction, 'The listening session is stopping. Try /play again in a moment.');
    return false;
  }
  const channel = await requireUserVoice(interaction, { checkBotAccess: !player.connected });
  if (!channel) return false;
  if (channel.id !== expectedChannel.id || interaction.client.lavalink.getPlayer(interaction.guildId) !== player
    || (player.voiceChannelId && player.voiceChannelId !== channel.id)) {
    await reject(interaction, 'The voice session changed while loading. Stay in the bot’s voice channel and try again.');
    return false;
  }
  if (checkDJ && !hasDJAccess(interaction)) {
    await reject(interaction, 'Your DJ access changed while loading. Use /play to add a song to the queue.');
    return false;
  }
  return true;
}
