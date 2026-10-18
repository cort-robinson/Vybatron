// Links shared to the installed app arrive at /share (the manifest's GET share
// target). The shared text is read once, the address bar is reset to /, and only
// the extracted link is kept, in memory. It is written to this tab's session
// storage only while Discord sign-in is in progress, and read back exactly once.
const SHARE_PATH = '/share';
const HELD_KEY = 'vybatron.share';
// Discord sign-in must finish within ten minutes; a held link expires with it.
const HELD_MS = 10 * 60_000;
// The play command's query limit (docs/portal-contract.md).
const MAX_LENGTH = 200;
// The sources the bot resolves from public links (src/utils/query.js), minus Bandcamp.
const SUPPORTED = /^(?:(?:www|music|m)\.)?youtube\.com$|^youtu\.be$|^(?:(?:www|m|on)\.)?soundcloud\.com$|^(?:open\.)?spotify\.com$/i;

// `link` is null when something was shared but it held no supported link.
export interface Shared { link: string | null }

export function supportedLink(value: string): string | null {
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    // Shared text often ends a link with punctuation that is not part of it.
    const candidate = match[0].replace(/[.,;:!?)\]}»”’]+$/u, '');
    let url: URL;
    try { url = new URL(candidate); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !SUPPORTED.test(url.hostname)) continue;
    if (url.href.length <= MAX_LENGTH) return url.href;
  }
  return null;
}

// Apps put the link in different fields; Android usually sends it inside `text`.
export function sharedLink(params: URLSearchParams): string | null {
  for (const field of ['url', 'text', 'title']) {
    const link = supportedLink(params.get(field) || '');
    if (link) return link;
  }
  return null;
}

function capture(): Shared | null {
  let held: string | null = null;
  try { held = sessionStorage.getItem(HELD_KEY); sessionStorage.removeItem(HELD_KEY); } catch { /* Storage is optional. */ }
  if (location.pathname === SHARE_PATH) {
    const link = sharedLink(new URLSearchParams(location.search));
    history.replaceState(null, '', '/');
    return { link };
  }
  try {
    const value = held ? JSON.parse(held) as { link?: unknown; at?: unknown } : null;
    const link = typeof value?.link === 'string' ? supportedLink(value.link) : null;
    return link && typeof value?.at === 'number' && Date.now() - value.at < HELD_MS ? { link } : null;
  } catch { return null; }
}

// Read once per page load, before the first render.
export const initialShare = capture();

// Keeps the link through the Discord sign-in round trip in this tab only.
export function holdForSignIn(shared: Shared | null) {
  if (!shared?.link) return;
  try { sessionStorage.setItem(HELD_KEY, JSON.stringify({ link: shared.link, at: Date.now() })); } catch { /* Sign-in still works; the link is lost. */ }
}
