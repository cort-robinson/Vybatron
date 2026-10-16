import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Palette } from '../art';

// Paint each cover's large gradients once, then let the compositor dissolve them. Keep the
// outgoing room opaque until its replacement is complete, including during rapid skips.
export function RoomLight({ palette, instant, quick, children }: { palette: Palette; instant: boolean; quick: boolean; children: (prepared: boolean) => ReactNode }) {
  const key = (value: Palette) => [value.accent, ...value.glow, value.ground].join(',');
  const [layers, setLayers] = useState([{ palette, prepared: false }]);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const latest = useRef(palette); latest.current = palette;
  const fading = layers.length > 1;
  const finish = () => setLayers(current => {
    const shown = current.at(-1)!;
    return key(shown.palette) === key(latest.current) ? [shown] : [shown, { palette: latest.current, prepared: true }];
  });
  useLayoutEffect(() => {
    if (layers.length < 2) return;
    const outgoing = elements.current.get(key(layers[0].palette));
    const incoming = elements.current.get(key(layers[1].palette));
    if (!outgoing || !incoming) return;
    const clocks = new Map<string, CSSAnimation[]>();
    for (const animation of outgoing.getAnimations({ subtree: true })) {
      if (animation instanceof CSSAnimation && animation.animationName !== 'room-relight') {
        const group = clocks.get(animation.animationName) || [];
        group.push(animation); clocks.set(animation.animationName, group);
      }
    }
    // The palette changes, but the grid, train, drifting cover and lights keep their place.
    for (const animation of incoming.getAnimations({ subtree: true })) {
      if (!(animation instanceof CSSAnimation) || animation.animationName === 'room-relight') continue;
      const previous = clocks.get(animation.animationName)?.shift();
      if (previous?.currentTime != null) animation.currentTime = previous.currentTime;
    }
  }, [layers]);
  useEffect(() => {
    if (instant) { setLayers([{ palette, prepared: true }]); return; }
    setLayers(current => current.length > 1 || key(current[0].palette) === key(palette) ? current : [current[0], { palette, prepared: true }]);
  }, [palette, instant]);
  // A hidden page or reduced motion must never leave a half-finished room behind.
  useEffect(() => {
    if (!fading || instant) return;
    const timer = setTimeout(finish, quick ? 300 : 2200);
    return () => clearTimeout(timer);
  }, [layers, instant, quick]);
  return <>{layers.map(({ palette: layer, prepared }, index) => <div key={key(layer)} ref={element => { if (element) elements.current.set(key(layer), element); else elements.current.delete(key(layer)); }} className={`room-colors ${prepared ? 'room-prepared' : ''} ${index ? 'room-incoming' : ''}`} style={{ '--accent': layer.accent, '--ground': layer.ground, '--glow-1': layer.glow[0], '--glow-2': layer.glow[1], '--glow-3': layer.glow[2], '--room-duration': quick ? '300ms' : '2200ms' } as CSSProperties}>
    <div className="room-light">{layer.glow.map((color, i) => <span key={i} className={`light light-${i + 1}`} style={{ '--light-color': color } as CSSProperties} />)}</div>
    {children(prepared)}
  </div>)}</>;
}
