import { useEffect, useId, useRef, useState } from 'react';
import { CaretDownIcon, CaretUpIcon, DotsThreeIcon, HeartIcon, PauseIcon, PlayIcon, RepeatIcon, RepeatOnceIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, StopIcon, RadioIcon, HandPalmIcon, ArrowSquareOutIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { Command } from '../types';
import { publicUrl } from '../api';
import { time, timestamp } from '../format';
import { ActionPopover, Artwork, Confirm, IconButton } from './ui';
import { Queue } from './Queue';
import { Spectrum } from './Spectrum';

export function Player({ portal, expanded, setExpanded, onAdd, accent, animate }: { portal: Portal; expanded: boolean; setExpanded: (value: boolean) => void; onAdd: () => void; accent: string; animate: boolean }) {
  const { snapshot, bootstrap, can, run, receivedAt, connection, pending, syncing, library } = portal;
  const session = snapshot?.session;
  const track = session?.current || null;
  const [clock, setClock] = useState(Date.now());
  const [scrub, setScrub] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const identityTriggerRef = useRef<HTMLButtonElement>(null);
  const expandTriggerRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(expanded);
  const openedFromIdentity = useRef(false);
  const reasonId = useId();
  const confirmationId = useId();
  useEffect(() => {
    if (expanded) headingRef.current?.focus({ preventScroll: true });
    else if (wasExpanded.current) (openedFromIdentity.current ? identityTriggerRef : expandTriggerRef).current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);
  useEffect(() => {
    if (!track || session?.status !== 'playing' || connection !== 'live') return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer); timer = undefined;
      if (!document.hidden) {
        setClock(Date.now());
        timer = setInterval(() => setClock(Date.now()), 500);
      }
    };
    document.addEventListener('visibilitychange', visibility); visibility();
    return () => { document.removeEventListener('visibilitychange', visibility); clearInterval(timer); };
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
  const blockedTitle = !can('control') ? portal.blockedReason : pending.length ? 'Waiting for confirmation. Playback controls are temporarily unavailable.' : undefined;
  const permissionReason = !can('control') ? portal.blockedReason : session?.reason;
  const controlDescription = [permissionReason ? reasonId : '', pending.length || syncing ? confirmationId : ''].filter(Boolean).join(' ') || undefined;
  // Observation and request settlement are independent. Only accepted live state
  // supplies the icon; the hook alone owns pending and the duplicate-write lock.
  const pendingObservation = !snapshot ? 'Playback state unavailable. ' : connection !== 'live' ? 'Last known playback. ' : session?.status === 'playing' ? 'Playing. ' : session?.status === 'paused' ? 'Paused. ' : '';
  const sourceUrl = publicUrl(track?.uri);
  const favorite = track && <IconButton className={`favorite ${index >= 0 ? 'active' : ''}`} label={index >= 0 ? 'Remove current song from favorites' : 'Save current song to favorites'} aria-pressed={index >= 0} disabled={!can('library') || !library || !!pending.length} onClick={() => void toggleFavorite()}><HeartIcon size={expanded ? 28 : 25} weight={index >= 0 ? 'fill' : 'regular'} /></IconButton>;
  const metadata = track ? <>{track.author}<span className="metadata-dot" aria-hidden="true">·</span><span className="track-source">{track.source}</span></> : 'Add a song to start the room.';
  const identity = <div className="player-identity"><div className="player-title-row"><h2 ref={headingRef} tabIndex={-1} title={track?.title}>{track?.title || 'Nothing playing'}</h2>{favorite}</div><p title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</p>
  </div>;
  const spectrumMode = track && active && connection === 'live' ? 'playing' : 'standby';
  const spectrum = (className: string, bands: number, ghost?: number) => <Spectrum className={className} seed={track?.id || 'idle'} color={accent} mode={spectrumMode} animate={animate} bands={bands} ghost={ghost} />;
  const seek = () => { if (scrub === null) return; const value = scrub; setScrub(null); if (seekable) void control({ command: 'seek', options: { timestamp: timestamp(value) } }); };
  const timeline = <div className="playback-timeline"><div className={`timeline ${track?.isStream ? 'is-live' : ''}`}>
    <span>{track?.isStream ? 'LIVE' : time(scrub ?? position)}</span>
    <input className="range seek-range" aria-label="Playback position" type="range" min={0} max={duration || 1} step={1000} value={scrub ?? Math.min(position, duration || 1)} disabled={!seekable}
      aria-valuetext={track?.isStream ? 'Live stream' : `${time(scrub ?? position)} of ${time(duration)}`}
      style={{ '--range-progress': `${Math.min(100, ((scrub ?? position) / (duration || 1)) * 100)}%` } as React.CSSProperties}
      onChange={event => setScrub(Number(event.target.value))} onPointerUp={seek} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) seek(); }} onBlur={seek} />
    <span>{track?.isStream ? 'Streaming' : time(duration)}</span>
  </div><div className="player-confirmation" id={confirmationId} role="status" aria-live="polite" aria-atomic="true">{pending.length ? <><span className="spinner" aria-hidden="true" /><span className="sr-only">{pendingObservation}</span><span>Waiting for confirmation</span><span className="sr-only">. {connection !== 'live' ? portal.blockedReason : 'Playback controls are temporarily unavailable.'}</span></>
    : syncing ? <><span className="spinner" aria-hidden="true" /><span>Syncing with Discord…</span></> : null}</div></div>;
  const controls = <div className="transport" role="group" aria-label="Playback controls" aria-describedby={controlDescription} aria-busy={!!pending.length}>
    <IconButton label="Shuffle queue" disabled={!controllable || !session?.queue.length} title={blockedTitle} onClick={() => void control({ command: 'shuffle' })}><ShuffleIcon size={24} /></IconButton>
    <IconButton label="Restart current song" disabled={!seekable} title={blockedTitle} onClick={() => void control({ command: 'seek', options: { timestamp: '00:00' } })}><SkipBackIcon size={27} weight="fill" /></IconButton>
    <IconButton className={`play-button ${session?.status === 'paused' || session?.status === 'recovering' ? 'settled' : ''}`} label={active ? 'Pause playback' : 'Resume playback'} disabled={!controllable || !track || !['playing', 'paused'].includes(session?.status || '')} title={blockedTitle} aria-describedby={controlDescription}
      onClick={() => void control({ command: active ? 'pause' : 'resume' })}>{active ? <PauseIcon size={31} weight="fill" /> : <PlayIcon size={31} weight="fill" />}</IconButton>
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
    <ActionPopover label="More playback controls" trigger={<DotsThreeIcon size={27} weight="bold" />} className="player-more" triggerClassName="icon-button">
      {close => <><button disabled={!can('vote') || !!pending.length || !track} onClick={() => { close(); void run({ command: 'voteskip', expectedRevision: snapshot?.revision }, 'vote'); }}><HandPalmIcon />Vote to skip</button>
        <button disabled={!controllable || !track} onClick={() => { close(); void control({ command: 'radio', subcommand: session?.radio ? 'off' : 'on' }); }}><RadioIcon />Turn artist radio {session?.radio ? 'off' : 'on'}</button>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" onClick={close}><ArrowSquareOutIcon />Open original track</a>}
        <button className="danger-text" disabled={!controllable || !session?.queue.length} onClick={() => { close(); setConfirmClear(true); }}><TrashIcon />Clear upcoming queue</button>
        <button className="danger-text" disabled={!can('control') || !track} onClick={() => { close(); setConfirmStop(true); }}><StopIcon />Stop and discard session</button>
        <small>Audio plays only in Discord.</small>
      </>}
    </ActionPopover>
  </div>;
  return <section className={`persistent-player ${expanded ? 'expanded' : 'collapsed'} ${session?.status || 'idle'}`} aria-label="Music player" data-testid="player">
    {!expanded && spectrum('player-spectrum', 56, 0)}
    {expanded && <div className="sleeve-content"><button className="mobile-collapse text-button" onClick={() => setExpanded(false)}><CaretDownIcon size={22} />Back to queue</button>
      <div className="sleeve-main"><div className="sleeve-artwork"><Artwork track={track} large />{spectrum('sleeve-spectrum', 40)}</div>{identity}<div className="player-context">{permissionReason && <p className="player-permission" id={reasonId}><WarningCircleIcon size={18} aria-hidden="true" /><span>{permissionReason}</span></p>}{connection === 'live' && session?.status === 'recovering' && <p className="player-state warm-text" role="status">Recovering your place. Playback controls will return when it’s ready.</p>}{session?.status === 'paused' && <p className="player-state warm-text">{connection === 'live' ? 'Paused · right here when you’re ready' : 'Last known: paused'}</p>}</div></div>
      <div className="sleeve-queue"><Queue portal={portal} compact onAdd={onAdd} /></div>
    </div>}
    <div className="player-footer">{!expanded && <span className="compact-progress" aria-hidden="true" style={{ '--range-progress': `${track && !track.isStream && duration ? Math.min(100, (position / duration) * 100) : 0}%` } as React.CSSProperties} />}{!expanded && <div className="compact-identity"><button ref={identityTriggerRef} type="button" className="player-expand-trigger" aria-label={track ? `Open player for ${track.title}` : 'Open player details'} aria-expanded={false} onClick={() => { openedFromIdentity.current = true; setExpanded(true); }}><Artwork track={track} /><span className="compact-title"><span className="compact-track-title" title={track?.title}>{track?.title || 'Nothing playing'}</span><span className="compact-track-meta" title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</span></span></button><span className="compact-favorite">{favorite}</span></div>}
      <div className="playback-cluster">{expanded ? <>{controls}{timeline}</> : <>{timeline}{controls}</>}</div>
      {extras}
      {!expanded && permissionReason && <span className="sr-only" id={reasonId}>{permissionReason}</span>}
      <button ref={expandTriggerRef} className="expand-button" aria-expanded={expanded} aria-label={expanded ? 'Back to queue' : 'Open player'} onClick={() => { openedFromIdentity.current = false; setExpanded(!expanded); }}>{expanded ? <CaretDownIcon size={29} /> : <CaretUpIcon size={29} />}<span>{expanded ? 'Back to queue' : 'Open player'}</span></button>
    </div>
    {confirmStop && <Confirm title="Stop this listening session?" detail="Stops playback in Discord, clears the queue, and discards the saved checkpoint. Your favorites and shared mixes stay saved." action="Stop and discard" busy={pending.includes('stop:')} onClose={() => setConfirmStop(false)} onConfirm={() => { void run({ command: 'stop' }, 'control').then(ok => { if (ok) setConfirmStop(false); }); }} />}
    {confirmClear && <Confirm title="Clear the upcoming queue?" detail={`Removes ${session?.queue.length || 0} queued songs. The current song keeps its position and playback state in Discord.`} action="Clear queue" onClose={() => setConfirmClear(false)} onConfirm={() => { setConfirmClear(false); void control({ command: 'clear' }); }} />}
  </section>;
}
