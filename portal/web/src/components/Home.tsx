import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon, ArrowCounterClockwiseIcon, CaretUpIcon, PlayIcon, PlusIcon, ShuffleIcon, WarningCircleIcon } from '../icons';
import type { Portal } from '../usePortal';
import type { AutoPlaylist, Capability, Command, GuildSnapshot, Library, RecapWindow, Stats, StatsWindow, Track } from '../types';
import { api, errorMessage } from '../api';
import { clearReads, loadRead, statsRead, useRead } from '../reads';
import { date, totalTime } from '../format';
import { Artwork, Confirm, IconButton, Loading } from './ui';
import { dragScroll } from '../dragScroll';
import { ListeningRecap } from './Recap';
import { useEvent } from '../stable';
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
// portal state; stats are read on their own (started with the server, shared with
// Server favorites), so the Home tab never holds up the player and returning to it
// shows what it had at once.
export function Home({ portal, active, onOpenPlayer }: { portal: Portal; active: boolean; onOpenPlayer: () => void }) {
  const { guildId, snapshot, library, run, can, blockedReason, bootstrap, notify } = portal;
  const [statsWindow, setWindow] = useState<StatsWindow>('30d');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [recapWindow, setRecapWindow] = useState<RecapWindow>('30d');
  const viewer = bootstrap?.viewer.id;
  const read = viewer && guildId ? statsRead(viewer, guildId, statsWindow) : null;
  const { value, error, reload } = useRead<Stats>(read?.key ?? null, () => read!.fetch());
  // A new range or a re-read after a clear keeps the shelves it had until its own
  // read arrives; a failed read never falls back to them.
  const shown = useRef<{ guildId: string; stats: Stats } | null>(null);
  if (value) shown.current = { guildId, stats: value };
  const stats = value ?? (!error && shown.current?.guildId === guildId ? shown.current.stats : null);
  const ready = !!snapshot;
  const addable = can('add');

  useEffect(() => { setWindow('30d'); setRecapWindow('30d'); }, [guildId]);
  // Opening Home re-reads stats only when they're old; what's held shows meanwhile.
  useEffect(() => { if (active && read) void loadRead(read.key, read.fetch); }, [active, read?.key]);

  // The shelves are memoized; what they call keeps one identity and acts on the latest state.
  const act = useEvent((body: Command, capability: Capability, tracks?: Track[]) => void run(body, capability, tracks));
  const add = useEvent((track: Track) => { if (track.uri) void run({ command: 'play', options: { query: track.uri } }, 'add', [track]); });
  const retry = useEvent(() => void reload());
  const resume = useEvent(() => void run({ command: 'session', subcommand: 'resume', expectedRevision: snapshot?.revision }, 'resume'));

  if (!active) return <div className="home-view" hidden />;
  const disabledTitle = addable ? undefined : blockedReason;
  const session = snapshot?.session;

  return <div className="home-view">
    {/* Offline, the connection banner above already explains why controls wait. */}
    {ready && !can('add') && portal.connection === 'live' && <div className="permission-note"><WarningCircleIcon size={20} aria-hidden="true" /><span>{blockedReason} You can still browse; Play, Shuffle and Add unlock once you can add music.</span></div>}
    <ContinueListening current={session?.current || null} paused={session?.status === 'paused'} where={portal.target === 'local' ? ' on this device' : session?.voiceChannel ? ` in ${session.voiceChannel.name}` : ''}
      upNext={session?.queue.length || 0} saved={snapshot?.savedSession} history={library?.history} canResume={can('resume')} busy={portal.pending.includes('session:resume')}
      onResume={resume} onOpenPlayer={onOpenPlayer} add={add} disabled={!addable} title={disabledTitle} />
    <StatsShelves stats={stats} error={error} statsWindow={statsWindow} onWindow={setWindow} hasFavorites={!!library?.favorites.length} disabled={!addable} title={disabledTitle} run={act} add={add} retry={retry} />
    {ready && viewer && <ListeningRecap viewer={viewer} guildId={guildId} range={recapWindow} onRange={setRecapWindow} />}
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
          // Clearing touches every server, so every held read starts over.
          if (viewer) clearReads(`${viewer}:`);
        }).catch(failure => notify(errorMessage(failure), 'error')).finally(() => setClearing(false));
      }} />}
  </div>;
}

