import { createServer } from 'node:http';
import { maintenanceStatus, setMaintenance } from './utils/maintenance.js';
import { playbackHealth } from './utils/playback-health.js';

export function getHealth(client) {
  const discordReady = client.isReady();
  const audioReady = [...(client.lavalink?.nodeManager?.nodes?.values() || [])]
    .some((node) => node.connected);
  return { ready: discordReady && audioReady, discordReady, audioReady };
}

// Loopback only: health checks expose no guild, user, token, or player data.
export function startHealthServer(client, { port = 3000 } = {}) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/playback') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(playbackHealth(client)));
      return;
    }
    if (request.method === 'POST' && ['/maintenance/begin', '/maintenance/end'].includes(request.url)) {
      const status = setMaintenance(client, request.url.endsWith('/begin'));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(status));
      return;
    }
    if (request.method === 'GET' && request.url === '/maintenance') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(maintenanceStatus(client)));
      return;
    }
    if (request.url !== '/health') {
      response.writeHead(404).end();
      return;
    }
    const health = getHealth(client);
    response.writeHead(health.ready ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(health));
  });
  server.listen(port, '127.0.0.1');
  server.unref();
  return server;
}
