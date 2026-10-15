// The YouTube video a catalog link names. This device plays that video's audio,
// streamed by the bot through the portal; nothing here loads YouTube itself.
export function youtubeId(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    const id = host === 'youtube.com' && url.pathname === '/watch' ? url.searchParams.get('v') : host === 'youtu.be' ? url.pathname.slice(1) : null;
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