// Mixes and server favorites change only when stats load, so a live frame passes them by.
const StatsShelves = memo(function StatsShelves({ stats, error, statsWindow, onWindow, hasFavorites, disabled, title, run, add, retry }: {
  stats: Stats | null; error: string; statsWindow: StatsWindow; onWindow: (value: StatsWindow) => void; hasFavorites: boolean; disabled: boolean; title?: string;
  run: (body: Command, capability: Capability, tracks?: Track[]) => void; add: (track: Track) => void; retry: () => void;
}) {
  const playlists = stats?.personal.playlists || [];
  const mixes = playlists.filter(list => list.kind !== 'rediscover' && (list.tracks.length || list.kind === 'top'));
  const rediscover = stats?.personal.rediscover || [];
  return error && !stats
    ? <div className="home-unavailable" role="alert"><WarningCircleIcon size={24} aria-hidden="true" /><div><strong>Your mixes and server favorites can’t load right now</strong><p>{error} Continue listening above still works.</p></div>
      <button className="button secondary" onClick={retry}><ArrowClockwiseIcon size={18} />Try again</button></div>
    : !stats ? <Loading label="Loading your mixes and server favorites…" /> : <>
      <Shelf id="on-repeat" title="On repeat in this server" detail="What this server keeps coming back to, from sessions you can see."
        actions={stats.serverFavorites.onRepeat.length > 0 && <PlayShuffle label="On repeat" disabled={disabled} title={title}
          onPlay={shuffle => run({ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle } }, 'add', stats.serverFavorites.onRepeat.map(entry => entry.track))} />}
        empty={!stats.serverFavorites.onRepeat.length && 'Nothing on repeat yet. Songs collect here after they play in voice channels you can see.'}>
        {stats.serverFavorites.onRepeat.map((entry, index) => <TrackCard key={entry.track.id} track={entry.track} rank={index + 1} meta={`${entry.plays.toLocaleString()} ${entry.plays === 1 ? 'play' : 'plays'}`} disabled={disabled || !entry.track.uri} title={title} onAdd={() => add(entry.track)} />)}
      </Shelf>
      <Shelf id="your-mixes" title="Your mixes" detail="Built from the songs you request and the ones you heart. Only you see these."
        lead={!mixes.some(list => list.tracks.length) && <p className="home-empty">Your mixes fill in as you request songs in voice or heart them. A few requests are enough to start; try a longer range below if you’ve been away.</p>} wide>
        {mixes.map(list => <PlaylistTile key={list.id} list={list} detail={playlistDetail(list, statsWindow)} disabled={disabled} title={title}
          onPlay={shuffle => run(playlistCommand(list, statsWindow, shuffle), 'add', list.tracks)}
          range={list.kind === 'top' ? <label className="mix-range"><span className="sr-only">Time range for Your top tracks</span>
            <select value={statsWindow} onChange={event => onWindow(event.target.value as StatsWindow)}>{windows.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label> : null} />)}
      </Shelf>
      <Shelf id="rediscover" title="Rediscover" detail="Favorites you haven’t requested in a month, songs you used to request first."
        actions={rediscover.length > 0 && <PlayShuffle label="Rediscover" disabled={disabled} title={title}
          onPlay={shuffle => run({ command: 'mymix', subcommand: 'play', options: { playlist: 'rediscover', shuffle } }, 'add', rediscover.map(entry => entry.track))} />}
        empty={!rediscover.length && (hasFavorites ? 'You’ve requested every favorite this month. Favorites come back here after 30 days without a request.' : 'Heart songs you love. Once a month passes without requesting one, it comes back here.')}>
        {rediscover.map(entry => <TrackCard key={`${entry.index}:${entry.track.id}`} track={entry.track} meta={entry.lastRequestedAt ? `Requested ${date(entry.lastRequestedAt).split(",")[0]}` : 'Never requested'}
          disabled={disabled} title={title} onAdd={() => run({ command: 'favorite', subcommand: 'play', options: { index: entry.index }, expectedTrackId: entry.track.id }, 'add')} />)}
      </Shelf>
      <Shelf id="forgotten-gems" title="Forgotten gems" detail="Popular in this server two to four months ago, and quiet since."
        actions={stats.serverFavorites.forgottenGems.length > 0 && <PlayShuffle label="Forgotten gems" disabled={disabled} title={title}
          onPlay={shuffle => run({ command: 'top', subcommand: 'play', options: { list: 'forgotten-gems', shuffle } }, 'add', stats.serverFavorites.forgottenGems.map(entry => entry.track))} />}
        empty={!stats.serverFavorites.forgottenGems.length && 'No forgotten gems yet. Songs that were popular two to four months ago, with no plays since, appear here.'}>
        {stats.serverFavorites.forgottenGems.map(entry => <TrackCard key={entry.track.id} track={entry.track} meta={`${entry.plays.toLocaleString()} ${entry.plays === 1 ? 'play' : 'plays'} then`} disabled={disabled || !entry.track.uri} title={title} onAdd={() => add(entry.track)} />)}
      </Shelf>
      {error && <p className="library-note" role="alert">{error}</p>}
    </>;
});

