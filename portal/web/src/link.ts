// Signing in another screen with a code (ADR-0019). A TV shows a code and a QR code for
// /link?code=XXXX-XXXX; the code is read once on page load, the address bar is reset to /,
// and the code is kept in memory. While Discord sign-in is in progress it is held in this
// tab's session storage, for no longer than a code lives, and read back exactly once.
const LINK_PATH = '/link';
const HELD_KEY = 'vybatron.link';
const HELD_MS = 10 * 60_000;
const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

// Up to 8 code letters, uppercase, shown as XXXX-XXXX once there are more than four.
export function formatCode(value: string): string {
  const letters = [...value.toUpperCase()].filter(letter => LETTERS.includes(letter)).slice(0, 8).join('');
  return letters.length > 4 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : letters;
}
export const completeCode = (value: string) => /^[A-Z]{4}-[A-Z]{4}$/.test(formatCode(value));

// `code` is '' when /link was opened without one.
export interface LinkRequest { code: string }

function capture(): LinkRequest | null {
  let held: string | null = null;
  try { held = sessionStorage.getItem(HELD_KEY); sessionStorage.removeItem(HELD_KEY); } catch { /* Storage is optional. */ }
  if (location.pathname === LINK_PATH) {
    const code = formatCode(new URLSearchParams(location.search).get('code') || '');
    history.replaceState(null, '', '/');
    return { code };
  }
  try {
    const value = held ? JSON.parse(held) as { code?: unknown; at?: unknown } : null;
    return typeof value?.code === 'string' && typeof value.at === 'number' && Date.now() - value.at < HELD_MS ? { code: formatCode(value.code) } : null;
  } catch { return null; }
}

// Read once per page load, before the first render.
export const initialLink = capture();

// Keeps the code through the Discord sign-in round trip in this tab only.
export function holdLinkForSignIn(link: LinkRequest | null) {
  if (!link) return;
  try { sessionStorage.setItem(HELD_KEY, JSON.stringify({ code: link.code, at: Date.now() })); } catch { /* Sign-in still works; the code is lost. */ }
}
