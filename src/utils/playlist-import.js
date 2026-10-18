import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { LIBRARY_LIMITS, trackReference } from './library.js';
import { COLORS, ephemeralText, textPayload } from './messages.js';
import { NO_MENTIONS, plainText, safeText } from './presentation.js';
import { searchFailureMessage, searchMusic } from './search.js';
import { canManageMusic } from './guards.js';

// Importing a public playlist into favorites or a shared mix: one bounded
// lookup builds a preview of public catalog references, and a confirmation
// saves that same preview. Encoded tracks and signed URLs are never kept.
export const IMPORT_LIMITS = Object.freeze({ tracks: 100, previews: 100, ttlMs: 10 * 60_000, active: 4 });
const HOSTS = /^(?:(?:www|music|m)\.)?youtube\.com$|^youtu\.be$|^(?:(?:www|m|on)\.)?soundcloud\.com$|^open\.spotify\.com$/i;
const previews = new Map();
const loading = new Set();

export function importLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.test(url.hostname)) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

/**
 * Look up a public link and keep the first 100 tracks as public references.
 * @returns {Promise<{ title: string, references: object[], unmatched: number, capped: boolean, partial: boolean }>}
 */
export async function resolveImport(source, link, requester, { search = searchMusic } = {}) {
  const result = await search(source, link, requester, { timeoutMs: 20_000 });
  const tracks = Array.isArray(result?.tracks) && !['error', 'empty'].includes(result?.loadType) ? result.tracks : [];
  if (!tracks.length) return { error: searchFailureMessage(result, link) };
  const spotify = result.spotifyImport;
  const considered = tracks.slice(0, IMPORT_LIMITS.tracks);
  const references = considered.map(trackReference).filter(Boolean);
  // Spotify matches only what it could pair with a full recording; the rest
  // were unavailable or ran out of time. Other sources list tracks directly.
  const unmatched = (Number(spotify?.unavailableCount) || 0) + (Number(spotify?.remainingCount) || 0) + considered.length - references.length;
  const title = plainText(result.playlist?.name || result.playlist?.title || (tracks.length === 1 ? tracks[0]?.info?.title : ''), { fallback: 'This link', maxLength: 100 });
  return { title, references, unmatched, capped: spotify ? Boolean(spotify.capped) : tracks.length > IMPORT_LIMITS.tracks, partial: Boolean(spotify?.partial) };
}

/** Skip songs already saved (or repeated in the playlist) and stop at the free space. */
export function planImport(existing, references, capacity) {
  const seen = new Set(existing.map(track => track.uri));
  const add = []; let duplicates = 0; let overLimit = 0;
  for (const reference of references) {
    if (seen.has(reference.uri)) { duplicates++; continue; }
    seen.add(reference.uri);
    if (add.length < Math.max(0, capacity)) add.push(reference); else overLimit++;
  }
  return { add, duplicates, overLimit };
}

function favoriteSpace(library, userId, list = library.favorites(userId)) {
  // Migrated overflow returns first as space opens, like /favorite add.
  return library.favoriteOverflowCount(userId) ? 0 : LIBRARY_LIMITS.favorites - list.length;
}

function sweep(now = Date.now()) { for (const [token, preview] of previews) if (preview.expires <= now) previews.delete(token); }

function remember(preview) {
  sweep();
  for (const [token, saved] of previews) if (saved.userId === preview.userId) previews.delete(token);
  while (previews.size >= IMPORT_LIMITS.previews) previews.delete(previews.keys().next().value);
  const token = randomBytes(16).toString('hex');
  previews.set(token, { ...preview, expires: Date.now() + IMPORT_LIMITS.ttlMs });
  return token;
}

function take(token, interaction, target) {
  sweep();
  const preview = previews.get(token);
  if (!preview || preview.userId !== interaction.user?.id || preview.guildId !== interaction.guildId) return null;
  if (target && (target.kind !== preview.target.kind || target.key !== preview.target.key || target.link !== preview.link)) return null;
  previews.delete(token);
  return preview;
}

export function resetImportPreviews() { previews.clear(); loading.clear(); }

