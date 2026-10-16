import { OAuth2Scopes, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

// What the bot needs to post its player and play in voice; voice status is optional polish.
export const INVITE_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.SetVoiceChannelStatus,
]).freeze();

// Discord's authorize page lists the servers the user can manage, so one link covers every server they're in.
export function botInviteUrl(applicationId) {
  if (!/^\d{17,20}$/.test(String(applicationId ?? ''))) return null;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', String(applicationId));
  url.searchParams.set('scope', [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands].join(' '));
  url.searchParams.set('permissions', INVITE_PERMISSIONS.bitfield.toString());
  // Guild install only; the bot has no user-installed commands.
  url.searchParams.set('integration_type', '0');
  return url.href;
}

export function clientInviteUrl(client) {
  return botInviteUrl(client?.application?.id ?? client?.user?.id);
}

// The bot is private: Discord lets only its owner complete an install, so only the
// owner and trusted portal operators are shown the link. Mirrors the portal maintainer rule.
export async function canInvite(client, userId) {
  if (!userId) return false;
  if (client?.operatorIds?.has?.(String(userId))) return true;
  const application = client?.application;
  let owner = application?.owner;
  if (!owner && typeof application?.fetch === 'function') owner = (await application.fetch().catch(() => null))?.owner;
  // User owners and verified team owners only, never every team member.
  return Boolean(owner) && (owner.ownerId || owner.id) === String(userId);
}

export async function inviteUrlFor(client, userId) {
  return await canInvite(client, userId) ? clientInviteUrl(client) : null;
}
