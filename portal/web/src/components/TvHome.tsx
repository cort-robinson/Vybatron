import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { CheckIcon, ListNumbersIcon, PauseIcon, PlayIcon, SkipForwardIcon, SparkleIcon, SpeakerHifiIcon, SquaresFourIcon } from '../icons';
import type { Portal } from '../usePortal';
import type { Command } from '../types';
import type { Palette } from '../art';
import type { Skin } from '../skin';
import { useVisualizer } from '../visualizer/load';
import { PRESETS, choosePreset, usePreset, type PresetId } from '../visualizer/presets';
import type { Visualizer } from '../visualizer/engine';
import { focusEntry, topLayer } from '../tv';
import { useEvent } from '../stable';
import { ActionPopover, Artwork, Dialog, IconButton, Loading } from './ui';
import { BackButton, MoveHereDialog, PlayOnChoices, Timeline, Volume } from './Player';
import { Queue } from './Queue';
import { Spectrum } from './Spectrum';
import { timestamp } from '../format';

// How long the controls stay up without input.
export const TV_CONTROLS_MS = 5000;
const revealKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ']);

// The TV's first screen (ADR-0019): the visualizer over the whole screen, the song in large type,
// and the controls a remote needs: play and pause, previous, next, seek, volume, Play on, the queue
// and the rest of the portal. Up, Down or OK bring the controls up; they hide again after a few
// seconds without input, and focus waits on the screen itself until they return.
export function TvHome({ portal, palette, skin, place, onBrowse, onAdd }: { portal: Portal; palette: Palette; skin: Skin; place: string; onBrowse: () => void; onAdd: () => void }) {
  const { snapshot, can, run, receivedAt, connection } = portal;
  const session = snapshot?.session; const track = session?.current || null;
  const local = portal.target === 'local';
  const live = local || connection === 'live';
  const clock = { session, receivedAt, live };
  const [failed, setFailed] = useState(false);
  const visuals = useVisualizer(!failed, () => setFailed(true));
  // The look, chosen here as in the full-screen visualizer (one choice for both), and MilkDrop's
  // preset showing, for its name and Next preset.
  const preset = usePreset(skin); const engine = useRef<Visualizer | null>(null); const [named, setNamed] = useState('');
  const [shown, setShown] = useState(true); const showing = useRef(true);
  const [queueOpen, setQueueOpen] = useState(false);
  const [confirmHere, setConfirmHere] = useState(false);
  const root = useRef<HTMLElement>(null); const controls = useRef<HTMLDivElement>(null);
  const play = useRef<HTMLButtonElement>(null); const last = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hide = useEvent(() => {
    const element = root.current; if (!element) return;
    // A menu or dialog open over the screen keeps the controls up.
    if (queueOpen || confirmHere || topLayer() !== element) { stir(); return; }
    if (element.contains(document.activeElement) && document.activeElement !== element) {
      last.current = document.activeElement;
      element.focus({ preventScroll: true });
    }
    showing.current = false; setShown(false);
  });
  const stir = useEvent(() => { clearTimeout(timer.current); timer.current = setTimeout(hide, TV_CONTROLS_MS); });
  const reveal = useEvent((focus: boolean) => {
    if (!showing.current) {
      showing.current = true; flushSync(() => setShown(true));
      // Focus returns to the control it left, or play.
      if (focus && controls.current) focusEntry(controls.current, last.current ?? play.current);
    }
    stir();
  });
  useLayoutEffect(() => {
    stir();
    return () => clearTimeout(timer.current);
  }, []);
  // Focus starts on play, once there is something to play; until a key moves it.
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current && showing.current && controls.current && document.activeElement !== play.current) focusEntry(controls.current, play.current);
  });
  useEffect(() => {
    // Any key keeps the controls up; while they're hidden, the arrows and OK only bring them back.
    const keydown = (event: KeyboardEvent) => {
      moved.current = true;
      if (showing.current) { stir(); return; }
      if (!revealKeys.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopPropagation(); reveal(true);
    };
    const pointer = (event: globalThis.PointerEvent) => { if (event.pointerType === 'mouse') reveal(false); else stir(); };
    const press = () => { moved.current = true; };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('pointermove', pointer, true);
    window.addEventListener('pointerdown', press, true);
    return () => { window.removeEventListener('keydown', keydown, true); window.removeEventListener('pointermove', pointer, true); window.removeEventListener('pointerdown', press, true); };
  }, [reveal, stir]);
  // A touch on the picture shows or hides the controls.
  const touch = (event: PointerEvent) => { if (event.pointerType !== 'mouse') { if (showing.current) hide(); else reveal(true); } };
  const controllable = can('control');
  const duration = track ? session?.durationMs || track.durationMs || 0 : 0;
  const seekable = controllable && !!track && !track.isStream && duration > 0 && !['recovering', 'unavailable'].includes(session?.status || '');
  const control = (body: Command) => run({ ...body, expectedRevision: snapshot?.revision }, 'control');
  const active = session?.status === 'playing';
  const blockedTitle = !controllable ? portal.blockedReason : undefined;
  const fallback = <div className="tv-fallback"><Artwork track={track} large /><Spectrum className="tv-spectrum" seed={track?.id || 'idle'} color={palette.accent} mode={track && active && live ? 'playing' : 'standby'} animate bands={48} /></div>;
  return <section ref={root} className={`tv-home ${shown ? '' : 'resting'}`} aria-label="Now playing" tabIndex={-1} data-tv-layer data-testid="tv-home">
    <div className="tv-stage" onPointerDown={touch}>{visuals && !failed
      ? <visuals.BackdropVisualizer clock={clock} palette={palette} skin={skin} guildId={snapshot?.guild.id ?? null} local={local} engine={engine} onName={setNamed} onFail={() => setFailed(true)} />
      : failed ? fallback : null}</div>
    <div className="tv-overlay">
      <div className="tv-now">{track && <Artwork track={track} />}<div className="tv-song">
        <p className="tv-place">{place}</p>
        <h1 title={track?.title}>{track?.title || (snapshot ? 'Nothing playing' : 'Getting your music…')}</h1>
        <p>{track ? track.author : snapshot ? 'Add a song to start.' : ''}</p></div></div>
      {!snapshot && <Loading />}
      <div ref={controls} className="tv-controls" inert={!shown}>
        <Timeline clock={clock} track={track} duration={duration} seekable={seekable} reset={snapshot?.guild.id} onSeek={value => void control({ command: 'seek', options: { timestamp: timestamp(value) } })} />
        <div className="tv-transport" role="group" aria-label="Playback controls">
          <BackButton clock={clock} seekable={seekable} disabled={!controllable} title={blockedTitle} onPress={back => void control(back ? { command: 'back' } : { command: 'seek', options: { timestamp: '00:00' } })} />
          <button ref={play} type="button" className="icon-button play-button" aria-label={active ? 'Pause playback' : 'Resume playback'} disabled={!controllable || !track || !['playing', 'paused'].includes(session?.status || '')} title={blockedTitle ?? (active ? 'Pause playback' : 'Resume playback')}
            onClick={() => void control({ command: active ? 'pause' : 'resume' })}>{active ? <PauseIcon size={31} weight="fill" /> : <PlayIcon size={31} weight="fill" />}</button>
          <IconButton label="Skip current song" disabled={!controllable || !track} title={blockedTitle} onClick={() => void control({ command: 'skip' })}><SkipForwardIcon size={27} weight="fill" /></IconButton>
          <Volume level={session?.volume ?? 100} disabled={!controllable} reset={`${track?.id}:${snapshot?.guild.id}`} onCommit={level => void control({ command: 'volume', options: { level } })} />
          <div className="tv-actions">
            <ActionPopover label="Play on" className="tv-menu tv-play-on" triggerClassName="button secondary tv-action" trigger={<><SpeakerHifiIcon size={22} />Play on</>}>
              {close => <PlayOnChoices portal={portal} close={close} onMoveHere={() => setConfirmHere(true)} />}</ActionPopover>
            <button type="button" className="button secondary tv-action" onClick={() => setQueueOpen(true)}><ListNumbersIcon size={22} />Queue</button>
            {!failed && <ActionPopover label="Visualizer" className="tv-menu tv-looks" triggerClassName="button secondary tv-action" trigger={<><SparkleIcon size={22} />Visualizer</>}>
              {() => <LookChoices preset={preset} named={named} onNext={() => engine.current?.next()} />}</ActionPopover>}
            <button type="button" className="button secondary tv-action" onClick={onBrowse}><SquaresFourIcon size={22} />Browse</button>
          </div>
        </div>
      </div>
    </div>
    {queueOpen && <Dialog title="Up next" className="tv-queue" onClose={() => setQueueOpen(false)}><Queue portal={portal} compact onAdd={() => { setQueueOpen(false); onAdd(); }} /></Dialog>}
    {confirmHere && <MoveHereDialog portal={portal} onClose={() => setConfirmHere(false)} />}
  </section>;
}

// The looks the full-screen visualizer offers, as a menu a remote can use. It opens on the look
// showing, which is marked; a choice applies at once (and is kept, as everywhere) with the menu left
// open to try another. MilkDrop adds a way on to its next preset, where it then opens, so OK can
// press it again and again.
function LookChoices({ preset, named, onNext }: { preset: PresetId; named: string; onNext: () => void }) {
  const milkdrop = preset === 'milkdrop';
  return <><p className="menu-section">Visualizer</p>
    {milkdrop && <button type="button" data-autofocus onClick={onNext}><SkipForwardIcon weight="fill" />Next preset</button>}
    {milkdrop && named && <p className="tv-preset-name" title={named}><span className="sr-only">Showing </span>{named}</p>}
    {PRESETS.map(item => <button key={item.id} type="button" aria-pressed={preset === item.id} data-autofocus={!milkdrop && preset === item.id || undefined} onClick={() => choosePreset(item.id)}>
      <span className="menu-device"><span>{item.name}</span></span>{preset === item.id && <CheckIcon className="menu-check" weight="bold" />}</button>)}
  </>;
}