const plural = (count, one, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
const destination = target => target.kind === 'favorites' ? 'your favorites' : `**${safeText(target.key, { maxLength: 40 })}**`;
const limitText = target => target.kind === 'favorites' ? `favorites hold ${LIBRARY_LIMITS.favorites.toLocaleString('en-US')} tracks` : `a mix holds ${LIBRARY_LIMITS.mixTracks} tracks`;

function sourceNotes({ capped, partial }) {
  const lines = [];
  if (capped) lines.push(`Only the first ${IMPORT_LIMITS.tracks} tracks of a playlist are imported.`);
  if (partial) lines.push('Spotify shows only part of some playlists, so this may not be the whole list.');
  return lines;
}

function notes(preview, { duplicates, overLimit }, target) {
  const lines = [];
  if (duplicates) lines.push(`${plural(duplicates, 'track')} ${duplicates === 1 ? 'is' : 'are'} already saved.`);
  if (preview.unmatched) lines.push(`${plural(preview.unmatched, 'track')} couldn’t be matched to a public recording.`);
  if (overLimit) lines.push(`${plural(overLimit, 'track')} won’t fit: ${limitText(target)}.`);
  return [...lines, ...sourceNotes(preview)];
}

function previewPayload(preview, token) {
  const { found, plan, target } = preview;
  const lines = plan.add.slice(0, 10).map((track, index) => `**${index + 1}.** ${safeText(track.title, { maxLength: 100 })} — ${safeText(track.author, { maxLength: 60 })}`);
  if (plan.add.length > 10) lines.push(`…and ${plural(plan.add.length - 10, 'more track')}.`);
  const summary = plan.add.length
    ? `${plural(found, 'track')} found. ${plural(plan.add.length, 'track')} will be added to ${destination(target)}.`
    : `${plural(found, 'track')} found. Nothing new to add to ${destination(target)}.`;
  const embed = new EmbedBuilder().setColor(COLORS.brand).setTitle(`Import ${safeText(preview.title, { maxLength: 100 })}`)
    .setDescription([summary, ...notes(preview, plan, target), ...(lines.length ? ['', ...lines] : [])].join('\n'))
    .setFooter({ text: plan.add.length ? 'Nothing is saved until you choose Import. This preview expires in 10 minutes.' : 'Nothing was saved.' });
  const components = token ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`import:v1:confirm:${token}`).setStyle(ButtonStyle.Primary).setLabel(`Import ${plural(plan.add.length, 'track')}`),
    new ButtonBuilder().setCustomId(`import:v1:cancel:${token}`).setStyle(ButtonStyle.Secondary).setLabel('Cancel'),
  )] : [];
  return { embeds: [embed], components, allowedMentions: NO_MENTIONS };
}

function publicPreview(preview, token) {
  const { found, plan, target } = preview;
  return { id: token, target: target.kind, name: target.key || null, title: preview.title, found, toAdd: plan.add.length,
    duplicates: plan.duplicates, unmatched: preview.unmatched, overLimit: plan.overLimit,
    limit: target.kind === 'favorites' ? LIBRARY_LIMITS.favorites : LIBRARY_LIMITS.mixTracks,
    notes: sourceNotes(preview),
    tracks: plan.add.map(track => ({ title: track.title, author: track.author })) };
}

function targetState(interaction, target) {
  const library = interaction.client.library;
  if (target.kind === 'favorites') {
    const list = library.favorites(interaction.user.id);
    return { existing: list, capacity: favoriteSpace(library, interaction.user.id, list) };
  }
  const mixes = library.readGuild(interaction.guildId).mixes;
  const mix = Object.hasOwn(mixes, target.key) ? mixes[target.key] : null;
  if (mix && mix.ownerId !== interaction.user.id && !canManageMusic(interaction)) return { error: 'That mix belongs to another listener. Only its creator or a server manager can add to it.' };
  if (!mix && Object.keys(mixes).length >= LIBRARY_LIMITS.mixes) return { error: `This server can save ${LIBRARY_LIMITS.mixes} mixes. Remove an unused mix or import into an existing one.` };
  return { existing: mix?.tracks || [], capacity: LIBRARY_LIMITS.mixTracks - (mix?.tracks.length || 0) };
}

