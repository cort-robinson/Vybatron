import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretUpIcon, PlayIcon, PlusIcon, ShuffleIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { AutoPlaylist, Command, RecapWindow, Stats, StatsWindow, Track } from '../types';
import { api, ApiError, errorMessage } from '../api';
import { date, totalTime } from '../format';
import { Artwork, Confirm, IconButton, Loading } from './ui';
import { dragScroll } from '../dragScroll';
import { ListeningRecap } from './Recap';
import './home.css';

const windows: { id: StatsWindow; label: string }[] = [
  { id: '7d', label: 'Past week' }, { id: '30d', label: 'Past month' }, { id: '90d', label: 'Past 3 months' }, { id: '365d', label: 'Past year' }, { id: 'all', label: 'All time' },
];
const weekday = (at: number) => new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(at);

function playlistDetail(list: AutoPlaylist, statsWindow: StatsWindow) {
  if (list.kind === 'mix') return `Your most-requested songs from the past 3 months blended with your favorites. New picks ${list.refreshesAt ? weekday(list.refreshesAt) : 'every week'}.`;
  if (list.kind === 'top') return `What you’ve requested most here · ${windows.find(item => item.id === statsWindow)?.label.toLowerCase()}.`;
  return `Your favorites by ${list.artist} and what this server plays most by them.`;
}
function playlistCommand(list: AutoPlaylist, statsWindow: StatsWindow, shuffle: boolean): Command {
  const options: Record<string, string | boolean> = { playlist: list.kind, shuffle };
  if (list.kind === 'artist' && list.artist) options.artist = list.artist;
  if (list.kind === 'top') options.window = statsWindow;
  return { command: 'mymix', subcommand: 'play', options };
}

