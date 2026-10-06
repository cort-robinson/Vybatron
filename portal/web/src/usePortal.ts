import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Bootstrap, Capability, Command, Connection, GuildSnapshot, Library, SnapshotOrdering } from './types';
import { applyIntents, createIntent, isOptimistic, needsRevision, sameTracks, slotOf, stillTargets, trackIdentities, type Intent } from './optimistic';

export interface Notice { id: number; kind: 'success' | 'error' | 'info'; message: string }
// Non-optimistic commands that still bind to the session the user saw.
const conflicting = new Set(['playnext', 'session', 'replay']);
const freshnessMs = 25_000;
// Show a quiet syncing hint only when the bot is noticeably slow to confirm.
const syncingAfterMs = 700;
const maxQueued = 8;
interface Entry {
  body: Command; capability: Capability; key: string; epoch: number; guildId: string;
  intent: Intent | null; resolve: (value: boolean) => void;
  // Verified state when clicked, and whether this device's own predictions were showing.
  clickRevision: string; clickView: GuildSnapshot; overPredictions: boolean;
}
const retryDelay = (attempt: number, error?: unknown) => Math.max(Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000), error instanceof ApiError ? error.retryAfterMs : 0);
const orderingOf = (snapshot: GuildSnapshot | null): SnapshotOrdering | null => {
  const stamp = snapshot?.ordering;
  return stamp && typeof stamp.instanceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stamp.instanceId)
    && Number.isSafeInteger(stamp.sequence) && stamp.sequence > 0 ? stamp : null;
};

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
  const [intents, setIntents] = useState<Intent[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const fresh = useRef(false);
  const verifiedAt = useRef(0);
  const lossVersion = useRef(0);
  const activeGuild = useRef('');
  const current = useRef<GuildSnapshot | null>(null);
  const generation = useRef(0);
  const stateVersion = useRef(0);
  const pendingRef = useRef(new Set<string>());
  const queueRef = useRef<Entry[]>([]);
  const sendingRef = useRef<Entry | null>(null);
  const intentId = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const libraryRefreshRef = useRef<() => Promise<void>>(async () => {});
  const reconnectRef = useRef<() => void>(() => {});
  const completeCommandRef = useRef<(next: GuildSnapshot, version: number, loss: number, startedOrdering: SnapshotOrdering | null) => Promise<void>>(async () => {});
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
    for (const entry of queueRef.current.splice(0)) entry.resolve(false);
    setIntents([]);
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
    const validate = (next: GuildSnapshot) => {
      if (next?.guild?.id !== guildId || typeof next.revision !== 'string' || !Array.isArray(next.session?.queue)
        || (next.ordering !== undefined && !orderingOf(next))) throw new ApiError(503, 'invalid_response', 'Live state is unavailable. Refresh and try again.');
    };
    const accept = (next: GuildSnapshot) => {
      if (!valid() || offline) return;
      validate(next);
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
      lossVersion.current++; fresh.current = false; setConnection('refreshing');
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
    const freshRead = () => { closeStream(); invalidateRead(); return refresh(); };
    refreshRef.current = freshRead; libraryRefreshRef.current = refreshLibrary;
    const openStream = () => {
      if (!valid() || offline || stream) return;
      const openedEpoch = ++streamEpoch;
      const source = new EventSource(api.eventsUrl(guildId), { withCredentials: true }); stream = source;
      const liveSource = () => valid() && !offline && stream === source && openedEpoch === streamEpoch;
      // The stream supplies its own freshly authorized initial snapshot. Opening
      // it is not proof of freshness and does not need a duplicate protected GET.
      source.addEventListener('snapshot', event => {
        if (!liveSource()) return;
        try {
          const next = JSON.parse((event as MessageEvent).data) as GuildSnapshot;
          validate(next);
          const incoming = orderingOf(next); const accepted = orderingOf(current.current);
          if (incoming || accepted) {
            // Instance changes and lost freshness need an independent read. An
            // ordered frame cannot restore a lease that the transport invalidated.
            if (!incoming || !accepted || incoming.instanceId !== accepted.instanceId
              || !fresh.current || Date.now() - verifiedAt.current >= freshnessMs) { void refresh(); return; }
            if (incoming.sequence <= accepted.sequence) return; // No freshness extension.
          }
          accept(next); recoveryAttempt = 0; retryNotBefore = 0;
        }
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
    completeCommandRef.current = async (next, version, loss, startedOrdering) => {
      if (!valid()) return;
      const stillFresh = fresh.current && Date.now() - verifiedAt.current < freshnessMs && loss === lossVersion.current;
      const incoming = orderingOf(next); const accepted = orderingOf(current.current);
      if (startedOrdering || incoming || accepted || next?.ordering !== undefined) {
        // Compare only within the bridge lifetime in which this command began,
        // with the same guild/generation and an uninterrupted freshness lease.
        if (stillFresh && !offline && startedOrdering && incoming && accepted
          && incoming.instanceId === startedOrdering.instanceId && incoming.instanceId === accepted.instanceId) {
          try {
            validate(next);
            if (incoming.sequence > accepted.sequence) accept(next);
          } catch { await freshRead(); }
          return; // Keep a healthy SSE open; older/equal replies do not renew freshness.
        }
        await freshRead(); return;
      }
      const unambiguous = stillFresh && version === stateVersion.current;
      const alreadyVerified = stillFresh && !offline && JSON.stringify(next) === JSON.stringify(current.current);
      closeStream(); invalidateRead();
      // A pre-mutation SSE frame must not hide a pause result. Conversely, a
      // delayed command reply must not replace a later Discord/Stop update.
      // Revisions are hashes, so overlap requires a read begun after the reply.
      if (alreadyVerified) {
        // A newer authorized frame already supplies exactly this result, including
        // actor capabilities. Keep its freshness/position timestamps; an older
        // equal reply must not extend the authorization lease. Hash equality
        // alone would miss permission, listener and position changes.
        openStream();
      } else if (unambiguous && !offline) {
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

  const view = useMemo(() => snapshot ? applyIntents(snapshot, receivedAt, intents) : { snapshot, receivedAt }, [snapshot, receivedAt, intents]);
  const syncQueue = useCallback(() => {
    setIntents(queueRef.current.flatMap(entry => entry.intent ? [entry.intent] : []));
    setPending([...pendingRef.current]);
  }, []);
  useEffect(() => {
    if (!intents.length) { setSyncing(false); return; }
    const wait = Math.min(...intents.map(intent => intent.createdAt)) + syncingAfterMs - Date.now();
    if (wait <= 0) { setSyncing(true); return; }
    setSyncing(false);
    const timer = setTimeout(() => setSyncing(true), wait);
    return () => clearTimeout(timer);
  }, [intents]);

  // Settle unsent entries from `from` onward. They were built on predictions
  // that no longer hold; nothing unsent is ever replayed later.
  const discard = useCallback((from: number, message?: string) => {
    const queue = queueRef.current;
    let start = Math.max(0, from);
    if (queue[start] && queue[start] === sendingRef.current) start++;
    for (const entry of queue.splice(start)) { if (!entry.intent) pendingRef.current.delete(entry.key); entry.resolve(false); }
    syncQueue();
    if (message) notify(message, 'error');
  }, [notify, syncQueue]);

  const send = useCallback(async (entry: Entry): Promise<boolean> => {
    const { body, guildId: id, epoch, intent } = entry;
    const settled = () => epoch === generation.current && activeGuild.current === id;
    const verified = current.current;
    if (!settled()) return false;
    const behind = () => queueRef.current.indexOf(entry) + 1;
    if (!can(entry.capability) || !bootstrap || !verified) {
      discard(behind(), fresh.current ? 'Your change was not sent because your playback access changed. Review the session and try again.'
        : 'Reconnect for fresh state before making changes.');
      return false;
    }
    const command = { ...body };
    if (intent) {
      // Queue edits must still target the tracks the user acted on.
      if (!stillTargets(intent, verified)) { discard(behind(), 'The queue changed before your change was sent. Review it and try again.'); return false; }
      delete command.expectedRevision;
      if (needsRevision(command)) command.expectedRevision = verified.revision;
      intent.sent = true;
    } else {
      if (conflicting.has(body.command) || (body.command === 'mix' && body.subcommand === 'save') || (body.command === 'favorite' && body.subcommand === 'add')) {
        command.expectedRevision = body.expectedRevision ?? entry.clickRevision;
      }
      // Clicked while this device's own playback changes were still settling:
      // if they landed exactly as shown, the user's target is still current.
      if (entry.overPredictions && command.expectedRevision === entry.clickRevision && verified.revision !== entry.clickRevision
        && sameTracks(trackIdentities(entry.clickView), trackIdentities(verified))) command.expectedRevision = verified.revision;
    }
    const startedVersion = stateVersion.current;
    const startedLoss = lossVersion.current;
    const startedOrdering = orderingOf(current.current);
    try {
      const result = await api.command(id, bootstrap.csrfToken, command);
      if (!settled()) return false;
      await completeCommandRef.current(result.snapshot, startedVersion, startedLoss, startedOrdering);
      if (!settled()) return false;
      if (!fresh.current || !current.current) {
        discard(behind());
        notify('The action completed. Reconnect for fresh state before making another change.', 'info');
        return false; // Keep the form draft while the confirmed result cannot be reconciled.
      }
      // A playback change is already on screen; only other actions confirm.
      if (!intent) notify(result.message || 'Done.', 'success');
      if (['favorite', 'mix', 'replay', 'session', 'settings'].includes(body.command)) void libraryRefreshRef.current();
      return true;
    } catch (error) {
      if (!settled()) return false;
      // Roll back this rejected change at once, with everything queued on top
      // of it, rather than after the recovery read below.
      entry.intent = null;
      discard(behind());
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
    }
  }, [bootstrap, can, discard, notify, expireAuth]);

  // One command reaches the bot at a time, in the order the user made them.
  const pump = useCallback(async () => {
    if (sendingRef.current) return;
    const entry = queueRef.current[0];
    if (!entry) return;
    sendingRef.current = entry;
    let ok = false;
    try { ok = await send(entry); }
    finally {
      sendingRef.current = null;
      if (entry.epoch === generation.current) {
        const index = queueRef.current.indexOf(entry);
        if (index >= 0) queueRef.current.splice(index, 1);
        if (!entry.intent) pendingRef.current.delete(entry.key);
        // Predictions queued behind a confirmed change were built on its result.
        const revision = current.current?.revision;
        if (ok && revision) for (const next of queueRef.current) if (next.intent) next.intent.baseRevision = revision;
        syncQueue();
      }
      entry.resolve(ok);
      void pump();
    }
  }, [send, syncQueue]);

  const run = useCallback(async (body: Command, capability: Capability): Promise<boolean> => {
    // Check refs at click time, not a render-time closure, so offline clicks cannot escape.
    if (!can(capability) || !bootstrap || !current.current) { notify(blockedReason, 'error'); return false; }
    const id = activeGuild.current; const epoch = generation.current; const verified = current.current;
    const key = `${body.command}:${body.subcommand || ''}`;
    // Ordinary actions still hold one at a time; Stop keeps its urgent exception.
    if (pendingRef.current.has(key) || (pendingRef.current.size && body.command !== 'stop')) return false;
    const predictions = () => queueRef.current.flatMap(entry => entry.intent ? [entry.intent] : []);
    const shown = applyIntents(verified, receivedAt, predictions());
    const entry: Entry = { body, capability, key, epoch, guildId: id, intent: null, resolve: () => {},
      clickRevision: verified.revision, clickView: shown.snapshot, overPredictions: predictions().length > 0 };
    if (body.command === 'stop') {
      // Stop cancels queued work on the bot too; never send it afterwards.
      discard(0);
      pendingRef.current.add(key); setPending([...pendingRef.current]);
      try { return await send(entry); }
      finally { if (epoch === generation.current) { pendingRef.current.delete(key); setPending([...pendingRef.current]); } }
    }
    if (isOptimistic(body)) {
      // The newest choice for a set-state control replaces an unsent older one.
      const slot = slotOf(body);
      const replaced = slot ? queueRef.current.find(queued => queued.intent?.slot === slot && !queued.intent.sent) : undefined;
      if (replaced) { queueRef.current.splice(queueRef.current.indexOf(replaced), 1); replaced.resolve(true); }
      const base = applyIntents(verified, receivedAt, predictions());
      entry.intent = createIntent(++intentId.current, body, base.snapshot, verified, base.receivedAt, Date.now());
      if (!entry.intent) { syncQueue(); return true; } // Already the state the user asked for.
      if (queueRef.current.length >= maxQueued) { syncQueue(); notify('Give Discord a moment to catch up before making more changes.', 'info'); return false; }
    }
    return await new Promise<boolean>(resolve => {
      entry.resolve = resolve;
      queueRef.current.push(entry);
      if (!entry.intent) pendingRef.current.add(key);
      syncQueue(); void pump();
    });
  }, [bootstrap, can, notify, blockedReason, receivedAt, discard, send, pump, syncQueue]);

  const logout = async () => {
    if (!bootstrap) return;
    try { await api.logout(bootstrap.csrfToken); expireAuth(); }
    catch (error) { notify(errorMessage(error), 'error'); }
  };
  const selectGuild = (id: string) => { if (id === activeGuild.current) return; fresh.current = false; activeGuild.current = id; setGuildId(id); };
  // snapshot/receivedAt include this device's unconfirmed playback predictions;
  // verified is the last authorized bot state and the only permission source.
  return { bootstrap, auth, authError, loadBootstrap, guildId, selectGuild, snapshot: view.snapshot, receivedAt: view.receivedAt, verified: snapshot,
    library, libraryError, refreshLibrary: () => libraryRefreshRef.current(), connection, connectionError,
    reconnect: () => reconnectRef.current(), pending, syncing, can, blockedReason, run, notice, notify,
    dismissNotice: () => setNotice(null), logout };
}
export type Portal = ReturnType<typeof usePortal>;
