import { createServer } from 'node:http';
import { maintenanceStatus, setMaintenance } from './utils/maintenance.js';
import { playbackHealth } from './utils/playback-health.js';

export function getHealth(client) {
  const discordReady = client.isReady?.() === true;
  const audioReady = [...(client.lavalink?.nodeManager?.nodes?.values() || [])]
    .some((node) => node.connected);
  const draining = client.runtimeState?.draining === true;
  return { ready: discordReady && audioReady && !draining, discordReady, audioReady, draining };
}

export function getLiveness(client) {
  return { alive: client.runtimeState?.draining !== true };
}

// Aggregate diagnostics contain no guild/user IDs, track titles, URLs, or secrets.
export function getStatus(client) {
  const players = [...(client.lavalink?.players?.values() || [])];
  return {
    ...getHealth(client),
    uptimeSeconds: Math.floor(process.uptime()),
    players: players.length,
    playing: players.filter((player) => player.playing && !player.paused).length,
    paused: players.filter((player) => player.paused).length,
    queuedTracks: players.reduce((count, player) => count + (player.queue?.tracks?.length || 0), 0),
    recentPlaybackFailures: playbackHealth(client).failures.length,
    recovery: client.lavalink?.playbackRecovery?.summary?.() || null,
  };
}

function json(response, status, payload, method) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(method === 'HEAD' ? undefined : JSON.stringify(payload));
}

// Loopback only: health checks expose no guild, user, token, or player data.
export function startHealthServer(client, { port = 3000 } = {}) {
  const server = createServer((request, response) => {
    const reads = ['/health', '/ready', '/live', '/status', '/playback', '/maintenance'];
    const writes = ['/maintenance/begin', '/maintenance/end'];
    const reading = reads.includes(request.url);
    const writing = writes.includes(request.url);
    if (!reading && !writing) return response.writeHead(404).end();
    if ((reading && !['GET', 'HEAD'].includes(request.method)) || (writing && request.method !== 'POST')) {
      return response.writeHead(405, { Allow: reading ? 'GET, HEAD' : 'POST' }).end();
    }
    try {
      let status = 200;
      let payload;
      if (['/health', '/ready'].includes(request.url)) {
        payload = getHealth(client);
        status = payload.ready ? 200 : 503;
      } else if (request.url === '/live') {
        payload = getLiveness(client);
        status = payload.alive ? 200 : 503;
      } else if (request.url === '/status') payload = getStatus(client);
      else if (request.url === '/playback') payload = playbackHealth(client);
      else if (reading) payload = maintenanceStatus(client);
      else if (request.url === '/maintenance/end' && client.runtimeState?.draining) {
        // A monitor completing an old transaction cannot undo shutdown's gate.
        status = 409;
        payload = { error: 'draining' };
      } else payload = setMaintenance(client, request.url.endsWith('/begin'));
      json(response, status, payload, request.method);
    } catch {
      json(response, 503, { error: 'health_unavailable' }, request.method);
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  server.listen(port, '127.0.0.1');
  server.unref();
  return server;
}
