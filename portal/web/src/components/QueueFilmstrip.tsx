import type { Track } from '../types';
import { CaretRightIcon } from '../icons';
import { Artwork } from './ui';

// A preview of the real queue. Its single action opens the full list, including an empty queue.
export function QueueFilmstrip({ tracks, onOpen }: { tracks: Track[]; onOpen: () => void }) {
  return <div className="queue-filmstrip">
    <button className="filmstrip-open" onClick={onOpen} aria-label="Open full queue">
      Up next<CaretRightIcon size={20} aria-hidden="true" />
    </button>
    {tracks.length ? <ol>{tracks.slice(0, 3).map((track, index) => <li key={index}>
      <Artwork track={track} /><div><strong>{track.title}</strong><span>{track.author}</span></div>
    </li>)}</ol> : <p>Nothing queued yet</p>}
  </div>;
}