// The landing surface for music. The session and library come from the live
// portal state; stats load separately once the first snapshot is in, so the
// Home tab never holds up the player.
export function Home({ portal, active, onOpenPlayer }: { portal: Portal; active: boolean; onOpenPlayer: () => void }) {
  const { guildId, snapshot, library, run, can, pending, blockedReason, bootstrap, notify } = portal;
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [statsWindow, setWindow] = useState<StatsWindow>('30d');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [recapVersion, setRecapVersion] = useState(0);
  const [recapWindow, setRecapWindow] = useState<RecapWindow>('30d');
  const controller = useRef<AbortController | null>(null);
  const ready = !!snapshot;
  const addable = can('add') && !pending.length;

  const refresh = useCallback(async (range: StatsWindow) => {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setError('');
    try {
      const next = await api.stats(guildId, range, request.signal);
      if (!request.signal.aborted) setStats(next);
    } catch (failure) {
      if (request.signal.aborted) return;
      // Lost access clears protected lists rather than leaving a stale view; an
      // unavailable store would refuse Play too, so it explains itself instead.
      if (failure instanceof ApiError && [401, 403, 404, 503].includes(failure.status)) setStats(null);
      setError(errorMessage(failure));
    }
  }, [guildId]);
  useEffect(() => { setStats(null); setError(''); setWindow('30d'); setRecapWindow('30d'); }, [guildId]);
  useEffect(() => {
    if (!active || !ready || !guildId) return;
    void refresh(statsWindow);
    return () => controller.current?.abort();
  }, [active, ready, guildId, statsWindow, refresh]);

  if (!active) return <div className="home-view" hidden />;
  const add = (track: Track) => track.uri && run({ command: 'play', options: { query: track.uri } }, 'add', [track]);
  const disabledTitle = addable ? undefined : blockedReason;
  const playlists = stats?.personal.playlists || [];
  const mixes = playlists.filter(list => list.kind !== 'rediscover' && (list.tracks.length || list.kind === 'top'));
  const rediscover = stats?.personal.rediscover || [];
  const statsShelves = error && !stats
    ? <div className="home-unavailable" role="alert"><WarningCircleIcon size={24} aria-hidden="true" /><div><strong>Your mixes and server favorites can’t load right now</strong><p>{error} Continue listening above still works.</p></div>
      <button className="button secondary" onClick={() => void refresh(statsWindow)}><ArrowClockwiseIcon size={18} />Try again</button></div>
    : !stats ? <Loading label="Loading your mixes and server favorites…" /> : <>
      <Shelf id="on-repeat" title="On repeat in this server" detail="What this server keeps coming back to, from sessions you can see."
        actions={stats.serverFavorites.onRepeat.length > 0 && <PlayShuffle label="On repeat" disabled={!addable} title={disabledTitle}
          onPlay={shuffle => void run({ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle } }, 'add', stats.serverFavorites.onRepeat.map(entry => entry.track))} />}
        empty={!stats.serverFavorites.onRepeat.length && 'Nothing on repeat yet. Songs collect here after they play in voice channels you can see.'}>
        {stats.serverFavorites.onRepeat.map((entry, index) => <TrackCard key={entry.track.id} track={entry.track} rank={index + 1} meta={`${entry.plays.toLocaleString()} ${entry.plays === 1 ? 'play' : 'plays'}`} disabled={!addable || !entry.track.uri} title={disabledTitle} onAdd={() => void add(entry.track)} />)}
      </Shelf>
      <Shelf id="your-mixes" title="Your mixes" detail="Built from the songs you request and the ones you heart. Only you see these."
        lead={!mixes.some(list => list.tracks.length) && <p className="home-empty">Your mixes fill in as you request songs in voice or heart them. A few requests are enough to start; try a longer range below if you’ve been away.</p>} wide>
        {mixes.map(list => <PlaylistTile key={list.id} list={list} detail={playlistDetail(list, statsWindow)} disabled={!addable} title={disabledTitle}
          onPlay={shuffle => void run(playlistCommand(list, statsWindow, shuffle), 'add', list.tracks)}
          range={list.kind === 'top' ? <label className="mix-range"><span className="sr-only">Time range for Your top tracks</span>
            <select value={statsWindow} onChange={event => setWindow(event.target.value as StatsWindow)}>{windows.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : null} />)}
      </Shelf>
      <Shelf id="rediscover" title="Rediscover" detail="Favorites you haven’t requested in a month, songs you used to request first."
        actions={rediscover.length > 0 && <PlayShuffle label="Rediscover" disabled={!addable} title={disabledTitle}
          onPlay={shuffle => void run({ command: 'mymix', subcommand: 'play', options: { playlist: 'rediscover', shuffle } }, 'add', rediscover.map(entry => entry.track))} />}
        empty={!rediscover.length && (library?.favorites.length ? 'You’ve requested every favorite this month. Favorites come back here after 30 days without a request.' : 'Heart songs you love. Once a month passes without requesting one, it comes back here.')}>
        {rediscover.map(entry => <TrackCard key={`${entry.index}:${entry.track.id}`} track={entry.track} meta={entry.lastRequestedAt ? `Requested ${date(entry.lastRequestedAt).split(",")[0]}` : 'Never requested'}
          disabled={!addable} title={disabledTitle} onAdd={() => void run({ command: 'favorite', subcommand: 'play', options: { index: entry.index }, expectedTrackId: entry.track.id }, 'add')} />)}
      </Shelf>
      <Shelf id="forgotten-gems" title="Forgotten gems" detail="Popular in this server two to four months ago, and quiet since."
        actions={stats.serverFavorites.forgottenGems.length > 0 && <PlayShuffle label="Forgotten gems" disabled={!addable} title={disabledTitle}
          onPlay={shuffle => void run({ command: 'top', subcommand: 'play', options: { list: 'forgotten-gems', shuffle } }, 'add', stats.serverFavorites.forgottenGems.map(entry => entry.track))} />}
        empty={!stats.serverFavorites.forgottenGems.length && 'No forgotten gems yet. Songs that were popular two to four months ago, with no plays since, appear here.'}>
        {stats.serverFavorites.forgottenGems.map(entry => <TrackCard key={entry.track.id} track={entry.track} meta={`${entry.plays.toLocaleString()} ${entry.plays === 1 ? 'play' : 'plays'} then`} disabled={!addable || !entry.track.uri} title={disabledTitle} onAdd={() => void add(entry.track)} />)}
      </Shelf>
      {error && <p className="library-note" role="alert">{error}</p>}
    </>;

  return <div className="home-view">
    {ready && !can('add') && <div className="permission-note"><WarningCircleIcon size={20} aria-hidden="true" /><span>{blockedReason} You can still browse; Play, Shuffle and Add unlock once you can add music.</span></div>}
    <ContinueListening portal={portal} onOpenPlayer={onOpenPlayer} add={add} disabled={!addable} title={disabledTitle} />
    {statsShelves}
    {ready && <ListeningRecap guildId={guildId} version={recapVersion} range={recapWindow} onRange={setRecapWindow} />}
    <section className="home-privacy" aria-labelledby="home-privacy-title">
      <div><h2 id="home-privacy-title">Your request stats</h2>
        <p>Your mixes, top tracks and Rediscover come from the songs you request. Clearing removes you from every request you’ve made, in every server. Server totals stay, anonymized, so On repeat and Forgotten gems keep their counts. Favorites, shared mixes and history aren’t touched. Vybatron never records who was listening, only who asked for a song.</p></div>
      <button type="button" className="button secondary danger-outline" disabled={!bootstrap || clearing} onClick={() => setConfirmClear(true)}>Clear my request stats</button>
    </section>
    {confirmClear && <Confirm title="Clear your request stats?" busy={clearing}
      detail="Removes your name from every song you’ve requested, in every server. Your mixes, top tracks and Rediscover start over. Server totals stay, anonymized; favorites, shared mixes and history stay as they are. This can’t be undone."
      action="Clear my stats" onClose={() => setConfirmClear(false)} onConfirm={() => {
        if (!bootstrap) return;
        setClearing(true);
        void api.clearRequestStats(bootstrap.csrfToken).then(result => {
          setConfirmClear(false);
          notify(result.cleared ? `Cleared you from ${result.cleared.toLocaleString()} ${result.cleared === 1 ? 'request' : 'requests'}. Server totals stay, anonymized.` : 'There were no requests to clear.', 'success');
          void refresh(statsWindow); setRecapVersion(value => value + 1);
        }).catch(failure => notify(errorMessage(failure), 'error')).finally(() => setClearing(false));
      }} />}
  </div>;
}

