// Explicit nonproduction loopback server for real EventSource and service-worker tests.
// This file and its independent actor are outside the production build.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '../src/types';
import { fixtureState, selectedCommandError } from './fixtures';

export async function startHttpFixture() {
  const state = fixtureState(); const commands: Command[] = []; const requests: string[] = [];
  const logouts: { method: string | undefined; body: string; contentType: string | undefined; csrfToken: string | string[] | undefined }[] = [];
  let signedOut = false;
  const streams = new Set<ServerResponse>(); const held = new Set<ServerResponse>(); let hold = false;
  const heldLibraries = new Set<ServerResponse>(); let holdLibrary = false;
  const directory = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const json = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://127.0.0.1').pathname; requests.push(path);
    if (signedOut && path.startsWith('/api/')) { json(response, { error: { code: 'unauthenticated', message: 'Sign in with Discord.' } }, 401); return; }
    if (path === '/api/bootstrap') { json(response, state.bootstrap); return; }
    if (path === '/auth/logout') {
      let body = ''; for await (const chunk of request) body += chunk;
      const logout = { method: request.method, body, contentType: request.headers['content-type'], csrfToken: request.headers['x-csrf-token'] }; logouts.push(logout);
      if (logout.method !== 'POST' || body || logout.contentType || logout.csrfToken !== 'local-test-csrf') { json(response, { error: { code: 'invalid_logout', message: 'Logout requires a bodyless CSRF-protected POST.' } }, 400); return; }
      signedOut = true; for (const stream of streams) stream.end(); json(response, { ok: true }); return;
    }
    if (path.endsWith('/library')) { if (holdLibrary) { heldLibraries.add(response); response.on('close', () => heldLibraries.delete(response)); } else json(response, state.library); return; }
    if (path.endsWith('/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write('retry: 250\n: local test connection\n\n'); streams.add(response); response.on('close', () => streams.delete(response)); return;
    }
    if (path.endsWith('/commands')) {
      if (request.headers['x-csrf-token'] !== 'local-test-csrf') { json(response, { error: { code: 'csrf', message: 'Missing CSRF token.' } }, 403); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) { json(response, {}, 413); return; } }
      const command = JSON.parse(body) as Command; commands.push(command);
      const selectionError = selectedCommandError(state.library, command);
      if (selectionError) { json(response, { error: selectionError }, selectionError.status); return; }
      if (command.command === 'favorite' && command.subcommand === 'remove') state.library.favorites.splice(Number(command.options?.index) - 1, 1);
      state.snapshot.revision = 'http-command-revision'; json(response, { ok: true, message: 'Accepted by the loopback HTTP fixture.', snapshot: state.snapshot }); return;
    }
    if (path.startsWith('/api/guilds/')) { if (hold) { held.add(response); response.on('close', () => held.delete(response)); } else json(response, state.snapshot); return; }
    const art = path.startsWith('/test-art/');
    const root = art ? resolve(fileURLToPath(new URL('./art/', import.meta.url))) : directory;
    const file = resolve(root, `.${art ? path.replace('/test-art', '') : path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + sep)) { response.writeHead(404); response.end(); return; }
    try {
      const data = await readFile(file); const type: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
      response.writeHead(200, { 'Content-Type': type[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local fixture port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const rewrite = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'artworkUrl' || key === 'avatarUrl') && typeof item === 'string') (value as Record<string, unknown>)[key] = origin + new URL(item).pathname;
      else rewrite(item);
    }
  };
  rewrite(state);
  return { origin, state, commands, requests, logouts, streams,
    disconnectAndHold: () => { hold = true; for (const response of streams) response.end(); },
    releaseFreshSnapshot: () => { hold = false; state.snapshot.revision = 'http-fresh-revision'; state.snapshot.session.queue[0].title = 'Fresh Night Drive'; for (const response of held) json(response, state.snapshot); held.clear(); },
    holdLibraryReads: () => { holdLibrary = true; },
    releaseLibraryReads: () => { holdLibrary = false; for (const response of heldLibraries) json(response, state.library); heldLibraries.clear(); },
    close: async () => { for (const response of streams) response.end(); for (const response of held) response.end(); for (const response of heldLibraries) response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
