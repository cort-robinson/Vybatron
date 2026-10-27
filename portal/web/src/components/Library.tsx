import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwiseIcon, HeartIcon, PlayIcon, PlusIcon, RadioIcon, TrashIcon, VinylRecordIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { Track } from '../types';
import { date, time, totalTime } from '../format';
import { Artwork, Confirm, Empty, ErrorState, IconButton, Loading } from './ui';
import { Pagination } from './Pagination';
import { ServerFavorites } from './ServerFavorites';
import { PlaylistImport } from './PlaylistImport';
import { transition } from '../motion';
import { radioLabel, startRadioCommand } from '../radio';
import './library.css';

const sections = ['favorites', 'mixes', 'history', 'server'] as const;
type Section = typeof sections[number];
type ListSection = Exclude<Section, 'server'>;
const sectionLabels: Record<Section, string> = { favorites: 'Favorites', mixes: 'Shared mixes', history: 'History', server: 'Server favorites' };
const pageSize = 50;
const initialQueries = { favorites: '', mixes: '', history: '' };
const initialPages = { favorites: 0, mixes: 0, history: 0 };
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();
const mixKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
const trackMetadata = (track: Track) => `${track.title} ${track.author} ${track.source}`;
const matches = (metadata: string, query: string) => {
  const text = normalize(metadata);
  return normalize(query).split(/\s+/).every(term => text.includes(term));
};
const boundedPage = (page: number, total: number) => Math.max(0, Math.min(page, Math.ceil(total / pageSize) - 1));

type Confirmation = { kind: 'favorites' }
  | { kind: 'replace'; name: string; revision: string }
  | { kind: 'mix'; name: string; version: string };

