import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDownIcon, ArrowLineUpIcon, ArrowUpIcon, DotsThreeIcon, HeartIcon, ListNumbersIcon, PlayIcon, PlusIcon, RadioIcon, ThumbsDownIcon, TrashIcon, DotsSixVerticalIcon, VinylRecordIcon, XIcon } from '../icons';
import type { Track } from '../types';
import type { Portal } from '../usePortal';
import { time, totalTime } from '../format';
import { ActionPopover, Artwork, Avatar, Empty, IconButton } from './ui';
import { Pagination } from './Pagination';
import { saveByLink, useSavingFavorite } from '../favorites';
import { SaveSessionDialog } from './SessionMix';
import { startRadioCommand } from '../radio';
import './queue.css';

export function Queue({ portal, compact = false, onAdd }: { portal: Portal; compact?: boolean; onAdd: () => void }) {
  const { snapshot, library, run, can } = portal;
  const queue = snapshot?.session.queue || [];
  // Older bots omit suggestions; treat that as none.
  const suggested = snapshot?.session.suggestions || [];
  const [page, setPage] = useState(0);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [saveSession, setSaveSession] = useState(false);
  const drag = useRef<{ index: number; revision: string; guildId: string } | null>(null);
  const lift = useRef<Lift | null>(null);
  const local = portal.target === 'local';
  const savingFavorite = useSavingFavorite();
  const controllable = can('control');
  const editable = can('library');
  const duration = queue.reduce((sum, track) => sum + (track.isStream ? 0 : track.durationMs), 0);
  const pageSize = compact ? 15 : 50;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(queue.length / pageSize) - 1));
  const startIndex = currentPage * pageSize;
  useEffect(() => { setPage(0); drag.current = null; setDropIndex(null); }, [portal.guildId, compact]);
  useEffect(() => () => { if (lift.current) cancelAnimationFrame(lift.current.frame); }, []);
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);
  const changePage = (nextPage: number) => { setPage(nextPage); drag.current = null; setDropIndex(null); };
  const change = async (command: string, options: Record<string, number>, revision = snapshot?.revision) => {
    await run({ command, options, expectedRevision: revision }, 'control');
  };
  // The heart flips at once; a save names the visible position and revision from this tap.
  const favorite = (track: Track, position: number) => {
    const revision = snapshot?.revision;
    portal.favorite(track, local ? () => saveByLink(portal, track.uri) : () => run({ command: 'favorite', subcommand: 'add', options: { position }, expectedRevision: revision }, 'library'));
  };
  const moveTo = (from: { index: number; revision: string; guildId: string }, index: number) => {
    if (!snapshot || from.index === index || !controllable) return;
    if (from.revision !== snapshot.revision || from.guildId !== snapshot.guild.id) { portal.notify('The queue changed while you were moving this song. Review it and try again.', 'error'); return; }
    void change('move', { from: from.index + 1, to: index + 1 }, from.revision);
  };
  // Touch and pen reorder by holding the handle: the row follows the finger, the list scrolls at its
  // edges, and the song lands on the row under the finger. A mouse uses native drag and drop below.
  const place = (current: Lift) => {
    current.row.style.transform = `translateY(${current.y - current.startY + current.scroller.scrollTop - current.startScroll}px)`;
    const rows = Array.from(current.row.parentElement?.children || []) as HTMLElement[];
    const target = rows.findIndex(row => {
      const box = row.getBoundingClientRect(); const shift = row === current.row ? current.scroller.scrollTop - current.startScroll + current.y - current.startY : 0;
      return current.y >= box.top - shift && current.y < box.bottom - shift;
    });
    if (target >= 0) current.target = startIndex + target;
    setDropIndex(current.target !== current.index ? current.target : null);
  };
  const raise = (event: React.PointerEvent<HTMLElement>, index: number) => {
    if (event.pointerType === 'mouse' || !snapshot || !controllable || lift.current) return;
    event.preventDefault();
    const row = event.currentTarget.closest('li') as HTMLElement; const scroller = scrollerOf(row);
    event.currentTarget.setPointerCapture(event.pointerId);
    const current: Lift = { index, revision: snapshot.revision, guildId: snapshot.guild.id, pointer: event.pointerId, startY: event.clientY, y: event.clientY, startScroll: scroller.scrollTop, row, scroller, target: index, frame: 0 };
    lift.current = current; row.classList.add('lifted');
    const step = () => {
      const view = scroller === document.scrollingElement ? { top: 0, bottom: document.querySelector('.persistent-player')?.getBoundingClientRect().top ?? innerHeight } : scroller.getBoundingClientRect();
      const speed = current.y < view.top + 56 ? -Math.min(14, (view.top + 56 - current.y) / 4) : current.y > view.bottom - 56 ? Math.min(14, (current.y - view.bottom + 56) / 4) : 0;
      if (speed) { scroller.scrollTop += speed; place(current); }
      current.frame = requestAnimationFrame(step);
    };
    current.frame = requestAnimationFrame(step);
  };
  const follow = (event: React.PointerEvent<HTMLElement>) => { const current = lift.current; if (current?.pointer === event.pointerId) { current.y = event.clientY; place(current); } };
  const lower = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    const current = lift.current; if (current?.pointer !== event.pointerId) return;
    lift.current = null; cancelAnimationFrame(current.frame);
    current.row.classList.remove('lifted'); current.row.style.transform = ''; setDropIndex(null);
    if (commit) moveTo(current, current.target);
  };
  const startRadio = (track: Track) => { const command = startRadioCommand(track); if (command) void run(command, 'control'); };
  const radioButton = (track: Track, close: () => void) => local ? null : <button disabled={!controllable || !track.uri} onClick={() => { close(); startRadio(track); }}><RadioIcon />Start radio from this song</button>;
  return <section className={`queue ${compact ? 'queue-compact' : ''}`} aria-label={local ? 'Queue on this device' : 'Shared queue'}>
    <div className="section-heading"><div className="heading-line"><h2>Up Next</h2>{queue.length > 0 && <span className="count">{queue.length} {queue.length === 1 ? 'song' : 'songs'}{queue.length ? ` · ${totalTime(duration)}${queue.some(t => t.isStream) ? ' + live' : ''}` : ''}</span>}</div>
      {!compact && (snapshot?.session.fairQueue || snapshot?.session.current) && <div className="queue-heading-actions">
        {snapshot?.session.fairQueue && <span className="pill"><ListNumbersIcon size={16} />Taking turns</span>}
        {snapshot?.session.current && !local && <button type="button" className="text-button" disabled={!editable} onClick={() => setSaveSession(true)}><VinylRecordIcon size={19} />Save session as mix</button>}
      </div>}
    </div>
    {saveSession && <SaveSessionDialog portal={portal} onClose={() => setSaveSession(false)} />}
    {!queue.length && suggested.length ? <p className="queue-note">Nothing queued. Autoplay plays the suggestions below; anything you add plays first.</p>
      : !queue.length ? <Empty title="Nothing queued yet" description={snapshot?.session.current ? snapshot.session.radio ? 'Autoplay is choosing related songs to play next. Add a track and it plays first.' : 'The next song is up to you. Add a track, or turn on autoplay from the player menu to keep things going.' : snapshot?.savedSession.exists ? 'Resume your saved session above, or add a song to start fresh.' : local ? 'Search for a song or drop a public music link. It plays right here on this device.' : 'Search for a song or drop a public music link. Everyone listens together in Discord.'}
      action={<button className="button primary" disabled={!can('add')} title={!can('add') ? portal.blockedReason : undefined} onClick={onAdd}><PlusIcon size={19} />Add music</button>} /> : <>
      {!compact && <div className="queue-columns" aria-hidden="true"><span>#</span><span /><span>Song</span><span>Added by</span><span>Length</span><span /><span /></div>}
      <ol className="track-list" start={startIndex + 1}>
        {queue.slice(startIndex, startIndex + pageSize).map((track, pageIndex) => {
          const index = startIndex + pageIndex;
          const favoriteIndex = library?.favorites.findIndex(t => t.id === track.id) ?? -1;
          const isFavorite = favoriteIndex >= 0;
          const key = `${track.id}:${index}`;
          return <li key={key} className={`track-row ${dropIndex === index ? 'drop-target' : ''}`} data-track-id={track.id}
            onDragOver={event => { if (controllable && drag.current) { event.preventDefault(); setDropIndex(index); } }}
            onDrop={event => {
              event.preventDefault(); setDropIndex(null); const from = drag.current; drag.current = null;
              if (from) moveTo(from, index);
            }}>
            <span className="track-index">{index + 1}</span>
            <span className={`drag-handle ${controllable ? '' : 'disabled'}`} draggable={controllable} title={controllable ? 'Drag to reorder; the song menu also has keyboard controls' : portal.blockedReason}
              onPointerDown={event => raise(event, index)} onPointerMove={follow} onPointerUp={event => lower(event, true)} onPointerCancel={event => lower(event, false)}
              onDragStart={event => { if (!snapshot || !controllable || lift.current) { event.preventDefault(); return; } drag.current = { index, revision: snapshot.revision, guildId: snapshot.guild.id }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); }} onDragEnd={() => { drag.current = null; setDropIndex(null); }}><DotsSixVerticalIcon size={23} /></span>
            <div className="track-main"><Artwork track={track} /><div className="track-text"><strong title={track.title}>{track.title}</strong><span title={track.author}>{track.author}</span></div>
              {/* The two most common edits sit on the row with a pointer; the menu keeps the rest. */}
              {!compact && <span className="row-quick"><IconButton label={`Play ${track.title} next`} disabled={!controllable || index === 0} title={index === 0 ? 'Already next' : !controllable ? portal.blockedReason : 'Play next'} onClick={() => void change('move', { from: index + 1, to: 1 })}><ArrowLineUpIcon size={21} /></IconButton><IconButton label={`Remove ${track.title} from queue`} disabled={!controllable} title={!controllable ? portal.blockedReason : 'Remove from queue'} onClick={() => void change('remove', { position: index + 1 })}><XIcon size={21} /></IconButton></span>}</div>
            <div className={`requester ${track.suggested ? 'suggested-source' : ''}`}>{track.suggested ? <span>Autoplay pick</span> : track.requestedBy && <><Avatar url={track.requestedBy.avatarUrl} name={track.requestedBy.displayName} /><span>{track.requestedBy.displayName}</span></>}</div>
            <span className="track-duration">{track.isStream ? 'LIVE' : time(track.durationMs)}</span>
            {!compact && <IconButton className={isFavorite ? 'favorite active' : 'favorite'} label={isFavorite ? `Remove ${track.title} from favorites` : `Save ${track.title} to favorites`} aria-pressed={isFavorite}
              disabled={!editable || !library || savingFavorite} onClick={() => favorite(track, index + 1)}><HeartIcon size={23} weight={isFavorite ? 'fill' : 'regular'} /></IconButton>}
            <ActionPopover className="row-menu" label={`Song options for ${track.title}`} trigger={<DotsThreeIcon size={25} weight="bold" />}>
              {close => <>
                <p>{track.title}</p>
                <button disabled={!controllable} onClick={() => { close(); void change('skipto', { position: index + 1 }); }}><PlayIcon />Play now</button>
                <button disabled={!controllable || index === 0} onClick={() => { close(); void change('move', { from: index + 1, to: 1 }); }}><ArrowLineUpIcon />Play next</button>
                <button disabled={!controllable || index === 0} onClick={() => { close(); void change('move', { from: index + 1, to: index }); }}><ArrowUpIcon />Move up</button>
                <button disabled={!controllable || index === queue.length - 1} onClick={() => { close(); void change('move', { from: index + 1, to: index + 2 }); }}><ArrowDownIcon />Move down</button>
                {radioButton(track, close)}
                {<button className="menu-favorite" disabled={!editable || !library || savingFavorite} onClick={() => { close(); favorite(track, index + 1); }}><HeartIcon weight={isFavorite ? 'fill' : 'regular'} />{isFavorite ? 'Remove favorite' : 'Save to favorites'}</button>}
                <button className="danger-text" disabled={!controllable} onClick={() => { close(); void change('remove', { position: index + 1 }); }}><TrashIcon />Remove from queue</button>
                {!controllable && <small>{portal.blockedReason}</small>}
              </>}
            </ActionPopover>
          </li>;
        })}
      </ol>
      <Pagination page={currentPage} total={queue.length} pageSize={pageSize} onPageChange={changePage} label={compact ? 'Expanded queue pages' : 'Queue pages'} />
    </>}
    {suggested.length > 0 && <Suggestions portal={portal} tracks={suggested} compact={compact} radioButton={radioButton} />}
  </section>;
}

