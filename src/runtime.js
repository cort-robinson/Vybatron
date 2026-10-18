import { maintenanceStatus, setMaintenance } from './utils/maintenance.js';
import { cancelSleepTimer } from './utils/sleep-timer.js';

// Never serialize arbitrary errors: upstream errors can carry tokens or signed
// media URLs. Known error codes are enough to identify an operational failure.
export function publicError(error) {
  const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
  const result = { type: names.has(error?.name) ? error.name : 'Error' };
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EADDRINUSE',
    'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'ERR_INVALID_ARG_TYPE', 'ERR_SOCKET_CLOSED']);
  if (codes.has(error?.code)) result.code = error.code;
  return result;
}

export function logEvent(logger, level, event, error) {
  logger[level](JSON.stringify({ event, ...(error ? { error: publicError(error) } : {}) }));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

export function installRuntime(client, {
  server,
  timeoutMs = 10_000,
  logger = console,
  processObject = process,
  exit = (code) => processObject.exit(code),
  stopPresence = () => {},
} = {}) {
  client.runtimeState = { startedAt: Date.now(), draining: false };
  let shutdownTask;
  let failed = false;
  const handlers = new Map();
  const dispose = () => {
    for (const [name, handler] of handlers) processObject.removeListener(name, handler);
    server?.removeListener('error', onHealthError);
  };

  const shutdown = (reason = 'shutdown', code = 0) => {
    if (code !== 0) failed = true;
    if (shutdownTask) return shutdownTask;
    client.runtimeState.draining = true;
    setMaintenance(client, true);
    // A restart keeps the session checkpoint; a sleep timer must not end the
    // session while shutdown drains. Timers live in memory and end here anyway.
    for (const player of client.lavalink?.players?.values() || []) cancelSleepTimer(player);
    logEvent(logger, 'info', reason);
    shutdownTask = (async () => {
      let deadline;
      const expired = new Promise((resolve) => {
        deadline = setTimeout(() => {
          failed = true;
          logEvent(logger, 'error', 'shutdown_timeout');
          resolve();
        }, timeoutMs);
      });
      const cleanup = async () => {
        try {
          client.lavalink?.playbackWatchdog?.stop?.();
          for (const player of client.lavalink?.players?.values() || []) {
            client.lavalink?.playbackRecovery?.invalidate?.(player);
          }
        } catch (error) {
          failed = true;
          logEvent(logger, 'error', 'audio_recovery_close_failed', error);
        }
        const drainUntil = Date.now() + Math.min(2000, Math.floor(timeoutMs / 3));
        while (maintenanceStatus(client).inFlight && Date.now() < drainUntil) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const tasks = [
          ['portal_close_failed', () => client.portalBridge?.close?.()],
          ['library_close_failed', () => client.library?.close?.()],
          ['presence_close_failed', stopPresence],
          ['voice_close_failed', async () => {
            // Flush checkpoints first, then leave voice and remove remote
            // players. A fresh process deliberately requires /session resume;
            // leaving resumable remote players alive would orphan the audio.
            const results = await Promise.allSettled([...(client.lavalink?.players?.values() || [])]
              .map(player => player.destroy?.('shutdown-disconnect')));
            if (results.some(result => result.status === 'rejected')) throw new Error('Voice shutdown failed');
          }],
          // Players are gone; record their open plays before the store closes.
          ['stats_close_failed', () => { client.playTracker?.closeAll?.(); client.stats?.close?.(); }],
          ['audio_close_failed', () => {
            if ([...(client.lavalink?.nodeManager?.nodes?.values() || [])].some((node) => node.connected)) {
              return client.lavalink.nodeManager.disconnectAll(false, false);
            }
          }],
          ['discord_close_failed', () => client.destroy?.()],
          ['health_close_failed', () => closeServer(server)],
        ];
        for (const [event, run] of tasks) {
          try { await run(); }
          catch (error) {
            failed = true;
            logEvent(logger, 'error', event, error);
          }
        }
      };
      await Promise.race([cleanup(), expired]);
      clearTimeout(deadline);
      dispose();
      exit(failed ? 1 : 0);
    })();
    return shutdownTask;
  };

  const fatal = (error, event = 'runtime_failure') => {
    logEvent(logger, 'error', event, error);
    return shutdown('fatal_shutdown', 1);
  };
  const onHealthError = (error) => { void fatal(error, 'health_server_failed'); };
  handlers.set('SIGTERM', () => { void shutdown('sigterm'); });
  handlers.set('SIGINT', () => { void shutdown('sigint'); });
  handlers.set('unhandledRejection', (error) => { void fatal(error, 'unhandled_rejection'); });
  handlers.set('uncaughtException', (error) => { void fatal(error, 'uncaught_exception'); });
  for (const [name, handler] of handlers) processObject.on(name, handler);
  server?.on('error', onHealthError);
  return { shutdown, fatal, dispose };
}
