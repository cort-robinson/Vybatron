import type { Bootstrap, GuildSnapshot, Library, Track, Command, CommandResult, Configuration, Diagnostics, Activity, Recap, RecapWindow, Stats, StatsWindow } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterMs = 0) { super(message); this.name = 'ApiError'; }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(path, { ...init, signal, credentials: 'same-origin', cache: 'no-store' }); }
  catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiError(0, 'connection_lost', 'The portal could not reach Discord. Reconnect to get fresh state.');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const retryAfter = response.headers.get('Retry-After');
    const delay = retryAfter === null ? 0 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    throw new ApiError(response.status, body?.error?.code || 'request_failed',
      typeof body?.error?.message === 'string' ? body.error.message : 'This request could not be completed. Refresh and try again.',
      Number.isFinite(delay) ? Math.max(0, Math.min(delay, 60_000)) : 0);
  }
  if (!body || typeof body !== 'object') throw new ApiError(503, 'invalid_response', 'Live state is unavailable. Refresh and try again.');
  return body as T;
}

const guildPath = (id: string) => `/api/guilds/${encodeURIComponent(id)}`;
export const api = {
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>('/api/bootstrap', { signal }),
  snapshot: (id: string, signal?: AbortSignal) => request<GuildSnapshot>(guildPath(id), { signal }),
  configuration: async (id: string, signal?: AbortSignal): Promise<Configuration> => {
    const data = await request<Configuration>(`${guildPath(id)}/configuration`, { signal });
    if (data.guildId !== id || !Array.isArray(data.channels) || data.channels.length > 500 || !Array.isArray(data.roles) || data.roles.length > 250) {
      throw new ApiError(503, 'invalid_response', 'Channel and role options are unavailable. Try refreshing them.');
    }
    return data;
  },
  library: (id: string, signal?: AbortSignal) => request<Library>(`${guildPath(id)}/library`, { signal }),
  search: async (id: string, query: string, signal?: AbortSignal) => {
    const data = await request<{ tracks: Track[]; notice: string | null }>(`${guildPath(id)}/search?query=${encodeURIComponent(query)}`, { signal });
    if (!Array.isArray(data.tracks) || data.tracks.length > 50) throw new ApiError(503, 'invalid_response', 'Search results are unavailable. Try searching again.');
    return { tracks: data.tracks, notice: typeof data.notice === 'string' ? data.notice : null };
  },
  command: (id: string, csrfToken: string, command: Command, signal?: AbortSignal) => request<CommandResult>(`${guildPath(id)}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(command), signal,
  }, 95_000), // The API's bounded public-import deadline is 90 seconds.
  stats: async (id: string, window: StatsWindow = '30d', signal?: AbortSignal) => {
    const data = await request<Stats>(`${guildPath(id)}/stats?window=${window}`, { signal });
    const lists: unknown[] = [data.serverFavorites?.onRepeat, data.serverFavorites?.forgottenGems, data.personal?.topTracks, data.personal?.topArtists, data.personal?.rediscover];
    const playlists = data.personal?.playlists;
    if (!Array.isArray(playlists) || playlists.length > 6 || playlists.some(list => !Array.isArray(list?.tracks) || list.tracks.length > 25)) lists.push(undefined);
    if (lists.some(list => !Array.isArray(list) || list.length > 25)) throw new ApiError(503, 'invalid_response', 'Listening stats are unavailable. Try refreshing them.');
    return data;
  },
  recap: async (id: string, window: RecapWindow = '30d', signal?: AbortSignal) => {
    const data = await request<Recap>(`${guildPath(id)}/recap?window=${window}`, { signal });
    const totals = [data.personal, data.server];
    const lists: [unknown, number][] = [[data.personal?.topTracks, 10], [data.personal?.topArtists, 5], [data.server?.topTracks, 10]];
    if (totals.some(part => !part || ![part.plays, part.playedMs, part.songs].every(Number.isSafeInteger))
      || lists.some(([list, max]) => !Array.isArray(list) || list.length > max)) throw new ApiError(503, 'invalid_response', 'Your listening recap is unavailable. Try refreshing it.');
    return data;
  },
  clearRequestStats: (csrfToken: string) => request<{ ok: true; cleared: number }>('/api/stats/requests/clear', {
    method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
  }),
  diagnostics: (id: string, signal?: AbortSignal) => request<Diagnostics>(`${guildPath(id)}/diagnostics`, { signal }),
  activity: (id: string, signal?: AbortSignal) => request<Activity>(`${guildPath(id)}/activity`, { signal }),
  logout: (csrfToken: string) => request<{ ok: boolean }>('/auth/logout', {
    method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
  }),
  eventsUrl: (id: string) => `${guildPath(id)}/events`,
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something interrupted this request. Please try again.';
}
export function publicUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined; }
  catch { return undefined; }
}
