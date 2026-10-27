import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowBendUpRightIcon, LinkIcon, MagnifyingGlassIcon, PlusIcon, RadioIcon, SparkleIcon } from '@phosphor-icons/react';
import { api, errorMessage } from '../api';
import type { Track } from '../types';
import type { Portal } from '../usePortal';
import { time } from '../format';
import { isLink, libraryMatches, suggestArtists, suggestTracks } from '../suggestions';
import { Artwork, Dialog, Empty, ErrorState, IconButton, Loading } from './ui';
import { radioLabel } from '../radio';

// Search as you type: wait for a short pause, reuse recent answers, and leave
// links (slow public imports) to an explicit Search or direct add.
const TYPING_DELAY_MS = 300;
const MIN_LIVE_LENGTH = 2;
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 30;
type Result = { tracks: Track[]; notice: string | null };

// The typed search lives outside the app's state: both search forms and the top bar's echo of it
// share it, and a keystroke re-renders only them, not every page behind the dialog.
let draft = '';
const drafts = new Set<() => void>();
export function setSearchDraft(value: string) { if (value !== draft) { draft = value; drafts.forEach(listener => listener()); } }
const subscribeDraft = (listener: () => void) => { drafts.add(listener); return () => { drafts.delete(listener); }; };
const useSearchDraft = () => useSyncExternalStore(subscribeDraft, () => draft);
export function SearchDraft({ placeholder }: { placeholder: string }) { return useSearchDraft() || placeholder; }

function ResultRow({ track, detail, enabled, nextEnabled, radioEnabled, blockedReason, onAdd, onNext, onRadio }: { track: Track; detail: string; enabled: boolean; nextEnabled: boolean; radioEnabled: boolean | null; blockedReason: string; onAdd: (track: Track) => void; onNext: (track: Track) => void; onRadio: (uri: string) => void }) {
  return <li><Artwork track={track} /><div className="track-text"><strong>{track.title}</strong><span>{track.author} · {detail}</span></div><span className="result-length">{track.isStream ? 'Live' : time(track.durationMs)}</span>
    {radioEnabled !== null && <IconButton className="radio-start" label={radioLabel(track)} disabled={!radioEnabled || !track.uri} title={!track.uri ? 'This result has no public source reference' : !radioEnabled ? blockedReason : radioLabel(track)} onClick={() => { if (track.uri) onRadio(track.uri); }}><RadioIcon size={21} /></IconButton>}<IconButton className="next-result" label={`Play ${track.title} next`} disabled={!nextEnabled || !track.uri} title={!nextEnabled ? blockedReason : `Play ${track.title} next`} onClick={() => onNext(track)}><ArrowBendUpRightIcon size={21} /></IconButton><button className="button secondary add-result" aria-label={`Add ${track.title} to queue`} disabled={!enabled || !track.uri} title={!track.uri ? 'This result has no public source reference' : !enabled ? blockedReason : undefined} onClick={() => { if (track.uri) onAdd(track); }}><PlusIcon size={19} /><span>Add</span></button></li>;
}

