import { ArrowClockwiseIcon, PlusIcon, ShuffleIcon, SparkleIcon } from '../icons';
import type { Portal } from '../usePortal';
import type { Stats, StatEntry, Track } from '../types';
import { statsRead, useRead } from '../reads';
import { Artwork, Empty, ErrorState, IconButton, Loading } from './ui';

type ListId = 'on-repeat' | 'forgotten-gems';
const lists: { id: ListId; key: keyof Stats['serverFavorites']; title: string; description: string; empty: string }[] = [
  { id: 'on-repeat', key: 'onRepeat', title: 'On repeat',
    description: 'The 25 songs this server keeps coming back to. Recent plays count most; replays by the same person and early skips count less.',
    empty: 'Nothing is on repeat yet. Songs appear after they play in voice channels you can see.' },
  { id: 'forgotten-gems', key: 'forgottenGems', title: 'Forgotten gems',
    description: 'Songs that were popular two to four months ago and haven’t played since.',
    empty: 'No forgotten gems yet. Songs that were popular two to four months ago, with no plays since, appear here.' },
];
const lastPlayed = (at: number) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at);

// Read on demand; stats never ride the live snapshot. Home reads the same past-month
// stats, so whichever opens first supplies the other.
export function ServerFavorites({ portal }: { portal: Portal }) {
  const { guildId, run, can, blockedReason, bootstrap } = portal;
  const read = bootstrap && guildId ? statsRead(bootstrap.viewer.id, guildId, '30d') : null;
  const { value, error, reload } = useRead<Stats>(read?.key ?? null, () => read!.fetch());
  const stats = value ?? null;
  const refresh = reload;
  const addable = can('add');

  const play = (list: ListId, shuffle: boolean) => run({ command: 'top', subcommand: 'play', options: { list, shuffle } }, 'add', stats?.serverFavorites[lists.find(item => item.id === list)!.key].map(entry => entry.track));

  if (error && !stats) return <ErrorState message={error} retry={() => void refresh()} />;
  if (!stats) return <Loading label="Loading server favorites…" />;
  const total = stats.serverFavorites.onRepeat.length + stats.serverFavorites.forgottenGems.length;
  return <div className="server-favorites">
    <div className="section-heading"><div><h2 className="sr-only">Popular in this server</h2>
      <p className="section-description">What {portal.snapshot?.guild.name || 'this server'} plays most, from sessions you can see. Add all or Add shuffled queues the whole list.</p></div>
      <IconButton label="Refresh server favorites" onClick={() => void refresh()}><ArrowClockwiseIcon size={21} /></IconButton>
    </div>
    {error && <p className="library-note" role="alert">{error}</p>}
    {!total ? <Empty title="Your server’s favorites start here" description="Play music together and the songs you keep coming back to will collect here." icon={<SparkleIcon size={30} />} />
      : lists.map(list => <ServerList key={list.id} title={list.title} description={list.description} empty={list.empty} entries={stats.serverFavorites[list.key]}
        disabled={!addable} blockedReason={blockedReason} onPlay={shuffle => void play(list.id, shuffle)} onAdd={track => { if (track.uri) void run({ command: 'play', options: { query: track.uri } }, 'add', [track]); }} />)}
    {!addable && total > 0 && <p className="library-note">{blockedReason}</p>}
  </div>;
}

function ServerList({ title, description, empty, entries, disabled, blockedReason, onPlay, onAdd }: {
  title: string; description: string; empty: string; entries: StatEntry[]; disabled: boolean; blockedReason: string; onPlay: (shuffle: boolean) => void; onAdd: (track: Track) => void;
}) {
  const headingId = `server-list-${title.replace(/\s+/g, '-').toLowerCase()}`;
  return <section className="server-list" aria-labelledby={headingId}>
    <header className="server-list-header">
      <div><h3 id={headingId}>{title}</h3><p>{description}</p></div>
      {entries.length > 0 && <div className="server-list-actions">
        <button type="button" className="button secondary" disabled={disabled} title={disabled ? blockedReason : undefined} aria-label={`Add all of ${title}`} onClick={() => onPlay(false)}><PlusIcon size={18} weight="bold" />Add all</button>
        <button type="button" className="button secondary" disabled={disabled} title={disabled ? blockedReason : undefined} aria-label={`Add ${title} shuffled`} onClick={() => onPlay(true)}><ShuffleIcon size={18} />Add shuffled</button>
      </div>}
    </header>
    {!entries.length ? <p className="library-note">{empty}</p> : <ol className="server-favorite-list">
      {entries.map((entry, index) => <li key={entry.track.id}>
        <span className="server-rank" aria-hidden="true">{index + 1}</span>
        <Artwork track={entry.track} />
        <div className="track-text"><strong dir="auto" title={entry.track.title}>{entry.track.title}</strong><span dir="auto">{entry.track.author}</span></div>
        <span className="server-plays">{entry.plays.toLocaleString()} {entry.plays === 1 ? 'play' : 'plays'}<span> · {lastPlayed(entry.lastPlayedAt)}</span></span>
        <IconButton label={`Add ${entry.track.title} to the queue`} disabled={disabled || !entry.track.uri} title={disabled ? blockedReason : `Add ${entry.track.title} to the queue`} onClick={() => onAdd(entry.track)}><PlusIcon size={21} weight="bold" /></IconButton>
      </li>)}
    </ol>}
  </section>;
}
