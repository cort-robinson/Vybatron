import type { Bootstrap, GuildSnapshot, Library, Track, Command, CommandResult, Diagnostics, Activity } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = 'ApiError'; }
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
    throw new ApiError(response.status, body?.error?.code || 'request_failed',
      typeof body?.error?.message === 'string' ? body.error.message : 'This request could not be completed. Refresh and try again.');
  }
  if (!body || typeof body !== 'object') throw new ApiError(503, 'invalid_response', 'Live state is unavailable. Refresh and try again.');
  return body as T;
}

const guildPath = (id: string) => `/api/guilds/${encodeURIComponent(id)}`;
export const api = {
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>('/api/bootstrap', { signal }),
  snapshot: (id: string, signal?: AbortSignal) => request<GuildSnapshot>(guildPath(id), { signal }),
  library: (id: string, signal?: AbortSignal) => request<Library>(`${guildPath(id)}/library`, { signal }),
  search: (id: string, query: string, signal?: AbortSignal) => request<{ tracks: Track[]; notice: string | null }>(`${guildPath(id)}/search?query=${encodeURIComponent(query)}`, { signal }),
  command: (id: string, csrfToken: string, command: Command, signal?: AbortSignal) => request<CommandResult>(`${guildPath(id)}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(command), signal,
  }, 95_000), // The API's bounded public-import deadline is 90 seconds.
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