export function Search({ portal, open, onClose, page = false }: { portal: Portal; open: boolean; onClose: () => void; page?: boolean }) {
  const query = useSearchDraft(); const setQuery = setSearchDraft;
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState('');
  const controller = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, Result & { expiresAt: number }>());
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const inFlight = useRef('');
  const latestGuild = useRef(portal.guildId);
  latestGuild.current = portal.guildId;
  const hasAccess = !!portal.snapshot;
  const maxLength = portal.bootstrap?.commands.find(c => c.name === 'play')?.options?.find(o => o.name === 'query')?.max_length || 200;
  const typed = query.trim();
  const reset = () => {
    controller.current?.abort(); sequence.current++; inFlight.current = '';
    setTracks(null); setNotice(null); setError(''); setSearching(false); setLastQuery('');
  };
  useEffect(() => { cache.current.clear(); reset(); }, [portal.guildId]);
  useEffect(() => {
    if (hasAccess) return;
    cache.current.clear(); reset();
  }, [hasAccess]);
  useEffect(() => () => controller.current?.abort(), []);
  const search = async (value = typed) => {
    if (!value || value.length > maxLength || portal.connection !== 'live' || !hasAccess) return;
    const guild = portal.guildId; const key = `${guild}:${value.toLocaleLowerCase()}`;
    // An explore chip searches at once and its typing pause then asks again: let the first answer arrive.
    if (inFlight.current === key) return;
    controller.current?.abort(); controller.current = new AbortController();
    const seq = ++sequence.current; inFlight.current = '';
    const cached = cache.current.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      setTracks(cached.tracks); setNotice(cached.notice); setLastQuery(value); setError(''); setSearching(false); return;
    }
    setSearching(true); setError(''); inFlight.current = key;
    try {
      const result = await api.search(guild, value, controller.current.signal);
      if (seq === sequence.current && latestGuild.current === guild) {
        cache.current.delete(key);
        while (cache.current.size >= CACHE_LIMIT) cache.current.delete(cache.current.keys().next().value!);
        cache.current.set(key, { ...result, expiresAt: Date.now() + CACHE_TTL_MS });
        setTracks(result.tracks); setNotice(result.notice); setLastQuery(value);
      }
    } catch (cause) { if (!controller.current?.signal.aborted && seq === sequence.current) setError(errorMessage(cause)); }
    finally { if (seq === sequence.current) { setSearching(false); inFlight.current = ''; } }
  };
  useEffect(() => {
    if (!typed) { reset(); return; }
    if (!open || !hasAccess || portal.connection !== 'live' || Array.from(typed).length < MIN_LIVE_LENGTH || isLink(typed) || typed.length > maxLength) return;
    const timer = setTimeout(() => void search(typed), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  // search reads the same render's state; these are the inputs that change it.
  }, [typed, open, hasAccess, portal.connection, portal.guildId, maxLength]);
  // Suggestions rank the whole library, so a closed dialog skips them. They read only the current
  // song and the queue, not the position that changes with every live frame.
  const session = portal.snapshot?.session;
  const picks = useMemo(() => !open || typed ? [] : suggestTracks(portal.library, session), [open, typed, portal.library, session?.current, session?.queue]);
  const artists = useMemo(() => !open || typed ? [] : suggestArtists(portal.library, session), [open, typed, portal.library, session?.current]);
  const mine = useMemo(() => !open || !typed || isLink(typed) ? [] : libraryMatches(portal.library, typed), [open, typed, portal.library]);
  // A chosen result travels with its query, so playing it here needs no second lookup.
  const add = (next: boolean, value: string, track?: Track) => portal.run({ command: next ? 'playnext' : 'play', options: { query: value } }, next ? 'control' : 'add', track && [track]);
  const explore = (artist: string) => { setQuery(artist); input.current?.focus(); void search(artist); };
  const enabled = portal.can('add') && !portal.pending.length;
  const controllable = portal.can('control') && !portal.pending.length;
  const radio = (uri: string) => portal.run({ command: 'radio', subcommand: 'on', options: { track: uri } }, 'control');
  const row = (track: Track, detail: string, key: string) => <ResultRow key={key} track={track} detail={detail} enabled={enabled} radioEnabled={portal.target === 'local' ? null : controllable} blockedReason={portal.blockedReason} nextEnabled={controllable} onAdd={track => void add(false, track.uri!, track)} onNext={track => void add(true, track.uri!, track)} onRadio={uri => void radio(uri)} />;
  const stale = searching || (!!lastQuery && lastQuery !== typed);
  if (!open) return null;
  const body = <>
    <form onSubmit={event => { event.preventDefault(); void search(); }} className="search-form" role="search"><label className="search-field"><MagnifyingGlassIcon size={22} /><span className="sr-only">Music search</span><input ref={input} type="search" aria-label="Music search" aria-describedby="search-hint" value={query} maxLength={maxLength} onChange={event => setQuery(event.target.value)} placeholder="Song, artist or link…" autoComplete="off" spellCheck={false} /></label>
      <button type="submit" className="button primary" disabled={searching || !typed || portal.connection !== 'live'}>{searching ? <span className="spinner" /> : <MagnifyingGlassIcon size={20} />}Search</button></form>
    <p id="search-hint" className="sr-only">Results update as you type. Links load when you choose Search or add them directly.</p>
    {!portal.can('add') && <p className="permission-note">{portal.blockedReason}</p>}
    {typed && <div className="import-actions"><span><LinkIcon size={18} />Add what you typed directly</span><button className="text-button" disabled={!enabled || !typed} onClick={() => void add(false, typed)}><PlusIcon size={17} />Add to queue</button><button className="text-button" disabled={!controllable || !typed} title={!controllable ? portal.blockedReason : undefined} onClick={() => void add(true, typed)}><ArrowBendUpRightIcon size={17} />Play next</button></div>}
    {hasAccess && typed && notice && <p className="notice-line" role="status">{notice}</p>}
    {portal.notice && <p className={`notice-line ${portal.notice.kind === 'error' ? 'warm-text' : ''}`} role={portal.notice.kind === 'error' ? 'alert' : 'status'}>{portal.notice.message}</p>}
    {error && <ErrorState message={error} retry={() => void search()} />}
    {!hasAccess ? <ErrorState message={portal.connectionError || "This listening space is unavailable. Reconnect to check access."} /> : !typed ? (picks.length || artists.length) ? <div className="search-suggestions">
      {artists.length > 0 && <section aria-labelledby="explore-heading"><div className="section-heading"><h3 id="explore-heading">Explore</h3><span>Search an artist</span></div>
        <ul className="suggestion-chips">{artists.map(artist => <li key={artist}><button type="button" className="suggestion-chip" onClick={() => explore(artist)}><SparkleIcon size={15} /><span>{artist}</span></button></li>)}</ul></section>}
      {picks.length > 0 && <section aria-labelledby="picks-heading"><div className="section-heading"><h3 id="picks-heading">Picked for you</h3><span>From your listening</span></div>
        <ul className="result-list">{picks.map(({ track, reason }) => row(track, reason, `pick:${track.id}`))}</ul></section>}
    </div> : null : <>
      {mine.length > 0 && <section className="search-results" aria-labelledby="mine-heading"><div className="section-heading"><h3 id="mine-heading">From your library</h3><span>{mine.length} {mine.length === 1 ? 'match' : 'matches'}</span></div>
        <ul className="result-list">{mine.map(track => row(track, track.source, `mine:${track.id}`))}</ul></section>}
      {searching && tracks === null ? <Loading label="Looking for your music…" /> : tracks === null ? null : tracks.length === 0 && !stale ? <Empty title="No tracks found" description={`Try another title or a supported public link${lastQuery ? ` instead of “${lastQuery}”` : ''}.`} /> : tracks.length === 0 ? null : <div className={`search-results${stale ? ' stale' : ''}`} aria-busy={searching}><div className="section-heading"><h3>Search results</h3><span>{searching ? 'Updating…' : `${tracks.length} found`}</span></div>
        <ul className="result-list">{tracks.map((track, index) => row(track, track.source, `${track.id}:${index}`))}</ul>
      </div>}
    </>}
  </>;
  // On a phone, Search is a page in the bottom navigation; on desktop it opens over the current page.
  return page ? <div className="search-page">{body}</div> : <Dialog title="Add music" onClose={onClose} className="search-dialog" initialFocusRef={input}>{body}</Dialog>;
}
