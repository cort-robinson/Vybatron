import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '../icons';
import type { Palette } from '../art';
import type { Skin } from '../skin';
import { prefersReducedMotion } from '../motion';
import { usePosition, type Clock } from '../position';
import { time } from '../format';
import { IconButton } from '../components/ui';
import { startVisualizer, type View, type Visualizer } from './engine';
import { PRESETS, choosePreset, usePreset } from './presets';
import type { Source } from './signal';
import { youtubeId } from '../youtube';

// local: the song plays on this device rather than in Discord.
type Scene = { clock: Clock; palette: Palette; skin: Skin; guildId: string | null; local: boolean };
// How far the Discord audio someone hears trails the position Lavalink reports: Discord's own
// network and playout buffering, less the snapshot's trip to this page, which already makes the
// page's clock run a little behind. A best estimate, tunable; this device's own player reports
// the position it is playing, so it needs none.
export const DISCORD_LAG_MS = 120;
// The speed presets (src/utils/filters.js) run a song's own time faster or slower than the clock.
// This device's player plays songs as they are.
const RATES: Record<string, number> = { nightcore: 1.12, slow: .85 };
// Where the song is, as the engine needs it: it advances the position itself between snapshots.
function useView({ clock, palette, skin, guildId, local }: Scene, animate: boolean, full: boolean, lite: boolean): View {
  const { session, receivedAt, live } = clock; const track = session?.current;
  return { preset: usePreset(skin), seed: track?.id || 'idle', playing: !!track && session?.status === 'playing' && live, positionMs: track ? session?.positionMs || 0 : 0, at: receivedAt, palette, animate, full, lite,
    guildId, video: track && !track.isStream ? youtubeId(track.uri) : null, lagMs: local ? 0 : DISCORD_LAG_MS, rate: local ? 1 : RATES[session?.filter || ''] || 1 };
}

// The canvas is made here rather than rendered, so every mount (React's development double mount
// included) gets a context of its own that the engine can release when it unmounts.
function Stage({ view, className, onFail, onSource, onDoubleClick }: { view: View; className: string; onFail: () => void; onSource?: (source: Source) => void; onDoubleClick?: () => void }) {
  const host = useRef<HTMLDivElement>(null); const engine = useRef<Visualizer | null>(null);
  const fail = useRef(onFail); fail.current = onFail; const sourced = useRef(onSource); sourced.current = onSource;
  useEffect(() => {
    const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); host.current!.append(canvas);
    engine.current = startVisualizer(canvas, () => fail.current(), source => sourced.current?.(source));
    return () => { engine.current?.stop(); engine.current = null; canvas.remove(); };
  }, []);
  const { preset, seed, playing, positionMs, at, palette, animate, full, lite, guildId, video, lagMs, rate } = view;
  useEffect(() => { engine.current?.update({ preset, seed, playing, positionMs, at, palette, animate, full, lite, guildId, video, lagMs, rate }); }, [preset, seed, playing, positionMs, at, palette, animate, full, lite, guildId, video, lagMs, rate]);
  return <div ref={host} className={className} aria-hidden="true" onDoubleClick={onDoubleClick} />;
}

// In the open player, in the cover's place and box (it is an .artwork, so each look frames it).
export function SleeveVisualizer({ animate, onFail, onFull, ...scene }: Scene & { animate: boolean; onFail: () => void; onFull: () => void }) {
  return <Stage className="artwork sleeve-visualizer" view={useView(scene, animate, false, false)} onFail={onFail} onDoubleClick={onFull} />;
}

// The takeover: the visualizer fills the screen; the song, its position, the presets and a way out
// sit over it and fade after a few seconds without input, returning on any pointer or key. A touch
// on the picture shows or hides them. It is a modal dialog, so the page and the room beneath hold
// still, and focus returns to whatever opened it.
const REST_MS = 3200;
// Without WebGL2 it shows the fallback it is given (the player's spectrum) instead.
export function FullscreenVisualizer({ onClose, fallback, ...scene }: Scene & { onClose: () => void; fallback: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const name = useId(); const preset = usePreset(scene.skin);
  const [reduced] = useState(prefersReducedMotion);
  // Performance mode still animates a visualizer someone opened on purpose, at lower resolution.
  const [lite] = useState(() => document.documentElement.hasAttribute('data-performance'));
  const [failed, setFailed] = useState(false); const [source, setSource] = useState<Source>('ambient');
  const [resting, setResting] = useState(false); const rested = useRef(false); const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rest = (value: boolean) => { clearTimeout(timer.current); if (rested.current !== value) { rested.current = value; setResting(value); } };
  const stir = () => { rest(false); timer.current = setTimeout(() => rest(true), REST_MS); };
  useLayoutEffect(() => {
    const element = dialog.current!; const previous = document.activeElement as HTMLElement | null;
    element.showModal(); stir();
    return () => {
      clearTimeout(timer.current); element.close();
      if (previous?.isConnected && !previous.closest('[inert], [hidden]') && previous.getClientRects().length) previous.focus({ preventScroll: true });
    };
  }, []);
  const view = useView(scene, !reduced, true, lite);
  const touch = (event: PointerEvent) => { if (event.pointerType === 'mouse') stir(); else if (rested.current) stir(); else rest(true); };
  const { session } = scene.clock; const track = session?.current;
  return createPortal(<dialog ref={dialog} className={`visualizer-full ${resting ? 'resting' : ''}`} aria-label="Visualizer"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => { stir(); if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose(); } }}
    onPointerMove={event => { if (event.pointerType === 'mouse') stir(); }} onFocus={stir}>
    <div className="visualizer-screen" onPointerDown={touch}>{failed
      ? fallback
      : <Stage className="visualizer-stage" view={view} onFail={() => setFailed(true)} onSource={setSource} />}</div>
    <div className="visualizer-chrome">
      <header className="visualizer-now"><div className="visualizer-track"><h2>{track?.title || 'Nothing playing'}</h2><p>{track ? track.author : 'Add a song to start.'}</p><Progress clock={scene.clock} /></div>
        <IconButton className="visualizer-close" label="Close visualizer" onClick={onClose}><XIcon size={26} /></IconButton></header>
      <footer className="visualizer-controls">
        <fieldset className="visualizer-presets"><legend className="sr-only">Visualizer</legend>
          {PRESETS.map(item => <label key={item.id}><input type="radio" name={name} value={item.id} checked={preset === item.id} onChange={() => choosePreset(item.id)} /><span>{item.name}</span></label>)}</fieldset>
        {/* Live: the song's measured energy. Ambient: a pattern made for the song, not its audio. Say which plainly. */}
        <span className="visualizer-source">{source === 'live' ? 'Live' : 'Ambient'}<span className="sr-only">{source === 'live' ? ': moving with this song’s measured energy' : ': motion made for this song, not taken from its audio'}</span></span>
      </footer>
    </div>
  </dialog>, document.body);
}

// The song's position, on the shared clock: only this readout re-renders as it advances.
function Progress({ clock }: { clock: Clock }) {
  const position = usePosition(clock); const track = clock.session?.current;
  if (!track) return null;
  if (track.isStream) return <p className="visualizer-time">Live stream</p>;
  const duration = clock.session?.durationMs || track.durationMs || 0;
  return <p className="visualizer-time"><span>{time(position)}</span><span className="visualizer-progress" aria-hidden="true"><span style={{ transform: `scaleX(${duration ? Math.min(1, position / duration) : 0})` }} /></span><span><span className="sr-only">of </span>{time(duration)}</span></p>;
}
