import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Lyrics, LyricsResponse } from '../types';
import { prefersReducedMotion } from '../motion';
import './lyrics.css';

type Status = LyricsResponse['status'] | 'loading' | 'local';
export type LyricsState = { status: Status; lyrics: Lyrics | null };

// Answers for songs already looked up, so reopening the panel or returning to a song doesn't refetch.
// Failures are never kept.
const answers = new Map<string, LyricsResponse>();
function remember(key: string, answer: LyricsResponse) {
  answers.delete(key); answers.set(key, answer);
  if (answers.size > 24) answers.delete(answers.keys().next().value!);
}

// Lyrics follow the Discord session's current song; this device's own songs have none.
export function useLyrics(guildId: string | undefined, trackId: string | null, local: boolean): [LyricsState, () => void] {
  const [state, setState] = useState<LyricsState>({ status: 'loading', lyrics: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (local) { setState({ status: 'local', lyrics: null }); return; }
    if (!guildId || !trackId) { setState({ status: 'idle', lyrics: null }); return; }
    const key = `${guildId}:${trackId}`;
    const known = answers.get(key);
    if (known) { setState({ status: known.status, lyrics: known.lyrics }); return; }
    setState({ status: 'loading', lyrics: null });
    const controller = new AbortController();
    api.lyrics(guildId, controller.signal).then(answer => {
      if (answer.trackId && answer.status !== 'unavailable') remember(`${guildId}:${answer.trackId}`, answer);
      // The bot already moved to another song; its snapshot will follow and reuse this answer.
      if (answer.trackId && answer.trackId !== trackId) return;
      setState({ status: answer.trackId ? answer.status : 'idle', lyrics: answer.trackId ? answer.lyrics : null });
    }, () => { if (!controller.signal.aborted) setState({ status: 'unavailable', lyrics: null }); });
    return () => controller.abort();
  }, [guildId, trackId, local, attempt]);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  return [state, retry];
}

// The last synced line that has started, or -1 before the first one.
export function activeLine(lyrics: Lyrics | null, positionMs: number) {
  if (!lyrics?.synced) return -1;
  let active = -1;
  for (let index = 0; index < lyrics.lines.length; index++) {
    const start = lyrics.lines[index].startMs;
    if (start === null || start > positionMs) break;
    active = index;
  }
  return active;
}

const messages: Record<Exclude<Status, 'found'>, string> = {
  loading: 'Loading lyrics…',
  idle: 'Lyrics show here while a song is playing.',
  not_found: 'No lyrics found for this song.',
  unavailable: 'Lyrics are unavailable right now.',
  local: 'Lyrics are available for songs playing in Discord.',
};

export const LyricsPanel = memo(function LyricsPanel({ id, state, active, onRetry }: { id: string; state: LyricsState; active: number; onRetry: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const touchedAt = useRef(0);
  const lyrics = state.status === 'found' ? state.lyrics : null;
  // Keep the sung line in view, unless the listener scrolled to read ahead or back in the last few seconds.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const line = active >= 0 ? panel?.querySelector<HTMLElement>(`[data-line="${active}"]`) : null;
    if (!panel || !line || Date.now() - touchedAt.current < 4000) return;
    const top = line.offsetTop - panel.clientHeight / 2 + line.offsetHeight / 2;
    panel.scrollTo({ top: Math.max(0, top), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, [active, lyrics]);
  useEffect(() => { panelRef.current?.scrollTo({ top: 0 }); touchedAt.current = 0; }, [lyrics]);
  const touched = () => { touchedAt.current = Date.now(); };
  if (!lyrics) {
    return <div id={id} className="lyrics-panel lyrics-empty" role="status">
      {state.status === 'loading' && <span className="spinner" aria-hidden="true" />}
      <p>{messages[state.status as Exclude<Status, 'found'>]}</p>
      {state.status === 'unavailable' && <button type="button" className="button secondary" onClick={onRetry}>Try again</button>}
    </div>;
  }
  return <div ref={panelRef} id={id} className={`lyrics-panel ${lyrics.synced ? 'synced' : 'plain'}`} role="region" aria-label="Lyrics" tabIndex={0}
    onWheel={touched} onTouchMove={touched} onKeyDown={touched}>
    <ol className="lyrics-lines">
      {lyrics.lines.map((line, index) => line.text
        ? <li key={index} data-line={index} className={index === active ? 'current' : index < active ? 'past' : undefined} aria-current={index === active ? 'true' : undefined}>{line.text}</li>
        : <li key={index} className="lyrics-break" aria-hidden="true" />)}
    </ol>
    <p className="lyrics-credit">{lyrics.provider ? `Lyrics from ${lyrics.provider}` : 'Lyrics'}{lyrics.synced ? '' : ' · not synced to playback'}</p>
  </div>;
});