export function LibraryView({ portal, active = true }: { portal: Portal; active?: boolean }) {
  const [tab, setTab] = useState<Section>('favorites');
  const [queries, setQueries] = useState(initialQueries);
  const [pages, setPages] = useState(initialPages);
  const [mixName, setMixName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [mixQuery, setMixQuery] = useState('');
  const [mixPage, setMixPage] = useState(0);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mixSearchRef = useRef<HTMLInputElement>(null);
  const { library, libraryError, run, can, pending, snapshot } = portal;
  const addable = can('add');
  const controllable = can('control');
  const editable = can('library');
  const namedMix = library?.mixes.find(mix => mixKey(mix.name) === mixKey(mixName));
  const canSave = editable && !!snapshot?.session.current;
  const selectedMix = library?.mixes.find(mix => mix.id === selected);
  useEffect(() => {
    setSelected(null); setConfirm(null); setQueries(initialQueries); setPages(initialPages); setMixQuery(''); setMixPage(0);
  }, [portal.guildId]);

  // Retain source positions before searching or paging; server commands address the original shelf.
  const favorites = useMemo(() => !active || tab !== 'favorites' ? [] : (library?.favorites || [])
    .map((track, index) => ({ track, index })).filter(({ track }) => matches(trackMetadata(track), queries.favorites)), [active, tab, library?.favorites, queries.favorites]);
  const history = useMemo(() => !active || tab !== 'history' ? [] : (library?.history || [])
    .map((entry, index) => ({ entry, index })).filter(({ entry }) => matches(`${trackMetadata(entry.track)} ${entry.voiceChannel?.name || ''}`, queries.history)), [active, tab, library?.history, queries.history]);
  const mixes = useMemo(() => !active || tab !== 'mixes' ? [] : (library?.mixes || [])
    .filter(mix => matches(`${mix.name} ${mix.tracks.map(trackMetadata).join(' ')}`, queries.mixes)), [active, tab, library?.mixes, queries.mixes]);
  const mixTracks = useMemo(() => !active || tab !== 'mixes' ? [] : (selectedMix?.tracks || [])
    .map((track, index) => ({ track, index })).filter(({ track }) => matches(trackMetadata(track), mixQuery)), [active, tab, selectedMix?.tracks, mixQuery]);
  // Server favorites are two short ranked lists with no search or paging.
  const listTab: ListSection = tab === 'server' ? 'favorites' : tab;
  const total = tab === 'favorites' ? favorites.length : tab === 'history' ? history.length : mixes.length;
  const currentPage = boundedPage(pages[listTab], total);
  const currentMixPage = boundedPage(mixPage, mixTracks.length);
  const offset = currentPage * pageSize;
  const label = tab === 'favorites' ? 'favorites' : tab === 'history' ? 'listening history' : 'shared mixes';
  const setQuery = (value: string) => { setQueries(previous => ({ ...previous, [listTab]: value })); setPages(previous => ({ ...previous, [listTab]: 0 })); };
  const clearSearch = () => { setQuery(''); searchRef.current?.focus(); };
  const save = async (name: string, replace: boolean, revision = snapshot?.revision) => {
    if (await run({ command: 'mix', subcommand: 'save', options: { name, replace }, expectedRevision: revision }, 'library')) {
      setMixName(previous => mixKey(previous) === mixKey(name) ? '' : previous); setConfirm(null);
    }
  };
  const selectTab = (next: Section) => { if (next !== tab) transition('tab', () => setTab(next), sections.indexOf(next) < sections.indexOf(tab) ? 'back' : 'forward'); };
  const openMix = (id: string) => { setSelected(selected === id ? null : id); setMixQuery(''); setMixPage(0); };
  const noMatches = <Empty title={`No matching ${label}`} description={tab === 'mixes' ? 'Try a mix name, song, or artist.' : 'Try a song, artist, or source.'}
    action={<button type="button" className="button secondary" onClick={clearSearch}>Clear search</button>} />;

  // A paused cache keeps drafts and filters, but mounts no heavy list or modal.
  if (!active) return <div className="library-view" hidden />;
  return <div className="library-view"><div className="tabs" role="tablist" aria-label="My music sections">
    {sections.map(section => <button type="button" key={section} role="tab" id={`tab-${section}`} aria-selected={tab === section} aria-controls={`panel-${section}`} tabIndex={tab === section ? 0 : -1}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const index = sections.indexOf(tab);
        const next = event.key === 'Home' ? sections[0] : event.key === 'End' ? sections[sections.length - 1] : sections[(index + (event.key === 'ArrowRight' ? 1 : sections.length - 1)) % sections.length];
        selectTab(next); document.getElementById(`tab-${next}`)?.focus();
      }} onClick={() => selectTab(section)}>{tab === section && <span className="tab-indicator" aria-hidden="true" />}{sectionLabels[section]}{library && section !== 'server' && <span>{library[section].length.toLocaleString()}</span>}</button>)}
  </div>
  {tab === 'server' ? <section role="tabpanel" id="panel-server" aria-labelledby="tab-server"><ServerFavorites portal={portal} /></section>
  : libraryError ? <ErrorState message={libraryError} retry={() => void portal.refreshLibrary()} /> : !library ? <Loading label="Loading your music…" /> : <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
    <div className="section-heading"><div><h2 className="sr-only">{tab === 'favorites' ? 'Favorites' : tab === 'mixes' ? 'Shared mixes' : 'Listening history'}</h2>
      <p className="section-description">{tab === 'favorites' ? 'Your private songs, across every server.' : tab === 'mixes' ? `Saved for ${snapshot?.guild.name || 'this server'}. Up to 100 songs per mix.` : 'The latest 100 songs from the past 30 days, from sessions you can see.'}</p></div>
      {tab === 'history' && <IconButton label="Refresh listening history" onClick={() => void portal.refreshLibrary()}><ArrowClockwiseIcon size={21} /></IconButton>}
    </div>
    <div className="library-search"><label className="sr-only" htmlFor={`library-search-${tab}`}>Search {label}</label><div className="library-search-controls">
      <input ref={searchRef} id={`library-search-${tab}`} type="search" dir="auto" value={queries[listTab]} maxLength={200} placeholder={`Search ${label}`} onChange={event => setQuery(event.target.value)} />
      {queries[listTab] && <button type="button" className="text-button" onClick={clearSearch}>Clear search</button>}
    </div></div>
    {tab === 'favorites' && <>
      {!library.favorites.length ? <Empty title="A place for your repeat favorites" description="Tap the heart on the current song to keep it here. Only you can see this shelf." icon={<HeartIcon size={30} />} /> : !favorites.length ? noMatches : <ul className="library-track-list" aria-label="Favorite songs">{favorites.slice(offset, offset + pageSize).map(({ track, index }) => <li key={`${track.id}:${index}`}>
        <Artwork track={track} /><div className="track-text"><strong dir="auto" title={track.title}>{track.title}</strong><span dir="auto">{track.author}<span className="track-source"> · {track.source}</span></span></div><span className="track-duration">{track.isStream ? 'Live' : time(track.durationMs)}</span>
        <IconButton label={`Queue favorite ${track.title}`} disabled={!addable} title={!addable ? portal.blockedReason : undefined} onClick={() => void run({ command: 'favorite', subcommand: 'play', options: { index: index + 1 }, expectedTrackId: track.id }, 'add')}><PlusIcon size={23} /></IconButton>
        <RadioButton portal={portal} track={track} />
        <IconButton className="favorite active" label={`Remove favorite ${track.title}`} disabled={!editable} onClick={() => portal.favorite(track, async () => false)}><HeartIcon size={23} weight="fill" /></IconButton>
      </li>)}</ul>}
      <Pagination label="favorites" page={currentPage} total={favorites.length} pageSize={pageSize} onPageChange={page => setPages(previous => ({ ...previous, favorites: page }))} />
      <PlaylistImport portal={portal} target="favorites" />
      {library.favorites.length > 0 && <button type="button" className="text-button danger-text library-clear" disabled={!editable} onClick={() => setConfirm({ kind: 'favorites' })}>Clear favorites</button>}
      {library.favorites.length >= 1000 && <p className="library-note">Your shelf is full. Remove a favorite to make room for another song.</p>}
      {!addable && <p className="library-note">{portal.blockedReason}</p>}
    </>}
    {tab === 'mixes' && <>
      {!library.mixes.length ? <Empty title="Build a soundtrack together" description="Save a great listening session and bring it back whenever the mood fits." icon={<VinylRecordIcon size={30} />} /> : !mixes.length ? noMatches : <div className="mixes-grid">{mixes.slice(offset, offset + pageSize).map(mix => <article className={`mix-tile ${selected === mix.id ? 'selected' : ''}`} key={mix.id}>
        <button type="button" className="mix-open" aria-label={`View mix ${mix.name}`} aria-expanded={selected === mix.id} aria-controls={selected === mix.id ? 'library-mix-detail' : undefined} onClick={() => openMix(mix.id)}><div className="mix-art"><Artwork track={mix.tracks[0] || null} /></div><h3 dir="auto" title={mix.name}>{mix.name}</h3><p>{mix.tracks.length} songs · {totalTime(mix.tracks.reduce((sum, track) => sum + track.durationMs, 0))}</p></button>
        <div className="mix-actions"><button type="button" className="text-button" disabled={!addable} title={!addable ? portal.blockedReason : undefined} onClick={() => void run({ command: 'mix', subcommand: 'load', options: { name: mix.name } }, 'add')}><PlayIcon size={18} weight="fill" />Queue mix</button>
          {mix.canEdit && <IconButton label={`Delete mix ${mix.name}`} disabled={!editable} onClick={() => setConfirm({ kind: 'mix', name: mix.name, version: mix.version })}><TrashIcon size={19} /></IconButton>}</div>
        {mix.canEdit && <button type="button" className="text-button mix-replace" aria-label={`Replace mix ${mix.name} with this session`} disabled={!canSave} onClick={() => { if (snapshot) setConfirm({ kind: 'replace', name: mix.name, revision: snapshot.revision }); }}>Replace with session</button>}
      </article>)}</div>}
      <Pagination label="shared mixes" page={currentPage} total={mixes.length} pageSize={pageSize} onPageChange={page => setPages(previous => ({ ...previous, mixes: page }))} />
      {selectedMix && <section className="mix-detail" id="library-mix-detail" aria-label={`Songs in ${selectedMix.name}`}><div className="section-heading"><h3 dir="auto">{selectedMix.name}</h3><button type="button" className="text-button" onClick={() => setSelected(null)}>Close songs</button></div>
        <div className="library-search"><label htmlFor="library-mix-search">Search songs in this mix</label><input ref={mixSearchRef} id="library-mix-search" type="search" dir="auto" value={mixQuery} maxLength={200} placeholder="Song, artist, or source" onChange={event => { setMixQuery(event.target.value); setMixPage(0); }} /></div>
        {!mixTracks.length ? <Empty title="No matching songs" description="Try another song or artist in this mix." action={<button type="button" className="button secondary" onClick={() => { setMixQuery(''); setMixPage(0); mixSearchRef.current?.focus(); }}>Clear song search</button>} /> : <ol className="mix-track-list">{mixTracks.slice(currentMixPage * pageSize, (currentMixPage + 1) * pageSize).map(({ track, index }) => <li key={`${track.id}:${index}`} value={index + 1}><span>{index + 1}</span><Artwork track={track} /><div className="track-text"><strong dir="auto" title={track.title}>{track.title}</strong><span dir="auto">{track.author}</span></div><span>{track.isStream ? 'Live' : time(track.durationMs)}</span></li>)}</ol>}
        <Pagination label="mix songs" page={currentMixPage} total={mixTracks.length} pageSize={pageSize} onPageChange={setMixPage} />
      </section>}
      {/* The mixes come first; saving and importing new ones follow, as on Favorites. */}
      <form className="mix-save-form mix-create" onSubmit={event => {
        event.preventDefault(); if (!canSave || !mixName.trim() || namedMix && !namedMix.canEdit) return;
        if (namedMix && snapshot) setConfirm({ kind: 'replace', name: namedMix.name, revision: snapshot.revision });
        else void save(mixName.trim(), false);
      }}><label>Save this session as a mix<input value={mixName} dir="auto" onChange={event => setMixName(event.target.value)} maxLength={40} placeholder="Late night drive" /></label>
        <button className="button secondary" disabled={!canSave || !mixName.trim() || !!namedMix && !namedMix.canEdit}><PlusIcon size={20} />{namedMix ? 'Replace mix' : 'Save mix'}</button></form>
      <p className="library-note">{namedMix && !namedMix.canEdit ? 'That name belongs to another saved mix. Choose a new name to save yours.' : !snapshot?.session.current ? 'Start a listening session to save its current song and queue.' : 'Save the current song and queue. You can save outside voice; queuing a mix needs voice access.'}</p>
      <PlaylistImport portal={portal} target="mix" />
      {!addable && <p className="library-note">{portal.blockedReason}</p>}
    </>}
    {tab === 'history' && <>
      {!library.history.length ? <Empty title="Your server’s story starts here" description="Songs appear after they play in a visible voice channel." /> : !history.length ? noMatches : <ul className="history-list" aria-label="Recently played songs">{history.slice(offset, offset + pageSize).map(({ entry, index }) => <li key={entry.id}>
        <Artwork track={entry.track} /><div className="track-text"><strong dir="auto" title={entry.track.title}>{entry.track.title}</strong><span dir="auto">{entry.track.author}{entry.voiceChannel ? ` · ${entry.voiceChannel.name}` : ''}</span></div><time dateTime={new Date(entry.playedAt).toISOString()}>{date(entry.playedAt)}</time>
        <IconButton label={`Replay ${entry.track.title}`} disabled={!controllable} title={!controllable ? portal.blockedReason : undefined} onClick={() => void run({ command: 'replay', options: { index: index + 1 }, expectedHistoryId: entry.id, expectedRevision: snapshot?.revision }, 'control')}><PlusIcon size={23} /></IconButton>
        <RadioButton portal={portal} track={entry.track} />
      </li>)}</ul>}
      <Pagination label="listening history" page={currentPage} total={history.length} pageSize={pageSize} onPageChange={page => setPages(previous => ({ ...previous, history: page }))} />
      {!controllable && <p className="library-note">{portal.blockedReason}</p>}
    </>}
  </section>}
  {confirm && <Confirm title={confirm.kind === 'favorites' ? 'Clear your favorites?' : confirm.kind === 'replace' ? `Replace “${confirm.name}”?` : `Delete “${confirm.name}”?`}
    detail={confirm.kind === 'favorites' ? 'Removes every song from your private shelf across all servers. Shared mixes and the queue stay in place.' : confirm.kind === 'replace' ? 'Replace the songs in this shared mix with the current song and queue. Only its creator or a server manager can replace it.' : 'Removes this shared mix from the server. The live queue stays in place.'}
    action={confirm.kind === 'replace' ? 'Replace mix' : confirm.kind === 'favorites' ? 'Clear favorites' : 'Delete mix'} busy={pending.includes(confirm.kind === 'favorites' ? 'favorite:clear' : confirm.kind === 'replace' ? 'mix:save' : 'mix:delete') || !editable || confirm.kind === 'replace' && !snapshot?.session.current}
    onClose={() => setConfirm(null)} onConfirm={() => {
      if (confirm.kind === 'replace') void save(confirm.name, true, confirm.revision);
      else void run(confirm.kind === 'favorites' ? { command: 'favorite', subcommand: 'clear', options: { confirm: true } } : { command: 'mix', subcommand: 'delete', options: { name: confirm.name }, expectedMixVersion: confirm.version }, 'library').then(ok => { if (ok) setConfirm(null); });
    }} />}
  </div>;
}

// Seeds autoplay from a saved song. Needs a live session and playback control.
function RadioButton({ portal, track }: { portal: Portal; track: Track }) {
  if (portal.target === 'local') return null;
  const command = startRadioCommand(track);
  const enabled = !!command && portal.can('control');
  return <IconButton className="radio-start" label={radioLabel(track)} disabled={!enabled} title={!command ? 'This song has no public source reference' : !enabled ? portal.blockedReason : radioLabel(track)}
    onClick={() => { if (command) void portal.run(command, 'control'); }}><RadioIcon size={22} /></IconButton>;
}