/** Look up the link and show what would be saved. Nothing is written. */
export async function previewImport(interaction, target, { search } = {}) {
  const link = importLink(interaction.options.getString('link'));
  if (!link) return interaction.reply(ephemeralText('Paste a public YouTube, YouTube Music, Spotify or SoundCloud link.'));
  const before = targetState(interaction, target);
  if (before.error) return interaction.reply(ephemeralText(before.error));
  const node = interaction.client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
  if (!node?.connected || !node.search) return interaction.reply(ephemeralText('The music catalog is temporarily unavailable. Try again shortly.'));
  const userId = interaction.user.id;
  if (loading.has(userId) || loading.size >= IMPORT_LIMITS.active) return interaction.reply(ephemeralText('Another import is still loading. Try again when it finishes.'));
  loading.add(userId);
  let resolved;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    resolved = await resolveImport(node, link, interaction.user, { search });
  } catch {
    resolved = { error: 'Couldn’t load that link in time. Try again in a moment.' };
  } finally { loading.delete(userId); }
  if (resolved.error) return interaction.editReply(textPayload(resolved.error));
  // Access and the target can change during a slow lookup.
  await interaction.portalRecheck?.();
  const state = targetState(interaction, target);
  if (state.error) return interaction.editReply(textPayload(state.error));
  const plan = planImport(state.existing, resolved.references, state.capacity);
  const preview = { ...resolved, userId, guildId: interaction.guildId, target, link, found: resolved.references.length + resolved.unmatched, plan };
  const token = plan.add.length ? remember(preview) : null;
  interaction.portalImportPreview?.(publicPreview(preview, token));
  return interaction.editReply(previewPayload(preview, token));
}

function respond(interaction, text) {
  if (interaction.isMessageComponent?.()) return interaction.update({ ...textPayload(text), embeds: [], components: [] });
  return interaction.reply(ephemeralText(text));
}

/** Save a confirmed preview, checking limits and permissions again at write time. */
export async function commitImport(interaction, token, expected = null) {
  const preview = take(token, interaction, expected);
  if (!preview) return respond(interaction, 'This import preview expired or changed. Preview the link again.');
  // Save at most what the preview showed; earlier skips still count in the report.
  const { target } = preview;
  const references = preview.plan.add;
  const library = interaction.client.library;
  let result;
  if (target.kind === 'favorites') {
    result = await library.updateFavorites(interaction.user.id, async list => {
      await interaction.portalRecheck?.();
      const plan = planImport(list, references, favoriteSpace(library, interaction.user.id, list));
      list.push(...plan.add);
      return plan;
    });
  } else {
    result = await library.updateGuild(interaction.guildId, async guild => {
      await interaction.portalRecheck?.();
      const mix = Object.hasOwn(guild.mixes, target.key) ? guild.mixes[target.key] : null;
      if (mix && mix.ownerId !== interaction.user.id && !canManageMusic(interaction)) return { error: 'That mix belongs to another listener. Only its creator or a server manager can add to it.' };
      if (!mix && Object.keys(guild.mixes).length >= LIBRARY_LIMITS.mixes) return { error: `This server can save ${LIBRARY_LIMITS.mixes} mixes. Remove an unused mix first.` };
      const plan = planImport(mix?.tracks || [], references, LIBRARY_LIMITS.mixTracks - (mix?.tracks.length || 0));
      if (plan.add.length && mix) { mix.tracks.push(...plan.add); mix.savedAt = Date.now(); }
      else if (plan.add.length) guild.mixes[target.key] = { ownerId: interaction.user.id, tracks: plan.add, savedAt: Date.now() };
      return plan;
    });
  }
  if (result.error) return respond(interaction, result.error);
  result.duplicates += preview.plan.duplicates; result.overLimit += preview.plan.overLimit;
  const lead = result.add.length ? `Added ${plural(result.add.length, 'track')} to ${destination(target)}.` : `Nothing new was added to ${destination(target)}.`;
  return respond(interaction, [lead, ...notes(preview, result, target)].join(' '));
}

export async function cancelImport(interaction, token) {
  const preview = previews.get(token);
  if (preview && preview.userId === interaction.user?.id) previews.delete(token);
  return interaction.update({ ...textPayload('Import cancelled. Nothing was saved.'), embeds: [], components: [] });
}
