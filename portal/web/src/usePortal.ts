import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Bootstrap, Capability, Command, Connection, GuildSnapshot, ImportPreview, Library, SnapshotOrdering, Track } from './types';
import { orderingOf } from './ordering';
import { applyIntents, createIntent, isAddition, isOptimistic, needsRevision, sameTracks, slotOf, stillTargets, trackIdentities, type Intent } from './optimistic';
import { clearReads, loadRead, onReadsUnauthorized, recapRead, statsRead } from './reads';
import { fromList, isListed } from './favorites';

export interface Notice { id: number; kind: 'success' | 'error' | 'info'; message: string }
// Non-optimistic commands that still bind to the session the user saw.
const conflicting = new Set(['playnext', 'session', 'replay', 'back']);
const bindsToSession = (body: Command) => conflicting.has(body.command) || (body.command === 'mix' && body.subcommand === 'save') || (body.command === 'favorite' && body.subcommand === 'add');
// Changes to the listener's own library or the server's settings never depend on
// the session on screen, so they travel beside playback instead of behind it.
const libraryOnly = (body: Command) => (body.command === 'favorite' && ['remove', 'clear', 'import'].includes(body.subcommand || ''))
  || (body.command === 'mix' && ['delete', 'import'].includes(body.subcommand || '')) || body.command === 'settings';
const freshnessMs = 25_000;
// Returning to the app re-reads the library only when it may be out of date.
const libraryStaleMs = 60_000;
// Rapid song changes settle before history is re-read.
const historySettleMs = 1500;
// Show a quiet syncing hint only when the bot is noticeably slow to confirm.
const syncingAfterMs = 700;
const maxQueued = 8;
type Lane = 'session' | 'library';
interface Entry {
  body: Command; capability: Capability; key: string; lane: Lane; epoch: number; guildId: string;
  intent: Intent | null; resolve: (value: boolean) => void;
  // Verified state when clicked, and whether this device's own predictions were showing.
  clickRevision: string; clickView: GuildSnapshot; overPredictions: boolean;
  // The session revision this change is bound to, if any. It moves forward only
  // past this device's own revision-checked changes that were confirmed ahead of it.
  expectedRevision?: string;
  // What it was sent against and what the bot replied with, once confirmed.
  sentRevision?: string; replyRevision?: string; replyView?: GuildSnapshot;
  // A favorite chosen from what this device shows, whose number may have moved
  // only because of this device's own edits.
  followFavorite?: boolean;
}
// The listener's latest heart choice for one song, while it settles.
interface Want { want: boolean; track: Track; add: () => Promise<boolean>; running: boolean }
const retryDelay = (attempt: number, error?: unknown) => Math.max(Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000), error instanceof ApiError ? error.retryAfterMs : 0);

