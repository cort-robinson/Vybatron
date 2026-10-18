import { MusicLibrary } from '../src/utils/library.js';

// Libraries hold an open SQLite store; Windows cannot remove a directory until
// it closes. Test cleanup closes every library a test opened.
const open = new Set();

export async function openLibrary(filePath, options) {
  const library = await new MusicLibrary(filePath, options).open();
  open.add(library);
  return library;
}

export async function closeLibraries() {
  const libraries = [...open];
  open.clear();
  await Promise.all(libraries.map(library => library.close()));
}
