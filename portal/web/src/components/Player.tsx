import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CaretDownIcon, CheckIcon, DesktopIcon, DiscordLogoIcon, CaretUpIcon, DotsThreeIcon, HeartIcon, PauseIcon, PlayIcon, RepeatIcon, RepeatOnceIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, SpeakerHighIcon, StopIcon, RadioIcon, HandPalmIcon, ArrowSquareOutIcon, TrashIcon, WarningCircleIcon, ThumbsDownIcon, VinylRecordIcon, MoonIcon, MicrophoneStageIcon } from '@phosphor-icons/react';
import type { Portal } from '../usePortal';
import type { Command, GuildSnapshot, Track } from '../types';
import { publicUrl } from '../api';
import { time, timestamp } from '../format';
import { RESTART_AFTER_MS } from '../playback';
import { ActionPopover, Artwork, Confirm, Dialog, IconButton } from './ui';
import { SaveSessionDialog, StopDialog } from './SessionMix';
import { SleepDialog, useSleepText } from './SleepTimer';
import { Queue } from './Queue';
import { Spectrum } from './Spectrum';
import { prefersReducedMotion, pulse } from '../motion';
import { swipe, type SwipeDirection } from '../swipe';
import { useBackLayers } from '../backLayers';
import { skinLook, skinTint, type Skin } from '../skin';
import { activeLine, LyricsPanel, useLyrics } from './Lyrics';