function ContinueListening({ portal, onOpenPlayer, add, disabled, title }: { portal: Portal; onOpenPlayer: () => void; add: (track: Track) => void; disabled: boolean; title?: string }) {
  const { snapshot, library, run, can, pending } = portal;
  const current = snapshot?.session.current;
  const saved = snapshot?.savedSession;
  const seen = new Set<string>();
  const recent = (library?.history || []).filter(entry => !seen.has(entry.track.id) && seen.add(entry.track.id)).slice(0, 12);
  const resumable = !current && saved?.exists;
  const feature = current ? <div className="continue-feature">
    <Artwork track={current} className="continue-art" />
    <div className="continue-text"><span className="continue-state">{snapshot?.session.status === 'paused' ? 'Paused' : 'Playing now'}{portal.target === 'local' ? ' on this device' : snapshot?.session.voiceChannel ? ` in ${snapshot.session.voiceChannel.name}` : ''}</span>
      <strong dir="auto" title={current.title}>{current.title}</strong><span dir="auto">{current.author}{snapshot?.session.queue.length ? ` · ${snapshot.session.queue.length} up next` : ''}</span></div>
    <button type="button" className="button primary continue-open" onClick={onOpenPlayer}><CaretUpIcon size={18} weight="bold" /><span>View now playing</span></button>
  </div> : resumable && saved ? <div className="continue-feature">
    <span className="continue-art continue-art-saved" aria-hidden="true"><ArrowCounterClockwiseIcon size={30} /></span>
    <div className="continue-text"><span className="continue-state">Saved session</span>
      <strong>Pick up where you left off</strong>
      <span>{saved.trackCount} {saved.trackCount === 1 ? 'song' : 'songs'}{saved.voiceChannel ? ` in ${saved.voiceChannel.name}` : ''}{saved.savedAt ? ` · saved ${date(saved.savedAt)}` : ''}</span>
      {!can('resume') && <span className="continue-hint">{saved.voiceChannel ? `Join ${saved.voiceChannel.name} to resume. ` : ''}Resuming needs playback controls; anyone can start fresh.</span>}</div>
    <button type="button" className="button primary" disabled={!can('resume') || !!pending.length} onClick={() => void run({ command: 'session', subcommand: 'resume', expectedRevision: snapshot?.revision }, 'resume')}><PlayIcon size={18} weight="fill" />Resume session</button>
  </div> : null;
  return <Shelf id="continue" title="Continue listening" detail="What’s playing now, and songs played recently in voice channels you can see."
    lead={feature}
    empty={!recent.length && !feature && (library ? 'Nothing to pick up yet. Songs played in voice channels you can see show up here, and a saved session appears when one is waiting.' : 'Loading your recent songs…')}>
    {recent.map(entry => <TrackCard key={entry.id} track={entry.track} meta={date(entry.playedAt).split(',')[0]} disabled={disabled || !entry.track.uri} title={title} onAdd={() => add(entry.track)} />)}
  </Shelf>;
}

