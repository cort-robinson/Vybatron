import { useEffect, useId, useRef, useState } from 'react';
import { CaretDownIcon, CheckIcon, DesktopIcon, DiscordLogoIcon, CaretUpIcon, DotsThreeIcon, HeartIcon, PauseIcon, PlayIcon, RepeatIcon, RepeatOnceIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, StopIcon, RadioIcon, HandPalmIcon, ArrowSquareOutIcon, TrashIcon, WarningCircleIcon, ThumbsDownIcon, VinylRecordIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { Command } from '../types';
import { publicUrl } from '../api';
import { time, timestamp } from '../format';
import { RESTART_AFTER_MS } from '../playback';
import { ActionPopover, Artwork, Confirm, Dialog, IconButton } from './ui';
import { SaveSessionDialog, StopDialog } from './SessionMix';
import { Queue } from './Queue';
import { Spectrum } from './Spectrum';
import { pulse } from '../motion';
import { neon, skinTint, type Skin } from '../skin';
import { Hud, tilt, untilt } from './Overdrive';
import { Television } from './Fantastic';

export function Player({ portal, expanded, setExpanded, onAdd, accent, animate, skin = 'classic' }: { portal: Portal; expanded: boolean; setExpanded: (value: boolean) => void; onAdd: () => void; accent: string; animate: boolean; skin?: Skin }) {
  const { snapshot, bootstrap, can, run, receivedAt, connection, pending, syncing, library } = portal;
  const session = snapshot?.session;
  const local = portal.target === 'local';
  // This device's own playback needs no live Discord state to keep time.
  const live = local || connection === 'live';
  const track = session?.current || null;
  const [clock, setClock] = useState(Date.now());
  const [scrub, setScrub] = useState<number | null>(null);
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveSession, setSaveSession] = useState(false);
  const [confirmHere, setConfirmHere] = useState(false);
  const playerRef = useRef<HTMLElement>(null);
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
    if (!track || session?.status !== 'playing' || !live) return;
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
  }, [track?.id, session?.status, live]);
  useEffect(() => { setScrub(null); setVolumeDraft(null); setClock(Date.now()); }, [track?.id, snapshot?.guild.id]);
  // Acknowledge state that changes under the controls, whoever changed it: a new song settles
  // into the deck, the play mark swaps, repeat cycles, and a saved heart lifts once.
  const saved = (library?.favorites.some(t => t.id === track?.id)) ?? false;
  const observed = useRef({ track: track?.id, status: session?.status, repeat: session?.repeat, saved });
  useEffect(() => {
    const previous = observed.current; const player = playerRef.current;
    observed.current = { track: track?.id, status: session?.status, repeat: session?.repeat, saved };
    if (!player) return;
    const find = (selector: string) => player.querySelectorAll(selector);
    if (previous.track !== track?.id) {
      if (previous.track && track) pulse(find('.player-expand-trigger > .artwork, .compact-title, .player-identity'), [{ opacity: .8, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], 460);
      // Overdrive: the new title locks on as a chromatic split converges. No slicing or jumps, so it
      // reads as focus settling rather than a flicker.
      if (previous.track && track && skin === 'overdrive') pulse(find('.player-identity h2, .compact-track-title'), [{ textShadow: `-4px 0 ${neon}, 4px 0 ${accent}` }, { textShadow: `-1px 0 ${neon}, 1px 0 ${accent}`, offset: .6 }, { textShadow: `0 0 transparent, 0 0 transparent` }], 560);
      // Fantastic: the new title stretches like Reed Richards and snaps back into shape.
      if (previous.track && track && skin === 'fantastic') pulse(find('.player-identity h2, .compact-track-title'), [{ transform: 'none' }, { transform: 'scale(1.16, .9)', offset: .22 }, { transform: 'scale(.95, 1.04)', offset: .48 }, { transform: 'scale(1.02, .99)', offset: .72 }, { transform: 'none' }], 720);
      return;
    }
    if (previous.status !== session?.status && previous.status && ['playing', 'paused'].includes(session?.status || '')) pulse(find('.play-button svg'), [{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'none' }], 240);
    if (previous.repeat !== session?.repeat && previous.repeat) pulse(find('.repeat-control svg'), [{ transform: 'rotate(-180deg) scale(.7)', opacity: .4 }, { transform: 'none', opacity: 1 }], 360);
    if (!previous.saved && saved) pulse(find('.favorite svg'), [{ transform: 'scale(1)' }, { transform: 'scale(1.28)', offset: .35 }, { transform: 'scale(1)' }], 420);
  }, [track?.id, session?.status, session?.repeat, saved]);
  const duration = session?.durationMs || track?.durationMs || 0;
  const position = Math.min(duration || Infinity, Math.max(0, (session?.positionMs || 0) + (session?.status === 'playing' && live ? Math.max(0, clock - receivedAt) : 0)));
  const controllable = can('control') && !pending.length;
  const seekable = controllable && !!track && !track.isStream && duration > 0 && !['recovering', 'unavailable'].includes(session?.status || '');
  const control = (body: Command) => run({ ...body, expectedRevision: snapshot?.revision }, 'control');
  // Early in a song Back goes to the previous one; later, or with nothing earlier, it restarts this one.
  const goesBack = !!session?.hasPrevious && (position <= RESTART_AFTER_MS || !seekable);
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
  // Where this session can go: the server's session, or the viewer's own voice channel.
  const discord = portal.discord;
  const discordActive = !!(discord?.current || discord?.queue.length);
  const room = discord?.voiceChannel?.name || discord?.viewerVoice?.name;
  const discordLabel = !local ? `Discord${room ? ` · ${room}` : ''}`
    : discordActive ? `Join the session in ${discord?.voiceChannel?.name || 'Discord'}`
    : discord?.viewerVoice ? `${track ? 'Move to' : 'Discord ·'} ${discord.viewerVoice.name}` : 'Discord · join a voice channel first';
  const others = discord?.listeners.filter(listener => listener.id !== bootstrap?.viewer.id).length || 0;
  const favorite = track && <IconButton className={`favorite ${index >= 0 ? 'active' : ''}`} label={index >= 0 ? 'Remove current song from favorites' : 'Save current song to favorites'} aria-pressed={index >= 0} disabled={!can('library') || !library || !!pending.length || local && index < 0} title={local && index < 0 ? 'Save favorites while a song plays in Discord.' : undefined} onClick={() => void toggleFavorite()}><HeartIcon size={expanded ? 28 : 25} weight={index >= 0 ? 'fill' : 'regular'} /></IconButton>;
  // An autoplay pick names its provenance in place of the source.
  const metadata = track ? <>{track.author}<span className="metadata-dot" aria-hidden="true">·</span><span className="track-source">{track.suggested ? 'Autoplay pick' : track.source}</span></> : 'Add a song to start the room.';
  const identity = <div className="player-identity"><div className="player-title-row"><h2 ref={headingRef} tabIndex={-1} title={track?.title}>{track?.title || 'Nothing playing'}</h2>{favorite}</div><p title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</p>
  </div>;
  const spectrumMode = track && active && live ? 'playing' : 'standby';
  const spectrum = (className: string, bands: number, ghost?: number) => <Spectrum className={className} seed={track?.id || 'idle'} color={accent} tint={skinTint(skin)} mode={spectrumMode} animate={animate} bands={bands} ghost={ghost} />;
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
    <IconButton label={goesBack ? 'Previous song' : 'Restart current song'} disabled={goesBack ? !controllable : !seekable} title={blockedTitle} onClick={() => void control(goesBack ? { command: 'back' } : { command: 'seek', options: { timestamp: '00:00' } })}><SkipBackIcon size={27} weight="fill" /></IconButton>
    <IconButton className={`play-button ${session?.status === 'paused' || session?.status === 'recovering' ? 'settled' : ''}`} label={active ? 'Pause playback' : 'Resume playback'} disabled={!controllable || !track || !['playing', 'paused'].includes(session?.status || '')} title={blockedTitle} aria-describedby={controlDescription}
      onClick={() => void control({ command: active ? 'pause' : 'resume' })}>{active ? <PauseIcon size={31} weight="fill" /> : <PlayIcon size={31} weight="fill" />}</IconButton>
    <IconButton label="Skip current song" disabled={!controllable || !track} title={blockedTitle} onClick={() => void control({ command: 'skip' })}><SkipForwardIcon size={27} weight="fill" /></IconButton>
    <IconButton label={`Repeat: ${session?.repeat || 'off'}. Change repeat mode`} className={`repeat-control ${session?.repeat !== 'off' && session?.repeat ? 'active-control' : ''}`} disabled={!controllable || !track} title={blockedTitle}
      onClick={() => void control({ command: 'loop', options: { mode: session?.repeat === 'off' ? 'track' : session?.repeat === 'track' ? 'queue' : 'off' } })}>{session?.repeat === 'track' ? <RepeatOnceIcon size={25} /> : <RepeatIcon size={25} />}</IconButton>
  </div>;
  const extras = <div className="player-extras">
    <div className="volume-control"><SpeakerHighIcon size={23} /><input className="range" aria-label="Volume" type="range" min="0" max="100" value={volumeDraft ?? session?.volume ?? 100} disabled={!controllable}
      style={{ '--range-progress': `${volumeDraft ?? session?.volume ?? 100}%` } as React.CSSProperties} aria-valuetext={`${volumeDraft ?? session?.volume ?? 100} percent`}
      onChange={event => setVolumeDraft(Number(event.target.value))}
      onPointerUp={() => { if (volumeDraft !== null) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }}
      onKeyUp={event => { if (volumeDraft !== null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }}
      onBlur={() => { if (volumeDraft !== null) { void control({ command: 'volume', options: { level: volumeDraft } }); setVolumeDraft(null); } }} /></div>
    {!local && <label className={`filter-control ${session?.filter === 'warm' ? 'warm' : ''}`}><span className="filter-dot" /><span className="sr-only">Audio filter</span><select aria-label="Audio filter" value={session?.filter || bootstrap?.filters[0]?.id || ''} disabled={!controllable} onChange={event => void control({ command: 'filter', options: { preset: event.target.value } })}>
      {bootstrap?.filters.map(filter => <option key={filter.id} value={filter.id}>{filter.label}</option>)}
    </select><CaretDownIcon size={16} /></label>}
    <ActionPopover label="More playback controls" trigger={<DotsThreeIcon size={27} weight="bold" />} className="player-more" triggerClassName="icon-button">
      {close => <>{!local && <><button disabled={!can('vote') || !!pending.length || !track} onClick={() => { close(); void run({ command: 'voteskip', expectedRevision: snapshot?.revision }, 'vote'); }}><HandPalmIcon />Vote to skip</button>
        <button disabled={!controllable || !track} onClick={() => { close(); void control({ command: 'radio', subcommand: session?.radio ? 'off' : 'on' }); }}><RadioIcon />Turn autoplay {session?.radio ? 'off' : 'on'}</button></>}
        {!local && track?.suggested && <button disabled={!controllable} onClick={() => { close(); void run({ command: 'radio', subcommand: 'less', expectedTrackId: track.id }, 'control'); }}><ThumbsDownIcon />Less like this</button>}
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" onClick={close}><ArrowSquareOutIcon />Open original track</a>}
        {!local && <button disabled={!can('library') || !!pending.length || !track} onClick={() => { close(); setSaveSession(true); }}><VinylRecordIcon />Save session as mix</button>}
        <p className="menu-section">Play on</p>
        <button aria-pressed={local} disabled={!!pending.length} onClick={() => { close(); if (!local) { if (discord?.current) setConfirmHere(true); else void portal.moveHere(false); } }}><DesktopIcon />This device{local && <CheckIcon className="menu-check" weight="bold" />}</button>
        <button aria-pressed={!local} disabled={!!pending.length || local && !discordActive && !discord?.viewerVoice} onClick={() => { close(); if (local) void portal.moveToDiscord(); }}><DiscordLogoIcon />{discordLabel}{!local && <CheckIcon className="menu-check" weight="bold" />}</button>
        <button className="danger-text" disabled={!controllable || !session?.queue.length} onClick={() => { close(); setConfirmClear(true); }}><TrashIcon />Clear upcoming queue</button>
        <button className="danger-text" disabled={!can('control') || !track} onClick={() => { close(); setConfirmStop(true); }}><StopIcon />{local ? 'Stop and clear this device’s queue' : 'Stop and discard session'}</button>
      </>}
    </ActionPopover>
  </div>;
  return <section ref={playerRef} className={`persistent-player ${expanded ? 'expanded' : 'collapsed'} ${session?.status || 'idle'}`} aria-label="Music player" data-testid="player">
    {!expanded && spectrum('player-spectrum', 56, 0)}
    {expanded && <div className="sleeve-content"><button className="mobile-collapse text-button" onClick={() => setExpanded(false)}><CaretDownIcon size={22} />Back to queue</button>
      <div className="sleeve-main"><div className="sleeve-artwork" onPointerMove={tilt} onPointerLeave={untilt}><Artwork track={track} large />{spectrum('sleeve-spectrum', 40)}{skin === 'overdrive' && <><span className="od-cover-plate" aria-hidden="true" /><Hud className="od-cover-hud" /><span key={track?.id || 'idle'} className="od-cover-scan" aria-hidden="true" /></>}{skin === 'fantastic' && <><Television /><span key={track?.id || 'idle'} className="ff-tune" aria-hidden="true" /></>}</div>{identity}<div className="player-context">{permissionReason && <p className="player-permission" id={reasonId}><WarningCircleIcon size={18} aria-hidden="true" /><span>{permissionReason}</span></p>}{connection === 'live' && session?.status === 'recovering' && <p className="player-state warm-text" role="status">Recovering your place. Playback controls will return when it’s ready.</p>}{session?.status === 'paused' && <p className="player-state warm-text">{connection === 'live' ? 'Paused · right here when you’re ready' : 'Last known: paused'}</p>}</div></div>
      <div className="sleeve-queue"><Queue portal={portal} compact onAdd={onAdd} /></div>
    </div>}
    <div className="player-footer">{!expanded && <span className="compact-progress" aria-hidden="true" style={{ '--range-progress': `${track && !track.isStream && duration ? Math.min(100, (position / duration) * 100) : 0}%` } as React.CSSProperties} />}{!expanded && <div className="compact-identity"><button ref={identityTriggerRef} type="button" className="player-expand-trigger" aria-label={track ? `Open player for ${track.title}` : 'Open player details'} aria-expanded={false} onClick={() => { openedFromIdentity.current = true; setExpanded(true); }}><Artwork track={track} /><span className="compact-title"><span className="compact-track-title" title={track?.title}>{track?.title || 'Nothing playing'}</span><span className="compact-track-meta" title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</span></span></button><span className="compact-favorite">{favorite}</span></div>}
      <div className="playback-cluster">{controls}{timeline}</div>
      {extras}
      {!expanded && permissionReason && <span className="sr-only" id={reasonId}>{permissionReason}</span>}
      <button ref={expandTriggerRef} className="expand-button" aria-expanded={expanded} aria-label={expanded ? 'Back to queue' : 'Open player'} title={expanded ? 'Back to queue' : 'Open player'} onClick={() => { openedFromIdentity.current = false; setExpanded(!expanded); }}>{expanded ? <CaretDownIcon size={29} /> : <CaretUpIcon size={29} />}<span>{expanded ? 'Back to queue' : 'Open player'}</span></button>
    </div>
    {confirmStop && (local ? <Confirm title="Stop playing on this device?" detail="Stops the current song and clears this device’s queue. The Discord session, your favorites and shared mixes aren’t affected." action="Stop" onClose={() => setConfirmStop(false)} onConfirm={() => { setConfirmStop(false); void run({ command: 'stop' }, 'control'); }} />
      : <StopDialog portal={portal} onClose={() => setConfirmStop(false)} />)}
    {saveSession && <SaveSessionDialog portal={portal} onClose={() => setSaveSession(false)} />}
    {confirmHere && <Dialog title="Move playback to this device?" onClose={() => setConfirmHere(false)} className="confirm-dialog">
      <p>{others ? `${others} other ${others === 1 ? 'person is' : 'people are'} listening in ${discord?.voiceChannel?.name || 'Discord'}. ` : ''}Move here stops the music in Discord and picks it up on this device at the same spot. Listen here too keeps Discord playing.</p>
      {!can('control') && <p className="permission-note">{portal.blockedReason} You can still listen here too.</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={() => setConfirmHere(false)}>Cancel</button>
        <button type="button" className="button secondary" onClick={() => { setConfirmHere(false); void portal.moveHere(false); }}>Listen here too</button>
        <button type="button" className="button primary" disabled={!can('control') || !!pending.length} onClick={() => void portal.moveHere(true).then(ok => { if (ok) setConfirmHere(false); })}>Move here</button></div>
    </Dialog>}
    {confirmClear && <Confirm title="Clear the upcoming queue?" detail={`Removes ${session?.queue.length || 0} queued songs. The current song keeps its position and playback state${local ? '' : ' in Discord'}.`} action="Clear queue" onClose={() => setConfirmClear(false)} onConfirm={() => { setConfirmClear(false); void control({ command: 'clear' }); }} />}
  </section>;
}
