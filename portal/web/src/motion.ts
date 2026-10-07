import { flushSync } from 'react-dom';

// One motion vocabulary for state changes. View Transitions carry continuity (the cover
// travels between deck and sleeve, views slide along the nav's axis); styles.css owns
// which elements are named for each kind. Unsupported browsers change state instantly.
export type MotionKind = 'expand' | 'collapse' | 'view' | 'tab';
export type MotionDirection = 'forward' | 'back';

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
let generation = 0;

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function transition(kind: MotionKind, update: () => void, direction: MotionDirection = 'forward') {
  const doc = document as TransitionDocument;
  if (!doc.startViewTransition || document.hidden) { update(); return; }
  const root = document.documentElement;
  const token = ++generation;
  // Reduced motion keeps a short whole-page crossfade: nothing is named, so nothing travels.
  root.dataset.motion = prefersReducedMotion() ? 'reduced' : kind;
  root.dataset.direction = direction;
  doc.startViewTransition(() => flushSync(update)).finished.catch(() => undefined).finally(() => {
    if (token !== generation) return;
    delete root.dataset.motion; delete root.dataset.direction;
  });
}

// Short acknowledgement on an element whose state just changed under it.
export function pulse(elements: Iterable<Element>, keyframes: Keyframe[], duration = 320) {
  if (prefersReducedMotion() || document.hidden) return;
  for (const element of elements) element.animate(keyframes, { duration, easing: 'cubic-bezier(.16, 1, .3, 1)' });
}
