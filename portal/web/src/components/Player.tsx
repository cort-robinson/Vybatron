import { useEffect, useState } from 'react';
import { CaretDownIcon, CaretUpIcon, HeartIcon, PauseIcon, PlayIcon, RepeatIcon, RepeatOnceIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, StopIcon, RadioIcon, HandPalmIcon, ArrowSquareOutIcon, TrashIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { Command } from '../types';
import { publicUrl } from '../api';
import { time, timestamp } from '../format';
import { Artwork, Confirm, IconButton } from './ui';
import { Queue } from './Queue';

export function Player({ portal, expanded, setExpanded, onAdd }: { portal: Portal; expanded: boolean; setExpanded: (value: boolean) => void; onAdd: () => void }) {
  const { snapshot, bootstrap, can, run, receivedAt, connection, pending, library } = portal;
  const session = snapshot?.session;
  const track = session?.current || null;
  const [clock, setClock] = useState(Date.now());
  const [scrub, setScrub] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!track || session?.status !== 'playing' || connection !== 'live' || document.hidden) return;
    const timer = setInterval(() => { if (!document.hidden) setClock(Date.now()); }, 500);
    return () => clearInterval(timer);
  }, [track?.id, session?.status, connection]);
  useEffect(() => { setScrub(null); setVolumeDraft(null); setClock(Date.now()); }, [track?.id, snapshot?.guild.id]);
  const duration = session?.durationMs || track?.durationMs || 0;
  const position = Math.min(duration || Infinity, Math.max(0, (session?.positionMs || 0) + (session?.status === 'playing' && connection === 'live' ? Math.max(0, clock - receivedAt) : 0)));
  const controllable = can('control') && !pending.length;
  const seekable = controllable && !!track && !track.isStream && duration > 0 && !['recovering', 'unavailable'].includes(session?.status || '');
  const control = (body: Command) => run({ ...body, expectedRevision: snapshot?.revision }, 'control');
  const index = library?.favorites.findIndex(t => t.id === track?.id) ?? -1;
  const toggleFavorite = () => index < 0 ? run({ command: 'favorite', subcommand: 'add', expectedRevision: snapshot?.revision }, 'library') : run({ command: 'favorite', subcommand: 'remove', options: { index: index + 1 }, expectedTrackId: library?.favorites[index].id }, 'library');
  const active = session?.status === 'playing';
  const blockedTitle = !controllable ? portal.blockedReason : undefined;
  const sourceUrl = publicUrl(track?.uri);
  const identity = <div className="player-identity"><div className="player-title-row"><h2 title={track?.title}>{track?.title || 'Your next good vibe'}</h2>
    {track && <IconButton className={`favorite ${index >= 0 ? 'active' : ''}`} label={index >= 0 ? 'Remove current song from favorites' : 'Save current song to favorites'} aria-pressed={index >= 0} disabled={!can('library') || !library || !!pending.length} onClick={() => void toggleFavorite()}><HeartIcon size={expanded ? 28 : 25} weight={index >= 0 ? 'fill' : 'regular'} /></IconButton>}
    </div><p>{track ? <>{track.author}<span className="metadata-dot">·</span>{track.source}</> : 'Add music. Listen together in Discord.'}</p>
  </div>;
  const seek = () => { if (scrub === null) return; const value = scrub; setScrub(null); if (seekable) void control({ command: 'seek', options: { timestamp: timestamp(value) } }); };
  const timeline = <div className={`timeline ${track?.isStream ? 'is-live' : ''}`}>
    <span>{track?.isStream ? 'LIVE' : time(scrub ?? position)}</span>
    <input className="range seek-range" aria-label="Playback position" type="range" min={0} max={duration || 1} step={1000} value={scrub ?? Math.min(position, duration || 1)} disabled={!seekable}
      aria-valuetext={track?.isStream ? 'Live stream' : `${time(scrub ?? position)} of ${time(duration)}`}
      style={{ '--range-progress': `${Math.min(100, ((scrub ?? position) / (duration || 1)) * 100)}%` } as React.CSSProperties}
      onChange={event => setScrub(Number(event.target.value))} onPointerUp={seek} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) seek(); }} onBlur={seek} />
    <span>{track?.isStream ? 'Streaming' : time(duration)}</span>
  </div>;
  const controls = <div className="transport">
    <IconButton label="Shuffle queue" disabled={!controllable || !session?.queue.length} title={blockedTitle} onClick={() => void control({ command: 'shuffle' })}><ShuffleIcon size={24} /></IconButton>
    <IconButton label="Restart current song" disabled={!seekable} title={blockedTitle} onClick={() => void control({ command: 'seek', options: { timestamp: '00:00' } })}><SkipBackIcon size={27} weight="fill" /></IconButton>
    <IconButton className={`play-button ${session?.status === 'paused' || session?.status === 'recovering' ? 'settled' : ''}`} label={active ? 'Pause playback' : 'Resume playback'} disabled={!controllable || !track || !['playing', 'paused'].includes(session?.status || '')} title={blockedTitle}
      onClick={() => void control({ command: active ? 'pause' : 'resume' })}>{pending.some(k => k.startsWith('pause:') || k.startsWith('resume:')) ? <span className="spinner" /> : active ? <PauseIcon size={31} weight="fill" /> : <PlayIcon size={31} weight="fill" />}</IconButton>
    <IconButton label="Skip current song" disabled={!controllable || !track} title={blockedTitle} onClick={() => void control({ command: 'skip' })}><SkipForwardIcon size={27} weight="fill" /></IconButton>
    <IconButton label={`Repeat: ${session?.repeat || 'off'}. Change repeat mode`} className={session?.repeat !== 'off' && session?.repeat ? 'active-control' : ''} disabled={!controllable || !track} title={blockedTitle}
      onClick={() => void control({ command: 'loop', options: { mode: session?.repeat === 'off' ? 'track' : session?.repeat === 'track' ? 'queue' : 'off' } })}>{session?.repeat === 'track' ? <RepeatOnceIcon size={25} /> : <RepeatIcon size={25} />}</IconButton>
  </div>;
  const extras = <div className="player-extras">
    <div className="volume-control"><SpeakerHighIcon size={23} /><input className="range" aria-label="Volume" type="range" min="0" max="100" value={volumeDraft ?? session?.volume ?? 100} disabled={!controllable}
      style={{ '--range-progress': `${volumeDraft ?? session?.volume ?? 100}%` } as React.CSSProperties} aria-valuetext={`${volumeDraft ?? session?.volume ?? 100} percent`}
      onChange={event => setVolumeDraft(Number(event.target.value))}
      onPointerUp={() => { if (volumeDraft !== null) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }}
      onKeyUp={event => { if (volumeDraft !== null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }}
      onBlur={() => { if (volumeDraft !== null) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }} /></div>
    <label className={`filter-control ${session?.filter === 'warm' ? 'warm' : ''}`}><span className="filter-dot" /><span className="sr-only">Audio filter</span><select aria-label="Audio filter" value={session?.filter || bootstrap?.filters[0]?.id || ''} disabled={!controllable} onChange={event => void control({ command: 'filter', options: { preset: event.target.value } })}>
      {bootstrap?.filters.map(filter => <option key={filter.id} value={filter.id}>{filter.label}</option>)}
    </select><CaretDownIcon size={16} /></label>
    <div className="player-more"><IconButton label="More playback controls" aria-expanded={more} onClick={() => setMore(!more)}><DotsMore /></IconButton>
      {more && <div className="menu-panel player-menu"><button disabled={!can('vote') || !!pending.length || !track} onClick={() => { setMore(false); void run({ command: 'voteskip', expectedRevision: snapshot?.revision }, 'vote'); }}><HandPalmIcon />Vote to skip</button>
        <button disabled={!controllable || !track} onClick={() => { setMore(false); void control({ command: 'radio', subcommand: session?.radio ? 'off' : 'on' }); }}><RadioIcon />Artist radio {session?.radio ? 'off' : 'on'}</button>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer"><ArrowSquareOutIcon />Open original track</a>}
        <button className="danger-text" disabled={!controllable || !session?.queue.length} onClick={() => { setMore(false); setConfirmClear(true); }}><TrashIcon />Clear upcoming queue</button>
        <button className="danger-text" disabled={!can('control') || !track} onClick={() => { setMore(false); setConfirmStop(true); }}><StopIcon />Stop and discard session</button>
        <small>Audio plays only in Discord.</small>
      </div>}
    </div>
  </div>;
  return <section className={`persistent-player ${expanded ? 'expanded' : 'collapsed'} ${session?.status || 'idle'}`} aria-label="Music player" data-testid="player">
    {expanded && <div className="sleeve-content"><button className="mobile-collapse text-button" onClick={() => setExpanded(false)}><CaretDownIcon size={22} />Back to queue</button>
      <div className="sleeve-main"><Artwork track={track} large />{identity}{session?.status === 'recovering' && <p className="player-state warm-text" role="status">Recovering your place. Playback controls will return when it’s ready.</p>}{session?.status === 'paused' && <p className="player-state warm-text">Paused · right here when you’re ready</p>}</div>
      <div className="sleeve-queue"><Queue portal={portal} compact onAdd={onAdd} /></div>
    </div>}
    <div className="player-footer">{!expanded && <div className="compact-identity"><Artwork track={track} /><div className="compact-title">{identity}</div></div>}
      <div className="playback-cluster">{expanded ? <>{controls}{timeline}</> : <>{timeline}{controls}</>}</div>
      {extras}
      <button className="expand-button" aria-expanded={expanded} aria-label={expanded ? 'Back to queue' : 'Open player'} onClick={() => setExpanded(!expanded)}>{expanded ? <CaretDownIcon size={29} /> : <CaretUpIcon size={29} />}<span>{expanded ? 'Back to queue' : 'Open player'}</span></button>
    </div>
    {confirmStop && <Confirm title="Stop this listening session?" detail="Stops playback in Discord, clears the queue, and discards the saved checkpoint. Your favorites and shared mixes stay saved." action="Stop and discard" busy={pending.includes('stop:')} onClose={() => setConfirmStop(false)} onConfirm={() => { void run({ command: 'stop' }, 'control').then(ok => { if (ok) setConfirmStop(false); }); }} />}
    {confirmClear && <Confirm title="Clear the upcoming queue?" detail={`Removes ${session?.queue.length || 0} queued songs. The current song keeps its position and playback state in Discord.`} action="Clear queue" busy={pending.includes('clear:')} onClose={() => setConfirmClear(false)} onConfirm={() => { void control({ command: 'clear' }).then(ok => { if (ok) setConfirmClear(false); }); }} />}
  </section>;
}
function DotsMore() { return <span className="more-label">More</span>; }