// Renders again when the song, saved session or history changes, not when only the position moves.
const ContinueListening = memo(function ContinueListening({ current, paused, where, upNext, saved, history, canResume, busy, onResume, onOpenPlayer, add, disabled, title }: {
  current: Track | null; paused: boolean; where: string; upNext: number; saved?: GuildSnapshot['savedSession']; history?: Library['history']; canResume: boolean; busy: boolean;
  onResume: () => void; onOpenPlayer: () => void; add: (track: Track) => void; disabled: boolean; title?: string;
}) {
  const seen = new Set<string>();
  const recent = (history || []).filter(entry => !seen.has(entry.track.id) && seen.add(entry.track.id)).slice(0, 12);
  const resumable = !current && saved?.exists;
  const feature = current ? <div className="continue-feature">
    <Artwork track={current} className="continue-art" />
    <div className="continue-text"><span className="continue-state">{paused ? 'Paused' : 'Playing now'}{where}</span>
      <strong dir="auto" title={current.title}>{current.title}</strong><span dir="auto">{current.author}{upNext ? ` · ${upNext} up next` : ''}</span></div>
    <button type="button" className="button primary continue-open" onClick={onOpenPlayer}><CaretUpIcon size={18} weight="bold" /><span>View now playing</span></button>
  </div> : resumable && saved ? <div className="continue-feature">
    <span className="continue-art continue-art-saved" aria-hidden="true"><ArrowCounterClockwiseIcon size={30} /></span>
    <div className="continue-text"><span className="continue-state">Saved session</span>
      <strong>Pick up where you left off</strong>
      <span>{saved.trackCount} {saved.trackCount === 1 ? 'song' : 'songs'}{saved.voiceChannel ? ` in ${saved.voiceChannel.name}` : ''}{saved.savedAt ? ` · saved ${date(saved.savedAt)}` : ''}</span>
      {!canResume && <span className="continue-hint">{saved.voiceChannel ? `Join ${saved.voiceChannel.name} to resume. ` : ''}Resuming needs playback controls; anyone can start fresh.</span>}</div>
    <button type="button" className="button primary" disabled={!canResume || busy} onClick={onResume}><PlayIcon size={18} weight="fill" />Resume session</button>
  </div> : null;
  return <Shelf id="continue" title="Continue listening" detail="What’s playing now, and songs played recently in voice channels you can see."
    lead={feature}
    empty={!recent.length && !feature && (history ? 'Nothing to pick up yet. Songs played in voice channels you can see show up here, and a saved session appears when one is waiting.' : 'Loading your recent songs…')}>
    {recent.map(entry => <TrackCard key={entry.id} track={entry.track} meta={date(entry.playedAt).split(',')[0]} disabled={disabled || !entry.track.uri} title={title} onAdd={() => add(entry.track)} />)}
  </Shelf>;
});

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
