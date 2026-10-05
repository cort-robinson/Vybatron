import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Bootstrap, Capability, Command, Connection, GuildSnapshot, Library } from './types';

export interface Notice { id: number; kind: 'success' | 'error' | 'info'; message: string }
const conflicting = new Set(['playnext', 'pause', 'resume', 'seek', 'skip', 'skipto', 'clear', 'remove', 'move', 'shuffle', 'loop', 'filter', 'volume', 'session', 'radio', 'replay']);
const freshnessMs = 25_000;
const retryDelay = (attempt: number, error?: unknown) => Math.max(Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000), error instanceof ApiError ? error.retryAfterMs : 0);

export function usePortal() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [auth, setAuth] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [guildId, setGuildId] = useState('');
  const [snapshot, setSnapshot] = useState<GuildSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [connection, setConnection] = useState<Connection>('connecting');
  const [connectionError, setConnectionError] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fresh = useRef(false);
  const verifiedAt = useRef(0);
  const lossVersion = useRef(0);
  const activeGuild = useRef('');
  const current = useRef<GuildSnapshot | null>(null);
  const generation = useRef(0);
  const stateVersion = useRef(0);
  const pendingRef = useRef(new Set<string>());
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const libraryRefreshRef = useRef<() => Promise<void>>(async () => {});
  const reconnectRef = useRef<() => void>(() => {});
  const completeCommandRef = useRef<(next: GuildSnapshot, version: number, loss: number) => Promise<void>>(async () => {});
  const bootstrapSequence = useRef(0);
  const bootstrapAttempt = useRef(0);
  const bootstrapRetryMs = useRef(0);

  const notify = useCallback((message: string, kind: Notice['kind'] = 'info') => setNotice({ id: Date.now(), kind, message }), []);
  const expireAuth = useCallback(() => {
    bootstrapSequence.current++;
    generation.current++; lossVersion.current++;
    fresh.current = false;
    current.current = null;
    activeGuild.current = '';
    setSnapshot(null); setLibrary(null); setBootstrap(null); setAuth('signed-out');
    setGuildId(''); setNotice(null);
  }, []);

  const loadBootstrap = useCallback(async () => {
    const seq = ++bootstrapSequence.current;
    setAuth('loading'); setAuthError('');
    try {
      const next = await api.bootstrap();
      if (seq !== bootstrapSequence.current) return;
      bootstrapAttempt.current = 0; bootstrapRetryMs.current = 0;
      setBootstrap(next); setAuth('ready');
      let previous = '';
      try { previous = localStorage.getItem('vybertron.guild') || ''; } catch { /* Storage is optional. */ }
      setGuildId(next.guilds.find(g => g.id === previous)?.id || next.guilds[0]?.id || '');
    } catch (error) {
      if (seq !== bootstrapSequence.current) return;
      if (error instanceof ApiError && error.status === 401) expireAuth();
      else {
        bootstrapRetryMs.current = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500) ? retryDelay(bootstrapAttempt.current++, error) : 0;
        setAuth('error'); setAuthError(errorMessage(error));
      }
    }
  }, [expireAuth]);
  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    if (auth !== 'error' || !bootstrapRetryMs.current) return;
    const timer = setTimeout(() => { if (navigator.onLine) void loadBootstrap(); }, bootstrapRetryMs.current);
    const online = () => void loadBootstrap();
    window.addEventListener('online', online);
    return () => { clearTimeout(timer); window.removeEventListener('online', online); };
  }, [auth, loadBootstrap]);

  useEffect(() => {
    const epoch = ++generation.current;
    activeGuild.current = guildId; fresh.current = false; current.current = null; lossVersion.current++;
    setSnapshot(null); setLibrary(null); setLibraryError(''); setConnectionError('');
    setConnection('connecting'); pendingRef.current.clear(); setPending([]);
    if (!guildId || auth !== 'ready') return;
    try { localStorage.setItem('vybertron.guild', guildId); } catch { /* Preference only. */ }
    const abort = new AbortController();
    let stream: EventSource | undefined;
    let refreshing: Promise<void> | undefined;
    let refreshController: AbortController | undefined;
    let libraryController: AbortController | undefined;
    let readEpoch = 0;
    let streamEpoch = 0;
    let accessLost = false;
    let offline = !navigator.onLine;
    let libraryReady = false;
    let recoveryAttempt = 0;
    let retryNotBefore = 0;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let policyTimer: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !abort.signal.aborted && !accessLost && epoch === generation.current && activeGuild.current === guildId;
    const closeStream = () => { streamEpoch++; stream?.close(); stream = undefined; };
    const invalidateRead = () => { readEpoch++; refreshController?.abort(); refreshing = undefined; };
    const clearRecovery = () => { clearTimeout(recoveryTimer); recoveryTimer = undefined; };
    const pauseConnection = (message: string) => {
      closeStream(); invalidateRead(); lossVersion.current++;
      fresh.current = false; setConnection('offline'); setConnectionError(message);
    };
    const scheduleRecovery = (error?: unknown) => {
      if (!valid() || offline || recoveryTimer) return;
      const delay = retryDelay(recoveryAttempt++, error);
      if (error instanceof ApiError) retryNotBefore = Date.now() + error.retryAfterMs;
      recoveryTimer = setTimeout(() => { recoveryTimer = undefined; void refresh(); }, Math.max(delay, retryNotBefore - Date.now()));
    };
    const accept = (next: GuildSnapshot) => {
      if (!valid() || offline) return;
      if (next?.guild?.id !== guildId || typeof next.revision !== 'string' || !Array.isArray(next.session?.queue)) throw new ApiError(503, 'invalid_response', 'Live state is unavailable. Refresh and try again.');
      const before = current.current;
      stateVersion.current++; current.current = next;
      verifiedAt.current = Date.now();
      setSnapshot(next); setReceivedAt(Date.now()); setConnectionError('');
      fresh.current = true; setConnection('live');
      clearRecovery();
      clearTimeout(policyTimer); policyTimer = setTimeout(policyCheck, freshnessMs);
      if (before && (before.session.current?.id !== next.session.current?.id || before.session.voiceChannel?.id !== next.session.voiceChannel?.id || before.guild.admin && !next.guild.admin)) {
        // An authorized empty/channel-changed projection must also retire older
        // protected library reads and history before asking for its new library.
        libraryController?.abort(); libraryReady = false; setLibrary(null);
        void refreshLibrary();
      }
    };
    const failure = (error: unknown) => {
      if (!valid()) return;
      pauseConnection(errorMessage(error));
      if (error instanceof ApiError && error.status === 401) { accessLost = true; clearRecovery(); libraryController?.abort(); expireAuth(); return; }
      // Protected data is cleared after access loss; connection failures retain read-only context.
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        accessLost = true; clearRecovery(); libraryController?.abort(); libraryReady = false;
        current.current = null; setSnapshot(null); setLibrary(null);
      } else scheduleRecovery(error);
    };
    const refresh = (): Promise<void> => {
      if (!valid() || offline) return Promise.resolve();
      if (Date.now() < retryNotBefore) { scheduleRecovery(); return Promise.resolve(); }
      if (refreshing) return refreshing;
      clearRecovery(); closeStream(); invalidateRead();
      const requestController = new AbortController(); refreshController = requestController;
      const signal = AbortSignal.any([abort.signal, requestController.signal]);
      const startedEpoch = readEpoch;
      fresh.current = false; setConnection('refreshing');
      const request = api.snapshot(guildId, signal).then(next => {
        if (!valid() || requestController.signal.aborted || startedEpoch !== readEpoch) return;
        // No pre-read stream remains open: its opaque revision cannot tell us
        // whether a late frame was produced before or after this GET.
        accept(next); openStream();
        if (!libraryReady && !libraryController) void refreshLibrary();
      }).catch(error => { if (!requestController.signal.aborted && startedEpoch === readEpoch) failure(error); }).finally(() => { if (refreshing === request) refreshing = undefined; });
      refreshing = request;
      return refreshing;
    };
    const refreshLibrary = async () => {
      if (!valid() || offline || Date.now() < retryNotBefore) return;
      libraryController?.abort();
      const requestController = new AbortController(); libraryController = requestController;
      const signal = AbortSignal.any([abort.signal, requestController.signal]);
      try { const next = await api.library(guildId, signal); if (valid() && !requestController.signal.aborted) { libraryReady = true; setLibrary(next); setLibraryError(''); } }
      catch (error) {
        if (!valid() || requestController.signal.aborted) return;
        libraryReady = false;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) failure(error);
        else setLibraryError(errorMessage(error));
      } finally { if (libraryController === requestController) libraryController = undefined; }
    };
    // A conflict or uncertain command needs a new read, not one already in flight.
    refreshRef.current = () => { closeStream(); invalidateRead(); return refresh(); }; libraryRefreshRef.current = refreshLibrary;
    const openStream = () => {
      if (!valid() || offline || stream) return;
      const openedEpoch = ++streamEpoch;
      const source = new EventSource(api.eventsUrl(guildId), { withCredentials: true }); stream = source;
      const liveSource = () => valid() && !offline && stream === source && openedEpoch === streamEpoch;
      // The stream supplies its own freshly authorized initial snapshot. Opening
      // it is not proof of freshness and does not need a duplicate protected GET.
      source.addEventListener('snapshot', event => {
        if (!liveSource()) return;
        try { accept(JSON.parse((event as MessageEvent).data)); recoveryAttempt = 0; retryNotBefore = 0; }
        catch (error) { failure(error); }
      });
      source.onerror = event => {
        if (!liveSource()) return;
        if (event instanceof MessageEvent) {
          // The API can keep an open stream through a transient policy failure.
          // Its error frame is not a native network disconnect: respect the
          // server's bounded retry rather than adding reconnect/probe pressure.
          try {
            const data = JSON.parse(event.data)?.error;
            const status = data?.status ?? ({ unauthenticated: 401, forbidden: 403, not_found: 404, busy: 429, unavailable: 503 } as Record<string, number>)[data?.code];
            if (typeof data?.code === 'string' && typeof data?.message === 'string' && data.message.length <= 2000) {
              if ([401, 403, 404].includes(status)) { failure(new ApiError(status, data.code, data.message)); return; }
              if ([429, 503].includes(status) && source.readyState === EventSource.OPEN) {
                invalidateRead(); lossVersion.current++;
                fresh.current = false; setConnection('offline'); setConnectionError(data.message);
                return; // Heartbeats/open alone never restore freshness; only a new snapshot can.
              }
            }
          } catch { /* Malformed frames require an independent policy read. */ }
        }
        pauseConnection('Live updates disconnected. Controls will return after fresh state arrives.');
        // EventSource hides HTTP status. One backoff-controlled policy GET both
        // detects revocation and supplies the state needed to recover controls.
        scheduleRecovery();
      };
    };
    completeCommandRef.current = async (next, version, loss) => {
      if (!valid()) return;
      const unambiguous = fresh.current && Date.now() - verifiedAt.current < freshnessMs && version === stateVersion.current && loss === lossVersion.current;
      closeStream(); invalidateRead();
      // A pre-mutation SSE frame must not hide a pause result. Conversely, a
      // delayed command reply must not replace a later Discord/Stop update.
      // Revisions are hashes, so overlap requires a read begun after the reply.
      if (unambiguous && !offline) {
        try { accept(next); openStream(); } catch (error) { failure(error); }
      } else await refresh();
    };
    reconnectRef.current = () => {
      if (abort.signal.aborted || epoch !== generation.current) return;
      if (Date.now() < retryNotBefore) return;
      accessLost = false; offline = !navigator.onLine;
      pauseConnection('Reconnecting for fresh state. Discord playback continues.'); clearRecovery();
      void refresh(); void refreshLibrary();
    };
    void refresh();
    void refreshLibrary();
    const policyCheck = () => {
      if (!valid()) return;
      if (fresh.current && Date.now() - verifiedAt.current >= freshnessMs) {
        pauseConnection('Live state stopped arriving. Reconnecting for fresh state.');
        if (!document.hidden) void refresh();
      } else if (!fresh.current && !document.hidden && !refreshing) scheduleRecovery();
      policyTimer = setTimeout(policyCheck, freshnessMs);
    };
    policyTimer = setTimeout(policyCheck, freshnessMs);
    const visibility = () => { if (!document.hidden && valid()) { void refresh(); void refreshLibrary(); } };
    const wentOffline = () => { if (valid()) { offline = true; clearRecovery(); libraryController?.abort(); pauseConnection('You are offline. Discord playback continues; reconnect to control it.'); } };
    const online = () => { if (valid()) { offline = false; void refresh(); void refreshLibrary(); } };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', wentOffline); window.addEventListener('online', online);
    return () => {
      abort.abort(); refreshController?.abort(); libraryController?.abort(); closeStream(); clearRecovery(); clearTimeout(policyTimer); fresh.current = false;
      refreshRef.current = async () => {}; libraryRefreshRef.current = async () => {};
      reconnectRef.current = () => {}; completeCommandRef.current = async () => {};
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', wentOffline); window.removeEventListener('online', online);
    };
  }, [guildId, auth, expireAuth]);

  const can = useCallback((capability: Capability) => {
    if (!fresh.current || Date.now() - verifiedAt.current >= freshnessMs || !current.current || !bootstrap) return false;
    const s = current.current;
    switch (capability) {
      case 'add': return s.session.canAdd;
      case 'control': return s.session.canControl;
      case 'vote': return s.session.canVote;
      case 'library': return true;
      case 'admin': return s.guild.admin;
      case 'resume': return s.savedSession.canResume;
    }
  }, [bootstrap, snapshot, connection]);
  const blockedReason = connection !== 'live' ? 'Reconnect for fresh state before making changes.'
    : snapshot?.session.reason || 'Join the music voice channel. Playback controls may require the DJ role.';

  const run = useCallback(async (body: Command, capability: Capability): Promise<boolean> => {
    // Check refs at click time, not a render-time closure, so offline clicks cannot escape.
    if (!can(capability) || !bootstrap || !current.current) { notify(blockedReason, 'error'); return false; }
    const id = activeGuild.current; const epoch = generation.current;
    const key = `${body.command}:${body.subcommand || ''}`;
    if (pendingRef.current.has(key) || (pendingRef.current.size && body.command !== 'stop')) return false;
    const command = { ...body };
    if (conflicting.has(body.command) || (body.command === 'mix' && body.subcommand === 'save') || (body.command === 'favorite' && body.subcommand === 'add')) {
      command.expectedRevision = body.expectedRevision ?? current.current.revision;
    }
    pendingRef.current.add(key); setPending([...pendingRef.current]);
    const startedVersion = stateVersion.current;
    const startedLoss = lossVersion.current;
    try {
      const result = await api.command(id, bootstrap.csrfToken, command);
      if (epoch !== generation.current || activeGuild.current !== id) return false;
      await completeCommandRef.current(result.snapshot, startedVersion, startedLoss);
      if (epoch !== generation.current || activeGuild.current !== id) return false;
      if (!fresh.current || !current.current) {
        notify('The action completed. Reconnect for fresh state before making another change.', 'info');
        return false; // Keep the form draft while the confirmed result cannot be reconciled.
      }
      notify(result.message || 'Done.', 'success');
      if (['favorite', 'mix', 'replay', 'session', 'settings'].includes(body.command)) void libraryRefreshRef.current();
      return true;
    } catch (error) {
      if (epoch !== generation.current) return false;
      if (error instanceof ApiError && error.status === 401) expireAuth();
      else if (error instanceof ApiError && error.status === 409) {
        await Promise.all([refreshRef.current(), libraryRefreshRef.current()]);
        notify('The session or library changed. Review the refreshed state, then try your action again.', 'error');
      } else {
        const uncertain = error instanceof ApiError && [0, 503].includes(error.status);
        notify(`${errorMessage(error)}${uncertain ? ' Check the refreshed state before trying again; this action may have completed.' : ''}`, 'error');
        if (error instanceof ApiError && [403, 404].includes(error.status)) { await refreshRef.current(); void libraryRefreshRef.current(); }
        if (uncertain) {
          fresh.current = false; setConnection('offline'); setConnectionError(errorMessage(error));
          await refreshRef.current(); void libraryRefreshRef.current();
        }
      }
      return false;
    } finally {
      if (epoch === generation.current) { pendingRef.current.delete(key); setPending([...pendingRef.current]); }
    }
  }, [bootstrap, can, notify, blockedReason, expireAuth]);

  const logout = async () => {
    if (!bootstrap) return;
    try { await api.logout(bootstrap.csrfToken); expireAuth(); }
    catch (error) { notify(errorMessage(error), 'error'); }
  };
  const selectGuild = (id: string) => { if (id === activeGuild.current) return; fresh.current = false; activeGuild.current = id; setGuildId(id); };
  return { bootstrap, auth, authError, loadBootstrap, guildId, selectGuild, snapshot, receivedAt, library, libraryError,
    refreshLibrary: () => libraryRefreshRef.current(), connection, connectionError,
    reconnect: () => reconnectRef.current(), pending, can, blockedReason, run, notice, notify,
    dismissNotice: () => setNotice(null), logout };
}
export type Portal = ReturnType<typeof usePortal>;
