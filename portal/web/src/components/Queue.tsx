import { useRef, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, DotsThreeIcon, HeartIcon, ListNumbersIcon, PlayIcon, PlusIcon, TrashIcon, DotsSixVerticalIcon } from '@phosphor-icons/react';
import type { Track } from '../types';
import type { Portal } from '../usePortal';
import { time, totalTime } from '../format';
import { Artwork, Avatar, Empty, IconButton } from './ui';

export function Queue({ portal, compact = false, onAdd }: { portal: Portal; compact?: boolean; onAdd: () => void }) {
  const { snapshot, library, run, can, pending } = portal;
  const queue = snapshot?.session.queue || [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const drag = useRef<{ index: number; revision: string; guildId: string } | null>(null);
  const controllable = can('control') && !pending.length;
  const editable = can('library') && !pending.length;
  const duration = queue.reduce((sum, track) => sum + (track.isStream ? 0 : track.durationMs), 0);
  const change = async (command: string, options: Record<string, number>, revision = snapshot?.revision) => {
    setOpenId(null); await run({ command, options, expectedRevision: revision }, 'control');
  };
  const favorite = async (track: Track, position: number) => {
    const index = library?.favorites.findIndex(t => t.id === track.id) ?? -1;
    if (index >= 0) await run({ command: 'favorite', subcommand: 'remove', options: { index: index + 1 }, expectedTrackId: track.id }, 'library');
    else await run({ command: 'favorite', subcommand: 'add', options: { position }, expectedRevision: snapshot?.revision }, 'library');
  };
  return <section className={`queue ${compact ? 'queue-compact' : ''}`} aria-label="Shared queue">
    <div className="section-heading"><div className="heading-line"><h2>Up Next</h2><span className="count">{queue.length} {queue.length === 1 ? 'song' : 'songs'}{queue.length ? ` · ${totalTime(duration)}${queue.some(t => t.isStream) ? ' + live' : ''}` : ''}</span></div>
      {!compact && snapshot?.session.fairQueue && <span className="pill"><ListNumbersIcon size={16} />Taking turns</span>}
    </div>
    {!queue.length ? <Empty title="Make room for a good vibe" description={snapshot?.session.current ? 'The next song is up to you. Add a track or let artist radio keep things going.' : 'Search for a song or drop a public music link. Everyone listens together in Discord.'}
      action={<button className="button primary" disabled={!can('add')} title={!can('add') ? portal.blockedReason : undefined} onClick={onAdd}><PlusIcon size={19} />Add music</button>} /> : <>
      {!compact && <div className="queue-columns" aria-hidden="true"><span>#</span><span /><span>Song</span><span>Added by</span><span>Length</span><span /><span /></div>}
      <ol className="track-list">
        {queue.map((track, index) => {
          const favoriteIndex = library?.favorites.findIndex(t => t.id === track.id) ?? -1;
          const isFavorite = favoriteIndex >= 0;
          const key = `${track.id}:${index}`;
          return <li key={key} className={`track-row ${dropIndex === index ? 'drop-target' : ''}`} data-track-id={track.id}
            onDragOver={event => { if (controllable && drag.current) { event.preventDefault(); setDropIndex(index); } }}
            onDrop={event => {
              event.preventDefault(); setDropIndex(null); const from = drag.current; drag.current = null;
              if (!from || !snapshot || from.index === index || !controllable) return;
              if (from.revision !== snapshot.revision || from.guildId !== snapshot.guild.id) { portal.notify('The queue changed while you were moving this song. Review it and try again.', 'error'); return; }
              void change('move', { from: from.index + 1, to: index + 1 }, from.revision);
            }}>
            <span className="track-index">{index + 1}</span>
            {!compact && <span className={`drag-handle ${controllable ? '' : 'disabled'}`} draggable={controllable} title={controllable ? 'Drag to reorder; the song menu also has keyboard controls' : portal.blockedReason}
              onDragStart={event => { if (!snapshot || !controllable) { event.preventDefault(); return; } drag.current = { index, revision: snapshot.revision, guildId: snapshot.guild.id }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); }} onDragEnd={() => { drag.current = null; setDropIndex(null); }}><DotsSixVerticalIcon size={23} /></span>}
            <div className="track-main"><Artwork track={track} /><div className="track-text"><strong title={track.title}>{track.title}</strong><span title={track.author}>{track.author}</span></div></div>
            <div className="requester">{track.requestedBy && <><Avatar url={track.requestedBy.avatarUrl} name={track.requestedBy.displayName} /><span>{track.requestedBy.displayName}</span></>}</div>
            <span className="track-duration">{track.isStream ? 'LIVE' : time(track.durationMs)}</span>
            {!compact && <IconButton className={isFavorite ? 'favorite active' : 'favorite'} label={isFavorite ? `Remove ${track.title} from favorites` : `Save ${track.title} to favorites`} aria-pressed={isFavorite}
              disabled={!editable || !library} onClick={() => void favorite(track, index + 1)}><HeartIcon size={23} weight={isFavorite ? 'fill' : 'regular'} /></IconButton>}
            <div className="row-menu"><IconButton label={`Song options for ${track.title}`} aria-expanded={openId === key} onClick={() => setOpenId(openId === key ? null : key)}><DotsThreeIcon size={25} weight="bold" /></IconButton>
              {openId === key && <div className="menu-panel">
                <p>{track.title}</p>
                <button disabled={!controllable} onClick={() => void change('skipto', { position: index + 1 })}><PlayIcon />Play now</button>
                <button disabled={!controllable || index === 0} onClick={() => void change('move', { from: index + 1, to: index })}><ArrowUpIcon />Move up</button>
                <button disabled={!controllable || index === queue.length - 1} onClick={() => void change('move', { from: index + 1, to: index + 2 })}><ArrowDownIcon />Move down</button>
                {compact && <button disabled={!editable || !library} onClick={() => { setOpenId(null); void favorite(track, index + 1); }}><HeartIcon weight={isFavorite ? 'fill' : 'regular'} />{isFavorite ? 'Remove favorite' : 'Save to favorites'}</button>}
                <button className="danger-text" disabled={!controllable} onClick={() => void change('remove', { position: index + 1 })}><TrashIcon />Remove from queue</button>
                {!controllable && <small>{portal.blockedReason}</small>}
              </div>}
            </div>
          </li>;
        })}
      </ol>
      {!compact && <p className="queue-footnote">{queue.length} / 500 queued · Save a song to My Music with its heart.</p>}
    </>}
  </section>;
}
