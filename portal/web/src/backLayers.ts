import { useEffect, useRef } from 'react';

// The system Back gesture closes what is open over the page (the queue sheet, then the player)
// before it leaves the portal. Each open layer owns one history entry; closing a layer any other way
// consumes its entry, so one thing never takes two Backs.
export function useBackLayers(depth: number, close: (depth: number) => void) {
  const pushed = useRef(0);
  const closeTo = useRef(close); closeTo.current = close;
  useEffect(() => {
    if (depth > pushed.current) for (let layer = pushed.current + 1; layer <= depth; layer++) history.pushState({ ...history.state, vybatronLayer: layer }, '');
    else if (depth < pushed.current) history.go(depth - pushed.current);
    pushed.current = depth;
  }, [depth]);
  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const layer = Number(event.state?.vybatronLayer) || 0;
      if (layer < pushed.current) { pushed.current = layer; closeTo.current(layer); }
      // Forward into a closed layer has nothing to reopen; return to where the page really is.
      else if (layer > pushed.current) history.go(pushed.current - layer);
    };
    addEventListener('popstate', pop);
    return () => removeEventListener('popstate', pop);
  }, []);
}
