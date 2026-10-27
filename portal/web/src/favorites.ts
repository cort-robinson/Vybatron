import type { Command } from './types';
import type { Portal } from './playback';

// Discord saves the song its player holds. A song on this device isn't in that player, so its public
// link goes through the favorites import instead: a one-song preview, then its commit.
export async function saveByLink(portal: Portal, uri: string) {
  const link = { command: 'favorite', subcommand: 'import', options: { link: uri } } satisfies Command;
  const preview = await portal.previewImport(link);
  return !!preview?.id && portal.run({ ...link, expectedImportId: preview.id }, 'library');
}