// Autoplay picks wait outside the queue: they play only after every queued song.
function Suggestions({ portal, tracks, compact, radioButton }: { portal: Portal; tracks: Track[]; compact: boolean; radioButton: (track: Track, close: () => void) => React.ReactNode }) {
  const { run, can } = portal;
  const headingId = useId();
  const addable = can('add');
  const controllable = can('control');
  const edit = (subcommand: 'promote' | 'remove' | 'less', track: Track, index: number) =>
    void run({ command: 'radio', subcommand, options: { position: index + 1 }, expectedTrackId: track.id }, subcommand === 'promote' ? 'add' : 'control');
  return <section className="suggested" aria-labelledby={headingId}>
    <div className="suggested-heading"><RadioIcon size={20} aria-hidden="true" /><h3 id={headingId}>Suggested</h3><span className="count">Autoplay · after your queue</span></div>
    <ul className="track-list suggested-list">
      {tracks.map((track, index) => <li key={`${track.id}:${index}`} className="track-row suggested-row" data-track-id={track.id}>
        <span className="track-index" aria-hidden="true"><RadioIcon size={16} /></span>
        {!compact && <span className="suggested-spacer" aria-hidden="true" />}
        <div className="track-main"><Artwork track={track} /><div className="track-text"><strong title={track.title}>{track.title}</strong><span title={track.author}>{track.author}</span></div></div>
        <div className="requester suggested-source"><span>Autoplay pick</span></div>
        {!compact && <span className="track-duration">{track.isStream ? 'LIVE' : time(track.durationMs)}</span>}
        <IconButton className="suggested-add" label={`Add ${track.title} to the queue`} disabled={!addable} title={!addable ? portal.blockedReason : `Add ${track.title} to the queue`} onClick={() => edit('promote', track, index)}><PlusIcon size={22} /></IconButton>
        <ActionPopover className="row-menu" label={`Suggestion options for ${track.title}`} trigger={<DotsThreeIcon size={25} weight="bold" />}>
          {close => <>
            <p>{track.title}</p>
            <button disabled={!addable} onClick={() => { close(); edit('promote', track, index); }}><PlusIcon />Add to queue</button>
            <button disabled={!controllable} onClick={() => { close(); edit('less', track, index); }}><ThumbsDownIcon />Less like this</button>
            {radioButton(track, close)}
            <button className="danger-text" disabled={!controllable} onClick={() => { close(); edit('remove', track, index); }}><XIcon />Remove suggestion</button>
            {!controllable && <small>{portal.blockedReason}</small>}
          </>}
        </ActionPopover>
      </li>)}
    </ul>
  </section>;
}

type Lift = { index: number; revision: string; guildId: string; pointer: number; startY: number; y: number; startScroll: number; row: HTMLElement; scroller: HTMLElement; target: number; frame: number };
function scrollerOf(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement || document.documentElement) as HTMLElement;
}