export function Player({ portal, expanded, setExpanded, onAdd, accent, animate, skin = 'classic' }: { portal: Portal; expanded: boolean; setExpanded: (value: boolean, settle?: () => void) => void; onAdd: () => void; accent: string; animate: boolean; skin?: Skin }) {
  const { snapshot, bootstrap, can, run, receivedAt, connection, pending, syncing, library } = portal;
  const session = snapshot?.session;
  const local = portal.target === 'local';
  // This device's own playback needs no live Discord state to keep time.
  const live = local || connection === 'live';
  const track = session?.current || null;
  const [volumeDraft, setVolumeDraft] = useState<number | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveSession, setSaveSession] = useState(false);
  const [confirmHere, setConfirmHere] = useState(false);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // The open player can show the current song's lyrics in place of its cover.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const playerRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const identityTriggerRef = useRef<HTMLButtonElement>(null);
  const expandTriggerRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const songExit = useRef<Animation | null>(null);
  const wasExpanded = useRef(expanded);
  const openedFromIdentity = useRef(false);
  const reasonId = useId();
  const confirmationId = useId();
  const queueId = useId();
  const lyricsId = useId();
  // Timeline ticks belong to the deck; unchanged queue artwork and row menus can keep their tree.
  const queue = useMemo(() => <Queue portal={portal} compact onAdd={onAdd} />, [portal, onAdd]);
  const swiped = useRef(false);
  useEffect(() => {
    // A swipe, like a tap, leaves no focus ring behind; screen readers and keyboards never swipe.
    if (swiped.current) { swiped.current = false; (document.activeElement as HTMLElement | null)?.blur(); }
    else if (expanded) headingRef.current?.focus({ preventScroll: true });
    else if (wasExpanded.current) (openedFromIdentity.current ? identityTriggerRef : expandTriggerRef).current?.focus({ preventScroll: true });
    wasExpanded.current = expanded;
  }, [expanded]);
  // Swipe up on the compact deck opens the player; pulling the open player down closes it.
  const expand = useRef(setExpanded); expand.current = setExpanded;
  useEffect(() => swipe(playerRef.current, expanded ? 'down' : 'up', (_, settle) => { swiped.current = true; expand.current(!expanded, settle); }), [expanded]);
  // On phones the open player keeps Up next in a sheet: drag its handle up to open it, pull it down to close it.
  useEffect(() => { if (!expanded) { setQueueOpen(false); setLyricsOpen(false); } }, [expanded]);
  useEffect(() => swipe(handleRef.current, queueOpen ? 'down' : 'up', (_, settle) => { settle(); setQueueOpen(!queueOpen); }, queueOpen ? sheetRef.current : handleRef.current), [expanded, queueOpen]);
  useEffect(() => queueOpen ? swipe(sheetRef.current, 'down', (_, settle) => { settle(); setQueueOpen(false); }) : undefined, [queueOpen]);
  useBackLayers(expanded ? queueOpen ? 2 : 1 : 0, layer => { if (layer < 2) setQueueOpen(false); if (layer < 1) expand.current(false); });
  useEffect(() => { setVolumeDraft(null); }, [track?.id, snapshot?.guild.id]);
  // Acknowledge state that changes under the controls, whoever changed it: a new song settles
  // into the deck, the play mark swaps, repeat cycles, and a saved heart lifts once.
  const saved = (library?.favorites.some(t => t.id === track?.id)) ?? false;
  const observed = useRef({ track: track?.id, status: session?.status, repeat: session?.repeat, saved });
  useLayoutEffect(() => {
    const previous = observed.current; const player = playerRef.current;
    observed.current = { track: track?.id, status: session?.status, repeat: session?.repeat, saved };
    if (!player) return;
    const find = (selector: string) => player.querySelectorAll(selector);
    if (previous.track !== track?.id) {
      songExit.current?.cancel(); songExit.current = null;
      if (previous.track && track) {
        pulse(find('.player-expand-trigger > .artwork'), [{ opacity: .8, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], 460);
        // Keep the caption plate opaque and its lettering/shadow steady. Only the inner text
        // settles, before its first paint, so neither the scenery nor a split shadow flashes through.
        if (skin !== 'fantastic') pulse(find('.player-title-row, .player-identity > p, .compact-title'), [{ transform: 'translateY(2px)' }, { transform: 'none' }], 320);
      }
      // Fantastic: the new title stretches like Reed Richards and snaps back into shape.
      if (previous.track && track && skin === 'fantastic') pulse(find('.player-identity h2, .compact-track-title'), [{ transform: 'none' }, { transform: 'scale(1.16, .9)', offset: .22 }, { transform: 'scale(.95, 1.04)', offset: .48 }, { transform: 'scale(1.02, .99)', offset: .72 }, { transform: 'none' }], 720);
      return;
    }
    if (previous.status !== session?.status && previous.status && ['playing', 'paused'].includes(session?.status || '')) pulse(find('.play-button svg'), [{ opacity: 0, transform: 'scale(.55)' }, { opacity: 1, transform: 'none' }], 240);
    if (previous.repeat !== session?.repeat && previous.repeat) pulse(find('.repeat-control svg'), [{ transform: 'rotate(-180deg) scale(.7)', opacity: .4 }, { transform: 'none', opacity: 1 }], 360);
    if (!previous.saved && saved) pulse(find('.favorite svg'), [{ transform: 'scale(1)' }, { transform: 'scale(1.28)', offset: .35 }, { transform: 'scale(1)' }], 420);
  }, [track?.id, session?.status, session?.repeat, saved]);
  // With no current song there is no timeline, whatever position an idle snapshot still carries.
  const duration = track ? session?.durationMs || track.durationMs || 0 : 0;
  const controllable = can('control') && !pending.length;
  const seekable = controllable && !!track && !track.isStream && duration > 0 && !['recovering', 'unavailable'].includes(session?.status || '');
  const control = (body: Command) => run({ ...body, expectedRevision: snapshot?.revision }, 'control');
  const clock = { session, receivedAt, live };
  // Songs on this device can be pushed aside on the compact deck: left skips, right goes back. A shared
  // Discord session never changes song from a stray swipe, so it keeps buttons only.
  const aside = useRef<(direction: SwipeDirection) => boolean>(() => false);
  aside.current = direction => {
    if (!controllable || !track || direction === 'right' && !session?.hasPrevious) return false;
    void control({ command: direction === 'left' ? 'skip' : 'back' });
    return true;
  };
  useEffect(() => {
    if (expanded || !local) return;
    const identity = playerRef.current?.querySelector<HTMLElement>('.compact-identity') ?? null;
    return swipe(playerRef.current, ['left', 'right'], (direction, settle) => {
      if (!aside.current(direction)) return false;
      // The song leaves the way it was pushed and stays out until the next one arrives.
      if (identity && !prefersReducedMotion()) {
        songExit.current = identity.animate([{ transform: identity.style.transform, opacity: identity.style.opacity || '1' }, { transform: `translateX(${direction === 'left' ? -60 : 60}%)`, opacity: 0 }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
        const exit = songExit.current; setTimeout(() => exit.cancel(), 1500);
      }
      settle();
    }, identity);
  }, [expanded, local]);
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
  // A sleep timer belongs to the Discord session, never this device's playback.
  const sleep = useSleepText(local ? null : session?.sleep);
  const discordActive = !!(discord?.current || discord?.queue.length);
  const room = discord?.voiceChannel?.name || discord?.viewerVoice?.name;
  const discordLabel = !local ? `Discord${room ? ` · ${room}` : ''}`
    : discordActive ? `Join the session in ${discord?.voiceChannel?.name || 'Discord'}`
    : discord?.viewerVoice ? `${track ? 'Move to' : 'Discord ·'} ${discord.viewerVoice.name}` : 'Discord · join a voice channel first';
  const others = discord?.listeners.filter(listener => listener.id !== bootstrap?.viewer.id).length || 0;
  const favorite = track && <IconButton className={`favorite ${index >= 0 ? 'active' : ''}`} label={index >= 0 ? 'Remove current song from favorites' : 'Save current song to favorites'} aria-pressed={index >= 0} disabled={!can('library') || !library || !!pending.length || local && index < 0} title={local && index < 0 ? 'Save favorites while a song plays in Discord.' : undefined} onClick={() => void toggleFavorite()}><HeartIcon size={expanded ? 28 : 25} weight={index >= 0 ? 'fill' : 'regular'} /></IconButton>;
  // An autoplay pick names its provenance in place of the source.
  const metadata = track ? <>{track.author}<span className="metadata-dot" aria-hidden="true">·</span><span className="track-source">{track.suggested ? 'Autoplay pick' : track.source}</span></> : 'Add a song to start the room.';
  const lyricsToggle = <IconButton className={`lyrics-toggle ${lyricsOpen ? 'active-control' : ''}`} label={lyricsOpen ? 'Hide lyrics' : 'Show lyrics'} aria-pressed={lyricsOpen} aria-controls={lyricsOpen ? lyricsId : undefined} onClick={() => setLyricsOpen(!lyricsOpen)}><MicrophoneStageIcon size={26} weight={lyricsOpen ? 'fill' : 'regular'} /></IconButton>;
  const identity = <div className="player-identity"><div className="player-title-row"><h2 ref={headingRef} tabIndex={-1} title={track?.title}>{track?.title || 'Nothing playing'}</h2>{favorite}{lyricsToggle}</div><p title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</p>
  </div>;
  const spectrumMode = track && active && live ? 'playing' : 'standby';
  const look = skinLook(skin);
  const spectrum = (className: string, bands: number, ghost?: number) => <Spectrum className={className} seed={track?.id || 'idle'} color={accent} tint={skinTint(skin)} mode={spectrumMode} animate={animate} bands={bands} ghost={ghost} />;
  const timeline = <div className="playback-timeline"><Timeline clock={clock} track={track} duration={duration} seekable={seekable} reset={snapshot?.guild.id}
    onSeek={value => void control({ command: 'seek', options: { timestamp: timestamp(value) } })} /><div className="player-confirmation" id={confirmationId} role="status" aria-live="polite" aria-atomic="true">{pending.length ? <><span className="spinner" aria-hidden="true" /><span className="sr-only">{pendingObservation}</span><span>Waiting for confirmation</span><span className="sr-only">. {connection !== 'live' ? portal.blockedReason : 'Playback controls are temporarily unavailable.'}</span></>
    : syncing ? <><span className="spinner" aria-hidden="true" /><span>Syncing with Discord…</span></> : null}</div></div>;
  const controls = <div className="transport" role="group" aria-label="Playback controls" aria-describedby={controlDescription} aria-busy={!!pending.length}>
    <IconButton label="Shuffle queue" disabled={!controllable || !session?.queue.length} title={blockedTitle} onClick={() => void control({ command: 'shuffle' })}><ShuffleIcon size={24} /></IconButton>
    <BackButton clock={clock} seekable={seekable} disabled={!controllable} title={blockedTitle} onPress={back => void control(back ? { command: 'back' } : { command: 'seek', options: { timestamp: '00:00' } })} />
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
        <button disabled={!controllable || !track} onClick={() => { close(); void control({ command: 'radio', subcommand: session?.radio ? 'off' : 'on' }); }}><RadioIcon />Turn autoplay {session?.radio ? 'off' : 'on'}</button>
        <button disabled={!controllable || !track && !sleep} onClick={() => { close(); setSleepOpen(true); }}><MoonIcon />{sleep ? `Sleep timer · ${sleep}` : 'Sleep timer'}</button></>}
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
  const upcoming = session?.queue.length || 0;
  return <section ref={playerRef} className={`persistent-player ${expanded ? 'expanded' : 'collapsed'} ${queueOpen ? 'queue-open' : ''} ${session?.status || 'idle'}`} aria-label="Music player" data-testid="player">
    {!expanded && spectrum('player-spectrum', 56, 0)}
    {expanded && <div className="sleeve-content"><button className="mobile-collapse text-button" onClick={() => setExpanded(false)}><CaretDownIcon size={22} />Close player</button>
      <div className="sleeve-main">{lyricsOpen ? <div className="sleeve-artwork showing-lyrics"><LyricsView id={lyricsId} clock={clock} guildId={snapshot?.guild.id} trackId={track?.id || null} local={local} /></div>
        : <div className="sleeve-artwork" onPointerMove={look?.tilt} onPointerLeave={look?.untilt}><Artwork track={track} large />{spectrum('sleeve-spectrum', 40)}{look && <look.Sleeve track={track?.id || 'idle'} />}</div>}{identity}<div className="player-context">{permissionReason && <p className="player-permission" id={reasonId}><WarningCircleIcon size={18} aria-hidden="true" /><span>{permissionReason}</span></p>}{connection === 'live' && session?.status === 'recovering' && <p className="player-state warm-text" role="status">Recovering your place. Playback controls will return when it’s ready.</p>}{sleep && <p className="player-state sleep-state"><MoonIcon size={16} aria-hidden="true" /><span>Sleep timer · {sleep}</span></p>}{session?.status === 'paused' && <p className="player-state warm-text">{connection === 'live' ? 'Paused · right here when you’re ready' : 'Last known: paused'}</p>}</div></div>
      <div ref={sheetRef} id={queueId} className="sleeve-queue">{queueOpen && <div className="queue-sheet-now"><span className="sheet-grabber" aria-hidden="true" /><Artwork track={track} /><span className="sheet-now-text"><strong>{track?.title || 'Nothing playing'}</strong><span>{track?.author}</span></span></div>}{queue}</div>
    </div>}
    <div className="player-footer">{!expanded && <CompactProgress clock={clock} track={track} duration={duration} />}{!expanded && <div className="compact-identity"><button ref={identityTriggerRef} type="button" className="player-expand-trigger" aria-label={track ? `Open player for ${track.title}` : 'Open player details'} aria-expanded={false} onClick={() => { openedFromIdentity.current = true; setExpanded(true); }}><Artwork track={track} /><span className="compact-title"><span className="compact-track-title" title={track?.title}>{track?.title || 'Nothing playing'}</span><span className="compact-track-meta" title={track ? `${track.author} · ${track.source}` : undefined}>{metadata}</span></span></button><span className="compact-favorite">{favorite}</span></div>}
      <div className="playback-cluster">{controls}{timeline}</div>
      {extras}
      {expanded && <button ref={handleRef} type="button" className="up-next-handle" aria-expanded={queueOpen} aria-controls={queueId} onClick={() => setQueueOpen(!queueOpen)}><span className="sheet-grabber" aria-hidden="true" /><span>{queueOpen ? 'Hide queue' : 'Up next'}</span>{!queueOpen && upcoming > 0 && <span className="count">{upcoming} {upcoming === 1 ? 'song' : 'songs'}</span>}</button>}
      {!expanded && permissionReason && <span className="sr-only" id={reasonId}>{permissionReason}</span>}
      <button ref={expandTriggerRef} className="expand-button" aria-expanded={expanded} aria-label={expanded ? 'Close player' : 'Open player'} title={expanded ? 'Close player' : 'Open player'} onClick={() => { openedFromIdentity.current = false; setExpanded(!expanded); }}>{expanded ? <CaretDownIcon size={29} /> : <CaretUpIcon size={29} />}<span>{expanded ? 'Close player' : 'Open player'}</span></button>
    </div>
    {confirmStop && (local ? <Confirm title="Stop playing on this device?" detail="Stops the current song and clears this device’s queue. The Discord session, your favorites and shared mixes aren’t affected." action="Stop" onClose={() => setConfirmStop(false)} onConfirm={() => { setConfirmStop(false); void run({ command: 'stop' }, 'control'); }} />
      : <StopDialog portal={portal} onClose={() => setConfirmStop(false)} />)}
    {sleepOpen && !local && <SleepDialog portal={portal} onClose={() => setSleepOpen(false)} />}
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

// The position advances locally between snapshots while a song plays. One shared clock ticks only
// while something shows a moving position, and only those readouts re-render on each tick, not
// the whole player twice a second.
const ticks = new Set<() => void>();
let now = Date.now(); let ticker: ReturnType<typeof setInterval> | undefined;
const tick = () => { now = Date.now(); ticks.forEach(listener => listener()); };
const resume = () => { clearInterval(ticker); ticker = undefined; if (!document.hidden && ticks.size) { tick(); ticker = setInterval(tick, 500); } };
function subscribe(listener: () => void) {
  ticks.add(listener);
  if (ticks.size === 1) { document.addEventListener('visibilitychange', resume); resume(); }
  return () => { ticks.delete(listener); if (!ticks.size) { document.removeEventListener('visibilitychange', resume); clearInterval(ticker); ticker = undefined; } };
}
const still = () => () => {};
type Clock = { session: GuildSnapshot['session'] | undefined; receivedAt: number; live: boolean };
// With no current song there is no timeline, whatever position an idle snapshot still carries.
function usePosition({ session, receivedAt, live }: Clock) {
  const track = session?.current;
  const moving = !!track && session.status === 'playing' && live;
  const clock = useSyncExternalStore(moving ? subscribe : still, () => moving ? now : 0);
  if (!track) return 0;
  const duration = session.durationMs || track.durationMs || 0;
  return Math.min(duration || Infinity, Math.max(0, (session.positionMs || 0) + (moving ? Math.max(0, clock - receivedAt) : 0)));
}
function Timeline({ clock, track, duration, seekable, reset, onSeek }: { clock: Clock; track: Track | null; duration: number; seekable: boolean; reset?: string; onSeek: (value: number) => void }) {
  const position = usePosition(clock);
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => { setScrub(null); }, [track?.id, reset]);
  const seek = () => { if (scrub === null) return; const value = scrub; setScrub(null); if (seekable) onSeek(value); };
  return <div className={`timeline ${track?.isStream ? 'is-live' : ''}`}>
    <span>{track?.isStream ? 'LIVE' : time(scrub ?? position)}</span>
    <input className="range seek-range" aria-label="Playback position" type="range" min={0} max={duration || 1} step={1000} value={scrub ?? Math.min(position, duration || 1)} disabled={!seekable}
      aria-valuetext={track?.isStream ? 'Live stream' : `${time(scrub ?? position)} of ${time(duration)}`}
      style={{ '--range-progress': `${Math.min(100, ((scrub ?? position) / (duration || 1)) * 100)}%` } as React.CSSProperties}
      onChange={event => setScrub(Number(event.target.value))} onPointerUp={seek} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) seek(); }} onBlur={seek} />
    <span>{track?.isStream ? 'Streaming' : time(duration)}</span>
  </div>;
}
// Synced lyrics follow the shared clock; only a change of sung line re-renders the panel.
function LyricsView({ id, clock, guildId, trackId, local }: { id: string; clock: Clock; guildId?: string; trackId: string | null; local: boolean }) {
  const [state, retry] = useLyrics(guildId, trackId, local);
  const position = usePosition(clock);
  const lyrics = state.status === 'found' ? state.lyrics : null;
  return <LyricsPanel id={id} state={state} active={activeLine(lyrics, position)} onRetry={retry} />;
}
// Early in a song Back goes to the previous one; later, or with nothing earlier, it restarts this one.
function BackButton({ clock, seekable, disabled, title, onPress }: { clock: Clock; seekable: boolean; disabled: boolean; title?: string; onPress: (back: boolean) => void }) {
  const position = usePosition(clock);
  const back = !!clock.session?.hasPrevious && (position <= RESTART_AFTER_MS || !seekable);
  return <IconButton label={back ? 'Previous song' : 'Restart current song'} disabled={back ? disabled : !seekable} title={title} onClick={() => onPress(back)}><SkipBackIcon size={27} weight="fill" /></IconButton>;
}
// The compact deck's passive progress hairline; it glides between ticks on the compositor.
function CompactProgress({ clock, track, duration }: { clock: Clock; track: Track | null; duration: number }) {
  const position = usePosition(clock);
  return <span className="compact-progress" aria-hidden="true" style={{ '--progress-scale': track && !track.isStream && duration ? Math.min(1, position / duration) : 0 } as React.CSSProperties} />;
}
