import { useEffect, useRef, useState } from 'react';
import { ArrowBendUpRightIcon, LinkIcon, MagnifyingGlassIcon, PlusIcon, QueueIcon } from '@phosphor-icons/react';
import { api, errorMessage } from '../api';
import type { Track } from '../types';
import type { Portal } from '../usePortal';
import { time } from '../format';
import { Artwork, Dialog, Empty, ErrorState, Loading } from './ui';

export function Search({ portal, open, onClose, query, setQuery }: { portal: Portal; open: boolean; onClose: () => void; query: string; setQuery: (value: string) => void }) {
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState('');
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const latestGuild = useRef(portal.guildId);
  latestGuild.current = portal.guildId;
  const hasAccess = !!portal.snapshot;
  const maxLength = portal.bootstrap?.commands.find(c => c.name === 'play')?.options?.find(o => o.name === 'query')?.max_length || 200;
  useEffect(() => { controller.current?.abort(); sequence.current++; setTracks(null); setError(''); setNotice(null); setSearching(false); setLastQuery(''); }, [portal.guildId]);
  useEffect(() => {
    if (hasAccess) return;
    controller.current?.abort(); sequence.current++;
    setTracks(null); setNotice(null); setError(''); setSearching(false); setLastQuery('');
  }, [hasAccess]);
  useEffect(() => () => controller.current?.abort(), []);
  const search = async () => {
    if (!query.trim() || query.length > maxLength || portal.connection !== 'live' || !hasAccess) return;
    controller.current?.abort(); controller.current = new AbortController();
    const seq = ++sequence.current; const guild = portal.guildId;
    setSearching(true); setError('');
    try {
      const result = await api.search(guild, query.trim(), controller.current.signal);
      if (seq === sequence.current && latestGuild.current === guild) { setTracks(result.tracks); setNotice(result.notice); setLastQuery(query.trim()); }
    } catch (cause) { if (!controller.current?.signal.aborted && seq === sequence.current) setError(errorMessage(cause)); }
    finally { if (seq === sequence.current) setSearching(false); }
  };
  const add = (next: boolean, value: string) => portal.run({ command: next ? 'playnext' : 'play', options: { query: value } }, next ? 'control' : 'add');
  const enabled = portal.can('add') && !portal.pending.length;
  const controllable = portal.can('control') && !portal.pending.length;
  if (!open) return null;
  return <Dialog title="Add music" onClose={onClose} className="search-dialog" initialFocusRef={input}>
    <p className="dialog-intro">Find a song, artist, or album. Paste a supported public track or playlist link to import it.</p>
    <form onSubmit={event => { event.preventDefault(); void search(); }} className="search-form"><label className="search-field"><MagnifyingGlassIcon size={22} /><span className="sr-only">Music search</span><input ref={input} type="search" aria-label="Music search" value={query} maxLength={maxLength} onChange={event => setQuery(event.target.value)} placeholder="Song, artist, or music link…" /></label>
      <button type="submit" className="button primary" disabled={searching || !query.trim() || portal.connection !== 'live'}>{searching ? <span className="spinner" /> : <MagnifyingGlassIcon size={20} />}Search</button></form>
    <div className="import-actions"><span><LinkIcon size={18} />Have a link or exact query?</span><button className="text-button" disabled={!enabled || !query.trim()} onClick={() => void add(false, query.trim())}><PlusIcon size={17} />Add to queue</button><button className="text-button" disabled={!controllable || !query.trim()} title={!controllable ? portal.blockedReason : undefined} onClick={() => void add(true, query.trim())}><ArrowBendUpRightIcon size={17} />Play next</button></div>
    {!portal.can('add') && <p className="permission-note">{portal.blockedReason}</p>}
    {hasAccess && notice && <p className="notice-line" role="status">{notice}</p>}
    {portal.notice && <p className={`notice-line ${portal.notice.kind === 'error' ? 'warm-text' : ''}`} role={portal.notice.kind === 'error' ? 'alert' : 'status'}>{portal.notice.message}</p>}
    {error && <ErrorState message={error} retry={() => void search()} />}
    {!hasAccess ? <ErrorState message={portal.connectionError || "This listening space is unavailable. Reconnect to check access."} /> : searching ? <Loading label="Looking for your music…" /> : tracks === null ? <Empty title="Find something to play" description="Search for something you love. Imports and source availability are checked by Vybertron before anything joins the queue." icon={<QueueIcon size={30} />} /> : tracks.length === 0 ? <Empty title="No tracks found" description={`Try another title or a supported public link${lastQuery ? ` instead of “${lastQuery}”` : ''}.`} /> : <div className="search-results"><div className="section-heading"><h3>Search results</h3><span>{tracks.length} found</span></div>
      <ul className="result-list">{tracks.map((track, index) => <li key={`${track.id}:${index}`}><Artwork track={track} /><div className="track-text"><strong>{track.title}</strong><span>{track.author} · {track.source}</span></div><span className="result-length">{track.isStream ? 'Live' : time(track.durationMs)}</span><button className="button secondary add-result" disabled={!enabled || !track.uri} title={!track.uri ? 'This result has no public source reference' : !enabled ? portal.blockedReason : undefined} onClick={() => { if (track.uri) void add(false, track.uri); }}><PlusIcon size={19} /><span>Add</span></button></li>)}</ul>
    </div>}
  </Dialog>;
}