function Shelf({ id, title, detail, actions, empty, lead, wide = false, children }: { id: string; title: string; detail: string; actions?: ReactNode; empty?: string | false; lead?: ReactNode; wide?: boolean; children?: ReactNode }) {
  const headingId = `home-${id}`;
  return <section className="home-shelf" aria-labelledby={headingId}>
    <header className="home-shelf-header"><div><h2 id={headingId}>{title}</h2><p>{detail}</p></div>{actions && <div className="home-shelf-actions">{actions}</div>}</header>
    {lead}
    {/* A sideways shelf is itself a tab stop, so the keyboard can scroll it even when its cards' buttons are disabled. */}
    {empty ? <p className="home-empty">{empty}</p> : <ol ref={dragScroll} tabIndex={0} className={`shelf-row ${wide ? 'shelf-row-wide' : ''}`} aria-label={title}>{children}</ol>}
  </section>;
}

function PlayShuffle({ label, disabled, title, onPlay }: { label: string; disabled: boolean; title?: string; onPlay: (shuffle: boolean) => void }) {
  return <>
    <button type="button" className="button primary" disabled={disabled} title={title} aria-label={`Play all of ${label}`} onClick={() => onPlay(false)}><PlayIcon size={18} weight="fill" />Play all</button>
    <button type="button" className="button secondary" disabled={disabled} title={title} aria-label={`Shuffle ${label}`} onClick={() => onPlay(true)}><ShuffleIcon size={18} />Shuffle</button>
  </>;
}

function TrackCard({ track, meta, rank, disabled, title, onAdd }: { track: Track; meta: string; rank?: number; disabled: boolean; title?: string; onAdd: () => void }) {
  return <li className="shelf-card">
    <div className="shelf-art"><Artwork track={track} />{rank !== undefined && <span className={`shelf-rank ${rank <= 3 ? 'lead' : ''}`} aria-label={`Rank ${rank}`}>{rank}</span>}</div>
    <div className="shelf-card-body"><div className="track-text"><strong dir="auto" title={track.title}>{track.title}</strong><span dir="auto" title={track.author}>{track.author}</span><small>{meta}</small></div>
      <IconButton label={`Add ${track.title} to the queue`} title={title || `Add ${track.title} to the queue`} disabled={disabled} onClick={onAdd}><PlusIcon size={21} weight="bold" /></IconButton></div>
  </li>;
}

function PlaylistTile({ list, detail, disabled, title, onPlay, range }: { list: AutoPlaylist; detail: string; disabled: boolean; title?: string; onPlay: (shuffle: boolean) => void; range: ReactNode }) {
  const covers = list.tracks.slice(0, 4);
  const empty = !list.tracks.length;
  const duration = list.tracks.reduce((sum, track) => sum + track.durationMs, 0);
  return <li className="playlist-tile">
    <div className={`playlist-cover ${covers.length >= 4 ? 'collage' : ''}`} aria-hidden="true">{covers.length >= 4 ? covers.map(track => <Artwork key={track.id} track={track} />) : <Artwork track={covers[0] || null} />}</div>
    <div className="playlist-body">
      <h3 dir="auto" title={list.title}>{list.title}</h3>
      <p className="playlist-meta">{empty ? 'No requests in this range' : `${list.tracks.length} ${list.tracks.length === 1 ? 'song' : 'songs'} · ${totalTime(duration)}`}</p>
      <p className="playlist-detail">{detail}</p>
      {range}
      <div className="playlist-actions">
        <button type="button" className="button primary" disabled={disabled || empty} title={title} aria-label={`Play ${list.title}`} onClick={() => onPlay(false)}><PlayIcon size={18} weight="fill" />Play</button>
        <IconButton label={`Shuffle ${list.title}`} title={title || `Shuffle ${list.title}`} disabled={disabled || empty} onClick={() => onPlay(true)}><ShuffleIcon size={21} /></IconButton>
      </div>
    </div>
  </li>;
}
