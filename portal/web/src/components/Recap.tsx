import type { ReactNode } from 'react';
import { ArrowClockwiseIcon, WarningCircleIcon } from '../icons';
import type { Recap, RecapTotals, RecapWindow, Track } from '../types';
import { recapRead, useRead } from '../reads';
import { totalTime } from '../format';
import { Artwork, Loading } from './ui';

const windows: { id: RecapWindow; label: string }[] = [
  { id: '7d', label: 'Past week' }, { id: '30d', label: 'Past month' }, { id: '90d', label: 'Past 3 months' }, { id: '365d', label: 'Past year' },
];
const count = (value: number, one: string, many: string) => `${value.toLocaleString()} ${value === 1 ? one : many}`;
const ranked = 5;

// Totals and top lists for one window, read like the other stats. It loads on its
// own so a slow or failed recap never holds up the shelves above. Reads are held
// per range, so coming back to Home shows the last recap at once; numbers from
// another range or from before a clear never show under the new label.
// Home owns the range so it survives switching tabs, like the top-tracks range.
export function ListeningRecap({ viewer, guildId, range, onRange }: { viewer: string; guildId: string; range: RecapWindow; onRange: (range: RecapWindow) => void }) {
  const read = recapRead(viewer, guildId, range);
  const { value: recap, error, reload } = useRead<Recap>(read.key, read.fetch);

  const label = windows.find(item => item.id === range)!.label;
  const body = error && !recap
    ? <div className="home-unavailable" role="alert"><WarningCircleIcon size={24} aria-hidden="true" /><div><strong>Your listening recap can’t load right now</strong><p>{error}</p></div>
      <button className="button secondary" onClick={() => void reload()}><ArrowClockwiseIcon size={18} />Try again</button></div>
    : !recap ? <Loading label="Loading your listening recap…" />
    : !recap.personal.plays && !recap.server.plays ? <p className="home-empty">Nothing played in voice channels you can see in the {label.toLowerCase()}. Try a longer range.</p>
    : <div className="recap-grid">
      <RecapPart id="recap-you" title="Your requests" totals={recap.personal} countLabel="Requests"
        empty={!recap.personal.plays && `You haven’t requested songs here in the ${label.toLowerCase()}.`}>
        <RankedList title="Your top tracks" items={recap.personal.topTracks.slice(0, ranked).map(entry => ({ key: entry.track.id, track: entry.track, name: entry.track.title, detail: entry.track.author, plays: entry.plays }))} />
        <RankedList title="Your top artists" items={recap.personal.topArtists.slice(0, ranked).map(artist => ({ key: artist.name, track: artist.track, name: artist.name, detail: `Most requested: ${artist.track.title}`, plays: artist.plays }))} />
      </RecapPart>
      <RecapPart id="recap-server" title="This server" totals={recap.server} countLabel="Plays">
        <RankedList title="Server top tracks" items={recap.server.topTracks.slice(0, ranked).map(entry => ({ key: entry.track.id, track: entry.track, name: entry.track.title, detail: entry.track.author, plays: entry.plays }))} />
      </RecapPart>
    </div>;

  return <section className="home-shelf home-recap" aria-labelledby="home-listening-recap">
    <header className="home-shelf-header"><div><h2 id="home-listening-recap">Listening recap</h2>
      <p>Your own requests, and everything this server played, in voice channels you can see. Played time counts how long songs played, not who was listening.</p></div>
      <div className="home-shelf-actions"><label className="recap-range"><span className="sr-only">Recap range</span>
        <select value={range} onChange={event => onRange(event.target.value as RecapWindow)}>{windows.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label></div>
    </header>
    {body}
  </section>;
}

function RecapPart({ id, title, totals, countLabel, empty, children }: { id: string; title: string; totals: RecapTotals; countLabel: string; empty?: string | false; children: ReactNode }) {
  return <div className="recap-part" role="group" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <dl className="recap-tiles">
      <div><dt>{countLabel}</dt><dd>{totals.plays.toLocaleString()}</dd></div>
      <div><dt>Played time</dt><dd>{totalTime(totals.playedMs)}</dd></div>
      <div><dt>Songs</dt><dd>{totals.songs.toLocaleString()}</dd></div>
    </dl>
    {empty ? <p className="recap-empty">{empty}</p> : children}
  </div>;
}

function RankedList({ title, items }: { title: string; items: { key: string; track: Track; name: string; detail: string; plays: number }[] }) {
  if (!items.length) return null;
  return <div className="recap-list">
    <h4>{title}</h4>
    <ol aria-label={title}>{items.map((item, index) => <li key={item.key}>
      <span className="recap-rank" aria-hidden="true">{index + 1}</span>
      <Artwork track={item.track} className="recap-art" />
      <span className="recap-text"><strong dir="auto" title={item.name}>{item.name}</strong><span dir="auto" title={item.detail}>{item.detail}</span></span>
      <span className="recap-plays">{count(item.plays, 'play', 'plays')}</span>
    </li>)}</ol>
  </div>;
}
