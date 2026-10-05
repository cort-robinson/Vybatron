// Explicit nonproduction loopback server for real EventSource and service-worker tests.
// This file and its independent actor are outside the production build.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Configuration, GuildSnapshot } from '../src/types';
import { fixtureState, selectedCommandError } from './fixtures';

export async function startHttpFixture(options: { initialSnapshotFailures?: number; initialBootstrapFailures?: number; pollMs?: number } = {}) {
  const state = fixtureState(); const commands: Command[] = []; const requests: string[] = [];
  const guildSnapshots = new Map([[state.snapshot.guild.id, state.snapshot]]);
  const configurations = new Map([[state.configuration.guildId, state.configuration]]);
  const configurationReads: { guildId: string; method: string | undefined }[] = []; const configurationAborts: string[] = [];
  const heldConfigurations = new Map<ServerResponse, { guildId: string; configuration: Configuration }>();
  const holdConfiguration = new Set<string>();
  let configurationFailures = 0; let configurationFailureStatus = 503; let configurationOverride: Configuration | undefined;
  const logouts: { method: string | undefined; body: string; contentType: string | undefined; csrfToken: string | string[] | undefined }[] = [];
  let signedOut = false;
  const streams = new Set<ServerResponse>(); const held = new Set<ServerResponse>(); let hold = false;
  const streamGuilds = new Map<ServerResponse, string>();
  const heldLibraries = new Set<ServerResponse>(); let holdLibrary = false;
  const capturedSnapshots = new Map<ServerResponse, GuildSnapshot>();
  const heldCommands = new Map<ServerResponse, GuildSnapshot>(); let holdCommands = false;
  let commandGate: Promise<void> | undefined; let releaseCommandGate: (() => void) | undefined;
  let snapshotFailures = options.initialSnapshotFailures || 0; let bootstrapFailures = options.initialBootstrapFailures || 0;
  let failureStatus = 503; let retryAfter = ''; let accessStatus = 0; let commandRevision = 0;
  const snapshotReads: number[] = []; const eventReads: number[] = [];
  const directory = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const json = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  const sendSnapshot = (response: ServerResponse, snapshot = state.snapshot) => response.write(`event:snapshot\ndata:${JSON.stringify(snapshot)}\n\n`);
  const server = createServer(async (request, response) => {
    const path = new URL(request.url || '/', 'http://127.0.0.1').pathname; requests.push(path);
    const guildId = decodeURIComponent(path.match(/^\/api\/guilds\/([^/]+)/)?.[1] || '');
    const guildSnapshot = guildSnapshots.get(guildId);
    if (signedOut && path.startsWith('/api/')) { json(response, { error: { code: 'unauthenticated', message: 'Sign in with Discord.' } }, 401); return; }
    if (path === '/api/bootstrap') {
      if (bootstrapFailures-- > 0) { json(response, { error: { code: 'unavailable', message: 'Discord verification is temporarily unavailable.' } }, 503); return; }
      json(response, state.bootstrap); return;
    }
    if (path === '/auth/logout') {
      let body = ''; for await (const chunk of request) body += chunk;
      const logout = { method: request.method, body, contentType: request.headers['content-type'], csrfToken: request.headers['x-csrf-token'] }; logouts.push(logout);
      if (logout.method !== 'POST' || body || logout.contentType || logout.csrfToken !== 'local-test-csrf') { json(response, { error: { code: 'invalid_logout', message: 'Logout requires a bodyless CSRF-protected POST.' } }, 400); return; }
      signedOut = true; for (const stream of streams) stream.end(); json(response, { ok: true }); return;
    }
    if (accessStatus && path.startsWith('/api/guilds/')) { json(response, { error: { code: 'forbidden', message: 'You no longer have access to this listening space.' } }, accessStatus); return; }
    if (path.endsWith('/configuration')) {
      configurationReads.push({ guildId, method: request.method });
      if (!guildSnapshot) { json(response, { error: { code: 'not_found', message: 'This listening space is unavailable.' } }, 404); return; }
      if (!guildSnapshot.guild.admin) { json(response, { error: { code: 'forbidden', message: 'Manage Server permission is required for channel and role options.' } }, 403); return; }
      if (configurationFailures-- > 0) { json(response, { error: { code: configurationFailureStatus === 503 ? 'unavailable' : 'forbidden', message: 'Channel and role options are temporarily unavailable.' } }, configurationFailureStatus); return; }
      const configuration = configurationOverride || configurations.get(guildId); configurationOverride = undefined;
      if (holdConfiguration.has(guildId) && configuration) {
        heldConfigurations.set(response, { guildId, configuration: structuredClone(configuration) });
        response.on('close', () => { if (!response.writableEnded) configurationAborts.push(guildId); heldConfigurations.delete(response); });
      } else json(response, configuration);
      return;
    }
    if (path.endsWith('/library')) { if (holdLibrary) { heldLibraries.add(response); response.on('close', () => heldLibraries.delete(response)); } else json(response, state.library); return; }
    if (path.endsWith('/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      eventReads.push(Date.now()); response.write('retry: 250\n: local test connection\n\n');
      if (!hold && guildSnapshot) sendSnapshot(response, guildSnapshot);
      const poll = options.pollMs ? setInterval(() => { const snapshot = guildSnapshots.get(guildId); if (!hold && snapshot) sendSnapshot(response, snapshot); }, options.pollMs) : undefined;
      streams.add(response); streamGuilds.set(response, guildId); response.on('close', () => { clearInterval(poll); streams.delete(response); streamGuilds.delete(response); }); return;
    }
    if (path.endsWith('/commands')) {
      if (request.headers['x-csrf-token'] !== 'local-test-csrf') { json(response, { error: { code: 'csrf', message: 'Missing CSRF token.' } }, 403); return; }
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 8192) { json(response, {}, 413); return; } }
      const command = JSON.parse(body) as Command; commands.push(command);
      if (commandGate) await commandGate;
      if (command.expectedRevision && command.expectedRevision !== state.snapshot.revision) { json(response, { error: { code: 'stale_revision', message: 'The session changed.' } }, 409); return; }
      const selectionError = selectedCommandError(state.library, command);
      if (selectionError) { json(response, { error: selectionError }, selectionError.status); return; }
      if (command.command === 'favorite' && command.subcommand === 'remove') state.library.favorites.splice(Number(command.options?.index) - 1, 1);
      if (command.command === 'pause') state.snapshot.session.status = 'paused';
      if (command.command === 'resume') state.snapshot.session.status = 'playing';
      if (command.command === 'stop') { state.snapshot.session.status = 'idle'; state.snapshot.session.current = null; state.snapshot.session.queue = []; }
      if (command.command === 'settings' && state.snapshot.settings) {
        const settings = state.snapshot.settings; const values = command.options || {};
        if (command.subcommand === 'volume') settings.volume = Number(values.value);
        if (command.subcommand === 'musicchannel') settings.musicTextChannelId = String(values.channel);
        if (command.subcommand === 'djrole') settings.djRoleId = values.role ? String(values.role) : null;
        if (command.subcommand === 'fairqueue') settings.fairQueue = !!values.enabled;
      }
      state.snapshot.revision = `http-command-revision-${++commandRevision}`;
      const snapshot = structuredClone(state.snapshot);
      if (holdCommands) { heldCommands.set(response, snapshot); response.on('close', () => heldCommands.delete(response)); }
      else json(response, { ok: true, message: 'Accepted by the loopback HTTP fixture.', snapshot }); return;
    }
    if (path.startsWith('/api/guilds/')) {
      snapshotReads.push(Date.now());
      if (snapshotFailures-- > 0) {
        if (retryAfter) response.setHeader('Retry-After', retryAfter);
        json(response, { error: { code: 'unavailable', message: 'The bot or audio service is unavailable. Refresh before making another change.' } }, failureStatus); return;
      }
      if (hold) { held.add(response); capturedSnapshots.set(response, structuredClone(state.snapshot)); response.on('close', () => { held.delete(response); capturedSnapshots.delete(response); }); }
      else json(response, guildSnapshot || state.snapshot); return;
    }
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
  return { origin, state, commands, requests, logouts, streams, snapshotReads, eventReads, heldCommands, capturedSnapshots, configurationReads, configurationAborts, heldConfigurations,
    addGuild: (snapshot: GuildSnapshot, configuration: Configuration) => { guildSnapshots.set(snapshot.guild.id, snapshot); configurations.set(configuration.guildId, configuration); state.bootstrap.guilds.push(snapshot.guild); },
    broadcast: (snapshot = state.snapshot) => { for (const response of streams) if (streamGuilds.get(response) === snapshot.guild.id) sendSnapshot(response, snapshot); },
    holdConfigurationReads: (guildId = state.snapshot.guild.id) => { holdConfiguration.add(guildId); },
    releaseConfigurationReads: (guildId = state.snapshot.guild.id) => { holdConfiguration.delete(guildId); for (const [response, captured] of heldConfigurations) if (captured.guildId === guildId) { json(response, captured.configuration); heldConfigurations.delete(response); } },
    failNextConfigurationReads: (count: number, status = 503) => { configurationFailures = count; configurationFailureStatus = status; },
    replaceNextConfiguration: (configuration: Configuration) => { configurationOverride = configuration; },
    applicationError: (status: number) => { for (const response of streams) response.write(`event:error\ndata:${JSON.stringify({ error: { status, code: status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'unavailable', message: status === 503 ? 'The bot or audio service is unavailable. Refresh before making another change.' : 'You no longer have access to this listening space.' } })}\n\n`); },
    disconnect: () => { for (const response of streams) response.end(); },
    disconnectAndHold: () => { hold = true; for (const response of streams) response.end(); },
    releaseFreshSnapshot: () => { hold = false; state.snapshot.revision = 'http-fresh-revision'; state.snapshot.session.queue[0].title = 'Fresh Night Drive'; for (const response of held) json(response, state.snapshot); held.clear(); },
    holdSnapshotReads: () => { hold = true; },
    releaseSnapshotReads: (captured = false) => { hold = false; for (const response of held) json(response, captured ? capturedSnapshots.get(response) : state.snapshot); held.clear(); capturedSnapshots.clear(); },
    failNextSnapshotReads: (count: number, status = 503, retryAfterHeader = '') => { snapshotFailures = count; failureStatus = status; retryAfter = retryAfterHeader; },
    denyAccess: (status: number) => { accessStatus = status; for (const response of streams) response.end(); },
    holdCommandExecution: () => { commandGate = new Promise(resolve => { releaseCommandGate = resolve; }); },
    releaseCommandExecution: () => { commandGate = undefined; releaseCommandGate?.(); },
    holdCommandReplies: () => { holdCommands = true; },
    releaseCommandReplies: () => { holdCommands = false; for (const [response, snapshot] of heldCommands) json(response, { ok: true, message: 'Accepted by the loopback HTTP fixture.', snapshot }); heldCommands.clear(); },
    holdLibraryReads: () => { holdLibrary = true; },
    releaseLibraryReads: () => { holdLibrary = false; for (const response of heldLibraries) json(response, state.library); heldLibraries.clear(); },
    close: async () => { releaseCommandGate?.(); for (const response of streams) response.end(); for (const response of held) response.end(); for (const response of heldLibraries) response.end(); for (const response of heldCommands.keys()) response.end(); for (const response of heldConfigurations.keys()) response.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
