import { useSyncExternalStore } from 'react';
import type { Command, ImportPreview } from './types';
import type { Portal } from './playback';

// Discord saves the song its player holds. A song on this device isn't in that player, so its public
// link goes through the favorites import instead: a one-song preview, then its commit.

// The same links the bot's import accepts (src/utils/playlist-import.js).
const HOSTS = /^(?:(?:www|music|m)\.)?youtube\.com$|^youtu\.be$|^(?:(?:www|m|on)\.)?soundcloud\.com$|^open\.spotify\.com$/i;
export function savable(uri: string | null | undefined) {
  try {
    const url = new URL(String(uri || ''));
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && HOSTS.test(url.hostname);
  } catch { return false; }
}

// Favorite play/remove commands made from a row this device shows. Their number may
// have moved only because of this device's own edits, so they follow their song by
// id. A number typed into a form is sent as typed.
const listed = new WeakSet<Command>();
export const fromList = <T extends Command>(command: T) => { listed.add(command); return command; };
export const isListed = (command: Command) => listed.has(command);

// One save at a time: the bot allows one import preview per listener, and a second tap would be refused.
let saving = false;
const listeners = new Set<() => void>();
const setSaving = (value: boolean) => { saving = value; listeners.forEach(listener => listener()); };
export const useSavingFavorite = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => saving);

// A preview without an id saves nothing; say why instead of leaving the heart unchanged in silence.
function declined(preview: ImportPreview) {
  if (preview.overLimit > 0) return `Your favorites hold at most ${preview.limit.toLocaleString()} songs. Remove one to save this song.`;
  if (preview.duplicates > 0 && preview.toAdd === 0) return 'This song is already in your favorites.';
  if (preview.unmatched > 0) return 'This song couldn’t be matched to a public recording, so it wasn’t saved.';
  return preview.notes[0] || 'This song couldn’t be saved to your favorites.';
}

export async function saveByLink(portal: Portal, uri: string | null | undefined) {
  if (saving) return false;
  if (!uri || !savable(uri)) { portal.notify('Songs from this source can’t be saved to favorites from this device yet.', 'info'); return false; }
  setSaving(true);
  try {
    const link = { command: 'favorite', subcommand: 'import', options: { link: uri } } satisfies Command;
    const preview = await portal.previewImport(link);
    if (!preview) return false; // previewImport has already said why.
    if (!preview.id) { portal.notify(declined(preview), 'info'); return false; }
    return await portal.run({ ...link, expectedImportId: preview.id }, 'library');
  } finally { setSaving(false); }
}
