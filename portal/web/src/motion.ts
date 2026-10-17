import { flushSync } from 'react-dom';

// One motion vocabulary for state changes. View Transitions carry continuity (the cover
// travels between deck and sleeve, views slide along the nav's axis); styles.css owns
// which elements are named for each kind. Reduced motion and unsupported browsers change
// state instantly; the CSS keeps its short fades for those paths.
export type MotionKind = 'expand' | 'collapse' | 'view' | 'tab' | 'theme';
export type MotionDirection = 'forward' | 'back';

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
let generation = 0;

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function transition(kind: MotionKind, update: () => void, direction: MotionDirection = 'forward') {
  const doc = document as TransitionDocument;
  const still = document.hidden || prefersReducedMotion();
  // Opening and closing the sleeve moves the scenery; it travels to its new place, never jumps.
  const travel = !still && (kind === 'expand' || kind === 'collapse') ? sceneryTravel() : null;
  if (!doc.startViewTransition || still) { if (travel) { flushSync(update); travel(); } else update(); return; }
  const root = document.documentElement;
  const token = ++generation;
  root.dataset.motion = kind;
  root.dataset.direction = direction;
  doc.startViewTransition(() => { flushSync(update); travel?.(); }).finished.catch(() => undefined).finally(() => {
    if (token !== generation) return;
    delete root.dataset.motion; delete root.dataset.direction;
  });
}

// Scenery marked data-travel changes size and place between browse and the sleeve. Animating
// top/left/width there re-laid out and repainted the scene every frame for most of a second, under
// the view transition's live snapshot. Instead each piece is measured before and after the change
// and glides from its old box to its new one as a transform, which the compositor runs alone.
const travelling = new WeakMap<Element, Animation>();
const travelTiming: KeyframeAnimationOptions = { duration: 900, easing: 'cubic-bezier(.16, 1, .3, 1)' };
type Box = { x: number; y: number; width: number; height: number };
function sceneryTravel() {
  // Measured mid-flight, a piece starts again from wherever it is now.
  const before = new Map([...document.querySelectorAll('[data-travel]')].map(element => [element, element.getBoundingClientRect()] as const));
  return () => {
    for (const element of before.keys()) travelling.get(element)?.cancel();
    const after = new Map([...before.keys()].filter(element => element.isConnected).map(element => [element, element.getBoundingClientRect()] as const));
    // Nested pieces start in their travelling ancestor's own (new) frame, so they follow it.
    const local = (element: Element, rect: DOMRect, from: boolean): Box => {
      const parent = element.parentElement?.closest('[data-travel]');
      const parentFrom = parent && before.get(parent); const parentTo = parent && after.get(parent);
      if (!parentFrom || !parentTo || !parentTo.width || !parentTo.height) return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const anchor = from ? parentFrom : parentTo; const sx = from ? parentFrom.width / parentTo.width : 1; const sy = from ? parentFrom.height / parentTo.height : 1;
      return { x: (rect.left - anchor.left) / sx, y: (rect.top - anchor.top) / sy, width: rect.width / sx, height: rect.height / sy };
    };
    for (const [element, to] of after) {
      const from = before.get(element)!;
      if (!from.width || !from.height || !to.width || !to.height) continue;
      const start = local(element, from, true); const end = local(element, to, false);
      const sx = start.width / end.width; const sy = start.height / end.height;
      // Translate and scale about the element's own transform origin.
      const [ox, oy] = getComputedStyle(element).transformOrigin.split(' ').map(parseFloat);
      const dx = start.x - end.x + (sx - 1) * ox; const dy = start.y - end.y + (sy - 1) * oy;
      if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .002 && Math.abs(sy - 1) < .002) continue;
      travelling.set(element, element.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }], travelTiming));
    }
  };
}

// Short acknowledgement on an element whose state just changed under it.
export function pulse(elements: Iterable<Element>, keyframes: Keyframe[], duration = 320) {
  if (prefersReducedMotion() || document.hidden) return;
  for (const element of elements) element.animate(keyframes, { duration, easing: 'cubic-bezier(.16, 1, .3, 1)' });
}