export function usePortal() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [auth, setAuth] = useState<'loading' | 'ready' | 'signed-out' | 'error'>('loading');
  const [authError, setAuthError] = useState('');
  const [guildId, setGuildId] = useState('');
  const [snapshot, setSnapshot] = useState<GuildSnapshot | null>(null);
  const [receivedAt, setReceivedAt] = useState(Date.now());
  const [library, setLibrary] = useState<Library | null>(null);
  // Favorite choices not yet confirmed, by track id, shown over the library.
  const [wants, setWants] = useState<ReadonlyMap<string, Want>>(new Map());
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
  const queueRef = useRef<Entry[]>([]);
  const sendingRef = useRef<Entry | null>(null);
  // Library-only changes go in their own ordered lane beside the session's.
  const libraryQueueRef = useRef<Entry[]>([]);
  const librarySendingRef = useRef<Entry | null>(null);
  const stoppingRef = useRef<Entry | null>(null);
  const [queued, setQueued] = useState(0);
  const [confirming, setConfirming] = useState(false);
  // Server library as last read, plus this device's confirmed favorite edits.
  const libraryRef = useRef<Library | null>(null);
  const wantsRef = useRef(new Map<string, Want>());
  const notices = useRef(0);
  const intentId = useRef(0);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const libraryRefreshRef = useRef<() => Promise<void>>(async () => {});
  const reconnectRef = useRef<() => void>(() => {});
  const completeCommandRef = useRef<(next: GuildSnapshot, version: number, loss: number, startedOrdering: SnapshotOrdering | null) => Promise<void>>(async () => {});
  const bootstrapSequence = useRef(0);
  const bootstrapAttempt = useRef(0);
  const bootstrapRetryMs = useRef(0);

  const notify = useCallback((message: string, kind: Notice['kind'] = 'info') => {
    notices.current++;
    setNotice({ id: Date.now(), kind, message });
  }, []);
  const putLibrary = useCallback((next: Library | null) => { libraryRef.current = next; setLibrary(next); }, []);
  const clearWants = useCallback(() => { wantsRef.current = new Map(); setWants(wantsRef.current); }, []);
  const expireAuth = useCallback(() => {
    bootstrapSequence.current++;
    generation.current++; lossVersion.current++;
    fresh.current = false;
    current.current = null;
    activeGuild.current = '';
    clearReads('', undefined, { reload: false });
    setSnapshot(null); putLibrary(null); clearWants(); setBootstrap(null); setAuth('signed-out');
    setGuildId(''); setNotice(null);
  }, [putLibrary, clearWants]);

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
      // Being in a server's voice outranks the last server viewed.
      const preferred = [next.voiceGuildId, previous].find(id => id && next.guilds.some(g => g.id === id));
      setGuildId(preferred || next.guilds[0]?.id || '');
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
  // A stats read that finds the session gone signs out like any other read.
  useEffect(() => onReadsUnauthorized(expireAuth), [expireAuth]);
  useEffect(() => {
    if (auth !== 'error' || !bootstrapRetryMs.current) return;
    const timer = setTimeout(() => { if (navigator.onLine) void loadBootstrap(); }, bootstrapRetryMs.current);
    const online = () => void loadBootstrap();
    window.addEventListener('online', online);
    return () => { clearTimeout(timer); window.removeEventListener('online', online); };
  }, [auth, loadBootstrap]);

  // Home's stats and recap need only the server, not its live session, so they
  // start alongside it instead of after the first snapshot.
  const viewerId = bootstrap?.viewer.id;
  useEffect(() => {
    if (!viewerId || !guildId || auth !== 'ready') return;
    for (const read of [statsRead(viewerId, guildId, '30d'), recapRead(viewerId, guildId, '30d')]) void loadRead<unknown>(read.key, read.fetch);
  }, [viewerId, guildId, auth]);

  useEffect(() => {
    const epoch = ++generation.current;
    activeGuild.current = guildId; fresh.current = false; current.current = null; lossVersion.current++;
    setSnapshot(null); putLibrary(null); clearWants(); setLibraryError(''); setConnectionError('');
    setConnection('connecting'); setPending([]); setQueued(0); setConfirming(false);
    for (const entry of [...queueRef.current.splice(0), ...libraryQueueRef.current.splice(0)]) entry.resolve(false);
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
    let libraryReadAt = 0;
    let historyStale = false;
    let historyTimer: ReturnType<typeof setTimeout> | undefined;
    let revalidating: Promise<void> | undefined;
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
      const retired = !!before && (!next.session.current && !!before.session.current || before.session.voiceChannel?.id !== next.session.voiceChannel?.id || before.guild.admin && !next.guild.admin);
      if (retired) {
        // An authorized empty/channel-changed projection must also retire older
        // protected library reads and history before asking for its new library.
        libraryController?.abort(); libraryReady = false; putLibrary(null);
        void refreshLibrary();
      } else if (before && before.session.current?.id !== next.session.current?.id) {
        // A new song in the same room only adds history. The library on screen stays
        // authorized, so keep it while a quiet read (which supersedes older ones) arrives;
        // clearing it blanked favorites and history on every song change. Rapid skips
        // settle first, and a hidden page reads it when it returns.
        historyStale = true; settleHistory();
      }
    };
    const failure = (error: unknown) => {
      if (!valid()) return;
      pauseConnection(errorMessage(error));
      if (error instanceof ApiError && error.status === 401) { accessLost = true; clearRecovery(); libraryController?.abort(); expireAuth(); return; }
      // Protected data is cleared after access loss; connection failures retain read-only context.
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        accessLost = true; clearRecovery(); libraryController?.abort(); libraryReady = false;
        current.current = null; setSnapshot(null); putLibrary(null); clearReads('', guildId, { reload: false });
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
      // A read that starts now includes every song played so far.
      clearTimeout(historyTimer); historyStale = false;
      try { const next = await api.library(guildId, signal); if (valid() && !requestController.signal.aborted) { libraryReady = true; libraryReadAt = Date.now(); putLibrary(next); setLibraryError(''); } }
      catch (error) {
        if (!valid() || requestController.signal.aborted) return;
        libraryReady = false; historyStale = true;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) failure(error);
        else setLibraryError(errorMessage(error));
      } finally { if (libraryController === requestController) libraryController = undefined; }
    };
    const settleHistory = () => {
      clearTimeout(historyTimer);
      if (!document.hidden) historyTimer = setTimeout(() => { if (historyStale) void refreshLibrary(); }, historySettleMs);
    };
    // Coming back to a fresh session re-reads the library quietly, and only when it may be out of date.
    const reviseLibrary = () => {
      if (!libraryReady || historyStale || Date.now() - libraryReadAt >= libraryStaleMs) void refreshLibrary();
    };
    // A quiet check of state the stream should already have delivered. Controls
    // stay enabled; it changes what's shown only through the ordinary rules.
    const revalidate = () => {
      if (!valid() || offline || refreshing || revalidating) return;
      const startedEpoch = readEpoch; const startedLoss = lossVersion.current;
      const request = api.snapshot(guildId, abort.signal).then(next => {
        // A refresh, disconnect or lost lease since it began owns recovery now.
        // An expired lease can't be renewed by a read begun under it: the policy check
        // (or the next return) takes the ordinary fresh read instead.
        if (!valid() || offline || startedEpoch !== readEpoch || startedLoss !== lossVersion.current || !fresh.current
          || Date.now() - verifiedAt.current >= freshnessMs) return;
        validate(next);
        const incoming = orderingOf(next); const accepted = orderingOf(current.current);
        if (incoming && accepted && incoming.instanceId === accepted.instanceId) {
          if (incoming.sequence > accepted.sequence) accept(next);
          return; // Older or equal: the stream is current.
        }
        // Without comparable ordering the read can't be placed among stream frames.
        // The same revision means nothing was missed; anything else takes a fresh read.
        if (next.revision !== current.current?.revision) void refresh();
      }).catch(error => {
        if (!valid() || startedEpoch !== readEpoch) return;
        // Lost access still clears protected data; a transient failure leaves the
        // stream and the freshness timer in charge.
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) failure(error);
      }).finally(() => { if (revalidating === request) revalidating = undefined; });
      revalidating = request;
    };
    const liveAndFresh = () => !!stream && fresh.current && Date.now() - verifiedAt.current < freshnessMs;
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
        pauseConnection('Discord keeps playing. Controls return once you’re reconnected.');
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
    // Returning with a healthy, fresh stream keeps everything usable: no banner,
    // no disabled controls, at most a quiet check. Stale state takes a fresh read.
    const visibility = () => {
      if (document.hidden) { clearTimeout(historyTimer); return; }
      if (!valid()) return;
      if (liveAndFresh()) { revalidate(); reviseLibrary(); } else { void refresh(); void refreshLibrary(); }
    };
    const wentOffline = () => { if (valid()) { offline = true; clearRecovery(); libraryController?.abort(); pauseConnection('You are offline. Discord playback continues; reconnect to control it.'); } };
    const online = () => {
      if (!valid()) return;
      const wasOffline = offline; offline = false;
      if (!wasOffline && liveAndFresh()) { revalidate(); reviseLibrary(); } else { void refresh(); void refreshLibrary(); }
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', wentOffline); window.addEventListener('online', online);
    return () => {
      abort.abort(); refreshController?.abort(); libraryController?.abort(); closeStream(); clearRecovery(); clearTimeout(policyTimer); clearTimeout(historyTimer); fresh.current = false;
      refreshRef.current = async () => {}; libraryRefreshRef.current = async () => {};
      reconnectRef.current = () => {}; completeCommandRef.current = async () => {};
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', wentOffline); window.removeEventListener('online', online);
    };
  }, [guildId, auth, expireAuth, putLibrary, clearWants]);

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
  // Hearts show the listener's latest choice at once; the library confirms it.
  const shownLibrary = useMemo(() => {
    if (!library || !wants.size) return library;
    const favorites = library.favorites.filter(track => wants.get(track.id)?.want !== false);
    for (const [id, want] of wants) if (want.want && !favorites.some(track => track.id === id)) favorites.push(want.track);
    return { ...library, favorites };
  }, [library, wants]);
  const syncQueue = useCallback(() => {
    const session = queueRef.current;
    setIntents(session.flatMap(entry => entry.intent ? [entry.intent] : []));
    setPending([stoppingRef.current, ...session, ...libraryQueueRef.current].flatMap(entry => entry && !entry.intent ? [entry.key] : []));
    // Changes the screen can't show until the bot answers, and taps waiting behind them.
    const first = session.findIndex(entry => !entry.intent);
    setConfirming(first >= 0);
    setQueued(first < 0 ? 0 : session.length - first - 1);
  }, []);
  useEffect(() => {
    if (!intents.length) { setSyncing(false); return; }
    const wait = Math.min(...intents.map(intent => intent.createdAt)) + syncingAfterMs - Date.now();
    if (wait <= 0) { setSyncing(true); return; }
    setSyncing(false);
    const timer = setTimeout(() => setSyncing(true), wait);
    return () => clearTimeout(timer);
  }, [intents]);

  // Settle unsent session entries from `from` onward. They were built on predictions
  // that no longer hold; nothing unsent is ever replayed later.
  const discard = useCallback((from: number, message?: string) => {
    const queue = queueRef.current;
    let start = Math.max(0, from);
    if (queue[start] && queue[start] === sendingRef.current) start++;
    for (const entry of queue.splice(start)) entry.resolve(false);
    syncQueue();
    if (message) notify(message, 'error');
  }, [notify, syncQueue]);

  const send = useCallback(async (entry: Entry): Promise<boolean> => {
    const { body, guildId: id, epoch, intent } = entry;
    const settled = () => epoch === generation.current && activeGuild.current === id;
    const verified = current.current;
    if (!settled()) return false;
    // Only session changes are built on one another; a library change stands alone.
    const session = entry.lane === 'session';
    const behind = () => queueRef.current.indexOf(entry) + 1;
    const refuse = (message: string) => { if (session) discard(behind(), message); else notify(message, 'error'); return false; };
    if (!can(entry.capability) || !bootstrap || !verified) {
      return refuse(fresh.current ? 'Your change was not sent because your playback access changed. Review the session and try again.'
        : 'Reconnect for fresh state before making changes.');
    }
    const command = { ...body };
    if (intent) {
      // Queue edits must still target the tracks the user acted on.
      if (!stillTargets(intent, verified)) { discard(behind(), 'The queue changed before your change was sent. Review it and try again.'); return false; }
      delete command.expectedRevision;
      if (needsRevision(command)) command.expectedRevision = verified.revision;
      intent.sent = true;
    } else {
      delete command.expectedRevision;
      if (entry.expectedRevision) command.expectedRevision = entry.expectedRevision;
      // Clicked while this device's own playback changes were still settling:
      // if they landed exactly as shown, the user's target is still current.
      if (entry.overPredictions && command.expectedRevision === entry.clickRevision && verified.revision !== entry.clickRevision
        && sameTracks(trackIdentities(entry.clickView), trackIdentities(verified))) command.expectedRevision = verified.revision;
      // A favorite picked from what this device shows is named by its id; its number
      // is wherever it sits now, after this device's own edits. The bot still checks
      // the id there. A number typed against older state still conflicts.
      const list = libraryRef.current?.favorites;
      if (entry.followFavorite && list) {
        const index = list.findIndex(track => track.id === body.expectedTrackId);
        if (index < 0) { notify('That song is no longer in your favorites.', 'error'); return false; }
        command.options = { ...command.options, index: index + 1 };
      }
    }
    const startedVersion = stateVersion.current;
    const startedLoss = lossVersion.current;
    const startedOrdering = orderingOf(current.current);
    const touchesLibrary = ['favorite', 'mix', 'replay', 'session', 'settings'].includes(body.command);
    try {
      const result = await api.command(id, bootstrap.csrfToken, command);
      if (!settled()) return false;
      entry.sentRevision = command.expectedRevision; entry.replyRevision = result.snapshot?.revision; entry.replyView = result.snapshot;
      await completeCommandRef.current(result.snapshot, startedVersion, startedLoss, startedOrdering);
      if (!settled()) return false;
      if (!fresh.current || !current.current) {
        if (session) discard(behind());
        if (touchesLibrary) void libraryRefreshRef.current();
        notify('The action completed. Reconnect for fresh state before making another change.', 'info');
        return false; // Keep the form draft while the confirmed result cannot be reconciled.
      }
      // A playback change is already on screen; other actions, and an addition's
      // queue position, confirm.
      if (!intent || intent.track) notify(result.message || 'Done.', 'success');
      // The reply carries no library, so it's re-read quietly behind what's already shown.
      if (touchesLibrary) void libraryRefreshRef.current();
      return true;
    } catch (error) {
      if (!settled()) return false;
      // Roll back a rejected prediction at once, with everything queued on top of
      // it, rather than after the recovery read below. Changes that weren't
      // predicted left nothing for later taps to build on.
      if (intent) { entry.intent = null; discard(behind()); }
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

  // Each lane sends one change at a time, in the order the user made them.
  const pump = useCallback(async (lane: Lane) => {
    const queue = lane === 'session' ? queueRef : libraryQueueRef;
    const sending = lane === 'session' ? sendingRef : librarySendingRef;
    if (sending.current) return;
    const entry = queue.current[0];
    if (!entry) return;
    sending.current = entry;
    let ok = false;
    try { ok = await send(entry); }
    finally {
      sending.current = null;
      if (entry.epoch === generation.current) {
        const index = queue.current.indexOf(entry);
        if (index >= 0) queue.current.splice(index, 1);
        if (ok && lane === 'session') {
          // Predictions queued behind a confirmed change were built on its result.
          const revision = current.current?.revision;
          if (revision) for (const next of queueRef.current) if (next.intent) next.intent.baseRevision = revision;
          // A revision-checked change applied exactly on top of what a later tap was
          // bound to. If its result still shows the songs that tap saw, the tap is bound
          // to the result instead of a self-made conflict; otherwise it conflicts and
          // asks for a deliberate retry, since its target (say, the current song) moved.
          const { sentRevision, replyRevision, replyView } = entry;
          if (sentRevision && replyRevision && replyView?.session) for (const next of queueRef.current) {
            if (next.intent || next.expectedRevision !== sentRevision) continue;
            if (!sameTracks(trackIdentities(next.clickView), trackIdentities(replyView))) continue;
            next.expectedRevision = replyRevision;
            if (next.clickRevision === sentRevision) next.clickRevision = replyRevision;
          }
        }
        syncQueue();
      }
      entry.resolve(ok);
      void pump(lane);
    }
  }, [send, syncQueue]);

  const run = useCallback(async (body: Command, capability: Capability, tracks?: Track[]): Promise<boolean> => {
    // Check refs at click time, not a render-time closure, so offline clicks cannot escape.
    if (!can(capability) || !bootstrap || !current.current) { notify(blockedReason, 'error'); return false; }
    const id = activeGuild.current; const epoch = generation.current; const verified = current.current;
    const key = `${body.command}:${body.subcommand || ''}`;
    const optimistic = isOptimistic(body); const addition = isAddition(body, tracks);
    const lane: Lane = libraryOnly(body) ? 'library' : 'session';
    // A second identical tap while the first is still on its way is the same change.
    if (!optimistic && !addition) {
      const signature = JSON.stringify(body);
      const waiting = [stoppingRef.current, sendingRef.current, librarySendingRef.current, ...queueRef.current, ...libraryQueueRef.current];
      if (waiting.some(other => other && !other.intent && other.epoch === epoch && other.guildId === id && JSON.stringify(other.body) === signature)) {
        if (body.command !== 'stop') notify('That change is already on its way.', 'info');
        return false;
      }
    }
    const predictions = () => queueRef.current.flatMap(entry => entry.intent ? [entry.intent] : []);
    const shown = applyIntents(verified, receivedAt, predictions());
    const entry: Entry = { body, capability, key, lane, epoch, guildId: id, intent: null, resolve: () => {},
      clickRevision: verified.revision, clickView: shown.snapshot, overPredictions: predictions().length > 0,
      expectedRevision: bindsToSession(body) ? body.expectedRevision ?? verified.revision : body.expectedRevision,
      followFavorite: body.command === 'favorite' && ['play', 'remove'].includes(body.subcommand || '') && !!body.expectedTrackId && isListed(body) };
    if (body.command === 'stop') {
      // Stop cancels queued session work on the bot too; never send it afterwards.
      // Library changes don't depend on the session, so they carry on.
      discard(0);
      stoppingRef.current = entry; syncQueue();
      try { return await send(entry); }
      finally { if (epoch === generation.current) { stoppingRef.current = null; syncQueue(); } }
    }
    if (optimistic) {
      // The newest choice for a set-state control replaces an unsent older one.
      const slot = slotOf(body);
      const replaced = slot ? queueRef.current.find(queued => queued.intent?.slot === slot && !queued.intent.sent) : undefined;
      if (replaced) { queueRef.current.splice(queueRef.current.indexOf(replaced), 1); replaced.resolve(true); }
      const base = applyIntents(verified, receivedAt, predictions());
      entry.intent = createIntent(++intentId.current, body, base.snapshot, verified, base.receivedAt, Date.now());
      if (!entry.intent) { syncQueue(); return true; } // Already the state the user asked for.
      if (queueRef.current.length >= maxQueued) { syncQueue(); notify('Give Discord a moment to catch up before making more changes.', 'info'); return false; }
    } else if (addition) {
      if (queueRef.current.length >= maxQueued) { notify('Give Discord a moment to catch up before adding more songs.', 'info'); return false; }
      const base = applyIntents(verified, receivedAt, predictions());
      entry.intent = createIntent(++intentId.current, body, base.snapshot, verified, base.receivedAt, Date.now(), tracks![0]);
      notify(body.command === 'playnext' ? `Playing “${tracks![0].title}” next…` : `Adding “${tracks![0].title}”…`, 'info');
    } else {
      const queue = lane === 'session' ? queueRef.current : libraryQueueRef.current;
      if (queue.length >= maxQueued) { notify('Give Discord a moment to catch up before making more changes.', 'info'); return false; }
      // Waiting behind a change the screen can't show yet: say it's queued, not lost.
      // A heart already shows its own answer.
      if (lane === 'session' && key !== 'favorite:add' && queue.some(other => !other.intent)) notify('Queued. It’s sent once your earlier change is confirmed.', 'info');
    }
    return await new Promise<boolean>(resolve => {
      entry.resolve = resolve;
      (lane === 'session' ? queueRef : libraryQueueRef).current.push(entry);
      syncQueue(); void pump(lane);
    });
  }, [bootstrap, can, notify, blockedReason, receivedAt, discard, send, pump, syncQueue]);

  // Edits the confirmed library this device holds, between server reads.
  const patchFavorites = useCallback((track: Track, saved: boolean) => {
    const list = libraryRef.current;
    if (!list || list.favorites.some(favorite => favorite.id === track.id) === saved) return;
    putLibrary({ ...list, favorites: saved ? [...list.favorites, track] : list.favorites.filter(favorite => favorite.id !== track.id) });
  }, [putLibrary]);
  // Sends what it takes to reach the listener's latest choice for one song, one
  // change at a time, so rapid taps end where the last one left the heart.
  const settleFavorite = useCallback(async (id: string, want: Want) => {
    const epoch = generation.current;
    want.running = true;
    try {
      for (;;) {
        if (epoch !== generation.current || wantsRef.current.get(id) !== want) return;
        const saved = !!libraryRef.current?.favorites.some(track => track.id === id);
        if (want.want === saved) return;
        const adding = want.want; const said = notices.current;
        const remove = fromList({ command: 'favorite', subcommand: 'remove', options: { index: (libraryRef.current?.favorites.findIndex(track => track.id === id) ?? 0) + 1 }, expectedTrackId: id });
        const ok = adding ? await want.add() : await run(remove, 'library');
        if (epoch !== generation.current) return;
        if (!ok) {
          // The heart goes back to what's saved; say why if nothing else has.
          if (said === notices.current) notify(adding ? 'This song wasn’t saved to your favorites. Try again.' : 'This song is still in your favorites. Try again.', 'error');
          return;
        }
        patchFavorites(want.track, adding);
      }
    } finally {
      want.running = false;
      if (wantsRef.current.get(id) === want) { wantsRef.current = new Map(wantsRef.current); wantsRef.current.delete(id); setWants(wantsRef.current); }
    }
  }, [run, notify, patchFavorites]);
  // Toggle a song's heart. `add` saves it the way its surface needs (the current
  // song, a queue position, or a link from this device), captured at this tap.
  const favorite = useCallback((track: Track, add: () => Promise<boolean>) => {
    const existing = wantsRef.current.get(track.id);
    const shown = existing ? existing.want : !!libraryRef.current?.favorites.some(saved => saved.id === track.id);
    const want: Want = existing || { want: shown, track, add, running: false };
    want.want = !shown; want.add = add;
    wantsRef.current = new Map(wantsRef.current).set(track.id, want); setWants(wantsRef.current);
    if (!want.running) void settleFavorite(track.id, want);
  }, [settleFavorite]);

  // An import preview only reads, so it skips the ordered command queue. Its
  // confirmation goes through run() with the preview's id.
  const previewImport = useCallback(async (body: Command): Promise<ImportPreview | null> => {
    if (!can('library') || !bootstrap || !current.current) { notify(blockedReason, 'error'); return null; }
    const id = activeGuild.current;
    try {
      const result = await api.command(id, bootstrap.csrfToken, body);
      if (activeGuild.current !== id) return null;
      if (!result.preview) notify(result.message || 'Nothing to import.', 'info');
      return result.preview || null;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expireAuth();
      else if (activeGuild.current === id) notify(errorMessage(error), 'error');
      return null;
    }
  }, [bootstrap, can, notify, blockedReason, expireAuth]);

  const logout = async () => {
    if (!bootstrap) return;
    try { await api.logout(bootstrap.csrfToken); expireAuth(); }
    catch (error) { notify(errorMessage(error), 'error'); }
  };
  const selectGuild = (id: string) => { if (id === activeGuild.current) return; fresh.current = false; activeGuild.current = id; setGuildId(id); };
  // snapshot/receivedAt include this device's unconfirmed playback predictions;
  // verified is the last authorized bot state and the only permission source.
  // pending lists changes waiting for the bot; none of them locks other controls.
  return { bootstrap, auth, authError, loadBootstrap, guildId, selectGuild, snapshot: view.snapshot, receivedAt: view.receivedAt, verified: snapshot,
    library: shownLibrary, libraryError, refreshLibrary: () => libraryRefreshRef.current(), connection, connectionError,
    reconnect: () => reconnectRef.current(), pending, confirming, queued, syncing, can, blockedReason, run, favorite, previewImport, notice, notify,
    dismissNotice: () => setNotice(null), logout };
}
export type RemotePortal = ReturnType<typeof usePortal>;
export type { Portal } from './playback';
