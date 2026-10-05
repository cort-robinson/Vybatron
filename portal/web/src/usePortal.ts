import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Bootstrap, Capability, Command, Connection, GuildSnapshot, Library } from './types';

export interface Notice { id: number; kind: 'success' | 'error' | 'info'; message: string }
const conflicting = new Set(['playnext', 'pause', 'resume', 'seek', 'skip', 'skipto', 'clear', 'remove', 'move', 'shuffle', 'loop', 'filter', 'volume', 'session', 'radio', 'replay']);

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
  const [reconnectKey, setReconnectKey] = useState(0);
  const fresh = useRef(false);
  const activeGuild = useRef('');
  const current = useRef<GuildSnapshot | null>(null);
  const generation = useRef(0);
  const stateVersion = useRef(0);
  const pendingRef = useRef(new Set<string>());
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const libraryRefreshRef = useRef<() => Promise<void>>(async () => {});
  const bootstrapSequence = useRef(0);

  const notify = useCallback((message: string, kind: Notice['kind'] = 'info') => setNotice({ id: Date.now(), kind, message }), []);
  const expireAuth = useCallback(() => {
    bootstrapSequence.current++;
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
      setBootstrap(next); setAuth('ready');
      let previous = '';
      try { previous = localStorage.getItem('vybertron.guild') || ''; } catch { /* Storage is optional. */ }
      setGuildId(next.guilds.find(g => g.id === previous)?.id || next.guilds[0]?.id || '');
    } catch (error) {
      if (seq !== bootstrapSequence.current) return;
      if (error instanceof ApiError && error.status === 401) expireAuth();
      else { setAuth('error'); setAuthError(errorMessage(error)); }
    }
  }, [expireAuth]);
  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);

  useEffect(() => {
    const epoch = ++generation.current;
    activeGuild.current = guildId; fresh.current = false; current.current = null;
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
    let refreshEpoch = -1;
    let accessLost = false;
    let lastLossCheck = 0;
    let policyTimer: ReturnType<typeof setTimeout>;
    const valid = () => !abort.signal.aborted && !accessLost && epoch === generation.current;
    const accept = (next: GuildSnapshot) => {
      if (!valid() || next.guild.id !== guildId || !Array.isArray(next.session.queue)) return;
      const before = current.current;
      stateVersion.current++; current.current = next;
      setSnapshot(next); setReceivedAt(Date.now()); setConnectionError('');
      fresh.current = true; setConnection('live');
      if (before && (before.session.current?.id !== next.session.current?.id || before.session.voiceChannel?.id !== next.session.voiceChannel?.id)) void libraryRefreshRef.current();
    };
    const failure = (error: unknown) => {
      if (!valid()) return;
      if (error instanceof ApiError && error.status === 401) { expireAuth(); return; }
      fresh.current = false; setConnection('offline'); setConnectionError(errorMessage(error));
      // Protected data is cleared after access loss; connection failures retain read-only context.
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        accessLost = true; current.current = null; setSnapshot(null); setLibrary(null); stream?.close();
      }
    };
    const refresh = (): Promise<void> => {
      if (refreshing && refreshEpoch === readEpoch) return refreshing;
      refreshController?.abort();
      const requestController = new AbortController(); refreshController = requestController;
      const signal = AbortSignal.any([abort.signal, requestController.signal]);
      const startedEpoch = readEpoch; refreshEpoch = readEpoch;
      const startedVersion = stateVersion.current;
      fresh.current = false; setConnection('refreshing');
      const request = api.snapshot(guildId, signal).then(next => {
        if (!valid() || requestController.signal.aborted || startedEpoch !== readEpoch) return;
        // A newer SSE snapshot wins over a GET that started before it.
        if (stateVersion.current === startedVersion) accept(next);
      }).catch(error => { if (!requestController.signal.aborted && startedEpoch === readEpoch) failure(error); }).finally(() => { if (refreshing === request) refreshing = undefined; });
      refreshing = request;
      return refreshing;
    };
    const refreshLibrary = async () => {
      libraryController?.abort();
      const requestController = new AbortController(); libraryController = requestController;
      const signal = AbortSignal.any([abort.signal, requestController.signal]);
      try { const next = await api.library(guildId, signal); if (valid() && !requestController.signal.aborted) { setLibrary(next); setLibraryError(''); } }
      catch (error) {
        if (!valid() || requestController.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) expireAuth();
        else { setLibraryError(errorMessage(error)); if (error instanceof ApiError && [403, 404].includes(error.status)) setLibrary(null); }
      }
    };
    // A conflict or uncertain command needs a new read, not one already in flight.
    refreshRef.current = () => { readEpoch++; return refresh(); }; libraryRefreshRef.current = refreshLibrary;
    const openStream = () => {
      if (!valid()) return;
      stream = new EventSource(api.eventsUrl(guildId), { withCredentials: true });
      stream.onopen = () => { if (valid()) void refresh(); };
      stream.addEventListener('snapshot', event => {
        try { accept(JSON.parse((event as MessageEvent).data)); }
        catch { failure(new Error('The live update could not be read. Reconnect for fresh state.')); }
      });
      stream.onerror = () => {
        if (!valid()) return;
        readEpoch++; fresh.current = false; setConnection('offline');
        setConnectionError('Live updates disconnected. Controls will return after fresh state arrives.');
        // Native EventSource cannot expose an HTTP 401/403. A bounded policy probe
        // clears revoked data even when a rejected stream will never reopen.
        if (Date.now() - lastLossCheck > 10_000) {
          lastLossCheck = Date.now();
          void api.snapshot(guildId, abort.signal).catch(error => {
            if (valid() && !fresh.current && error instanceof ApiError && [401, 403, 404].includes(error.status)) failure(error);
          });
        }
      };
    };
    void refresh().then(() => { if (valid() && current.current) openStream(); });
    void refreshLibrary();
    const policyCheck = () => {
      if (!valid()) return;
      if (!document.hidden && fresh.current) void refresh();
      policyTimer = setTimeout(policyCheck, 25_000);
    };
    policyTimer = setTimeout(policyCheck, 25_000);
    const visibility = () => { if (!document.hidden && valid()) { void refresh(); void refreshLibrary(); } };
    const offline = () => { if (valid()) { readEpoch++; fresh.current = false; setConnection('offline'); setConnectionError('You are offline. Discord playback continues; reconnect to control it.'); } };
    const online = () => { if (valid()) { stream?.close(); void refresh().then(openStream); void refreshLibrary(); } };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => {
      abort.abort(); refreshController?.abort(); libraryController?.abort(); stream?.close(); clearTimeout(policyTimer); fresh.current = false;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', offline); window.removeEventListener('online', online);
    };
  }, [guildId, auth, reconnectKey, expireAuth]);

  const can = useCallback((capability: Capability) => {
    if (!fresh.current || !current.current || !bootstrap) return false;
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
    try {
      const result = await api.command(id, bootstrap.csrfToken, command);
      if (epoch !== generation.current || activeGuild.current !== id) return false;
      if (fresh.current && stateVersion.current === startedVersion) {
        current.current = result.snapshot; stateVersion.current++;
        setSnapshot(result.snapshot); setReceivedAt(Date.now());
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
  const selectGuild = (id: string) => { fresh.current = false; setGuildId(id); };
  return { bootstrap, auth, authError, loadBootstrap, guildId, selectGuild, snapshot, receivedAt, library, libraryError,
    refreshLibrary: () => libraryRefreshRef.current(), connection, connectionError,
    reconnect: () => setReconnectKey(k => k + 1), pending, can, blockedReason, run, notice, notify,
    dismissNotice: () => setNotice(null), logout };
}
export type Portal = ReturnType<typeof usePortal>;
