import { flushSync } from 'react-dom';

// One motion vocabulary for state changes. View Transitions carry continuity between views (they
// slide along the nav's axis) and looks; styles.css owns which elements are named for each kind.
// Opening and closing the player glides instead (below). Reduced motion and unsupported browsers
// change state instantly; the CSS keeps its short fades for those paths.
export type MotionKind = 'expand' | 'collapse' | 'view' | 'tab' | 'theme';
export type MotionDirection = 'forward' | 'back';

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
let generation = 0;

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function transition(kind: MotionKind, update: () => void, direction: MotionDirection = 'forward') {
  const doc = document as TransitionDocument;
  const still = document.hidden || prefersReducedMotion();
  if (kind === 'expand' || kind === 'collapse') {
    if (still) { update(); return; }
    const glide = playerGlide(kind);
    flushSync(update); glide();
    return;
  }
  if (!doc.startViewTransition || still) { update(); return; }
  const root = document.documentElement;
  const token = ++generation;
  root.dataset.motion = kind;
  root.dataset.direction = direction;
  doc.startViewTransition(() => flushSync(update)).finished.catch(() => undefined).finally(() => {
    if (token !== generation) return;
    delete root.dataset.motion; delete root.dataset.direction;
  });
}

// Opening and closing the player glide on the compositor. A view transition there rendered the old
// page once more to capture it and restyled the whole document as it started and ended, which made
// the player hitch every time. Instead each moving piece is measured before and after the change
// and animated from its old box to its new one as a transform: the cover flies between the deck and
// the sleeve, the play control and the nav marker follow, and scenery marked data-travel moves
// between the browse and sleeve layouts (animating its top/left/size repainted the scene every
// frame). The page fades out under the sleeve (styles.css) and back in as it closes.
const sheet = 'cubic-bezier(.32, .72, 0, 1)';
const gliding = new WeakMap<Element, Animation>();
const underway = (animation: Animation | undefined): animation is Animation => !!animation && animation.playState !== 'finished' && animation.playState !== 'idle';
const travelling = (element: Element) => underway(gliding.get(element));
let flight = 0;
let flying: { slot: string; animation: Animation } | null = null;

// The cover's element can be replaced mid-flight: a song without artwork swaps the picture for the
// fallback cover, and stopping swaps it for the empty sleeve. The replacement occupies the same box,
// so it takes over the same flight (Artwork calls this as each cover mounts) instead of appearing
// at its destination.
export function adoptFlight(element: Element | null) {
  const animation = flying?.animation; const effect = animation?.effect;
  if (!element || !underway(animation) || !(effect instanceof KeyframeEffect) || effect.target === element || !element.matches(flying!.slot)) return;
  effect.target = element; gliding.set(element, animation);
}
type Box = { x: number; y: number; width: number; height: number };
const boxOf = (rect: DOMRect): Box => ({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });

function glide(element: Element, from: Box, to: Box, timing: KeyframeAnimationOptions): Animation | undefined {
  if (!from.width || !from.height || !to.width || !to.height) return;
  const sx = from.width / to.width; const sy = from.height / to.height;
  // Translate and scale about the element's own transform origin.
  const [ox, oy] = getComputedStyle(element).transformOrigin.split(' ').map(parseFloat);
  const dx = from.x - to.x + (sx - 1) * ox; const dy = from.y - to.y + (sy - 1) * oy;
  if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .002 && Math.abs(sy - 1) < .002) return;
  const animation = element.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transform: 'none' }], timing);
  gliding.set(element, animation);
  // A cover that has just appeared holds at its starting box until its picture is decoded (briefly),
  // so it flies the whole way rather than first showing up partway along.
  if (element instanceof HTMLImageElement) {
    animation.pause();
    // Only a flight still held at its start resumes; one paused elsewhere stays where it was put.
    const start = () => { if (gliding.get(element) === animation && animation.playState === 'paused' && animation.currentTime === 0) animation.play(); };
    void element.decode().catch(() => undefined).then(start); setTimeout(start, 150);
  }
  return animation;
}

function playerGlide(kind: 'expand' | 'collapse') {
  const covers = ['.player-expand-trigger > .artwork', '.sleeve-artwork > .artwork'];
  const [coverFrom, coverTo] = kind === 'expand' ? covers : [covers[1], covers[0]];
  const timing = { duration: kind === 'expand' ? 480 : 360, easing: sheet };
  // A piece measured mid-flight (or mid-swipe) starts again from wherever it is now.
  const pieces = [
    { from: coverFrom, to: coverTo, timing },
    { from: '.transport .play-button', to: '.transport .play-button', timing },
    { from: '.nav-indicator', to: '.nav-indicator', timing: { duration: 380, easing: sheet } },
  ].map(piece => ({ ...piece, box: document.querySelector(piece.from)?.getBoundingClientRect() }));
  const scenery = new Map([...document.querySelectorAll('[data-travel]')].map(element => [element, element.getBoundingClientRect()] as const));
  return () => {
    const targets = pieces.map(piece => ({ ...piece, element: document.querySelector(piece.to) }));
    for (const element of [...targets.map(target => target.element), ...scenery.keys()]) if (element) gliding.get(element)?.cancel();
    // The cover starts over the deck and, on phones, outside the sleeve's scrolling area. Until it
    // lands, the player lets it fly above both and holds a song's dissolve layer (styles.css).
    const token = ++flight; const player = targets[0].element?.closest<HTMLElement>('.persistent-player');
    if (player) player.dataset.coverFlight = '';
    const covered = targets.map(({ element, box, timing: pieceTiming }) => element && box ? glide(element, boxOf(box), boxOf(element.getBoundingClientRect()), pieceTiming) : undefined)[0];
    flying = covered ? { slot: targets[0].to, animation: covered } : null;
    const land = () => { if (token === flight) { flying = null; delete player?.dataset.coverFlight; } };
    if (covered) covered.finished.then(land, land); else land();
    const after = new Map([...scenery.keys()].filter(element => element.isConnected).map(element => [element, element.getBoundingClientRect()] as const));
    // Nested scenery starts in its travelling ancestor's own (new) frame, so it follows the ancestor.
    const local = (element: Element, rect: DOMRect, from: boolean): Box => {
      const parent = element.parentElement?.closest('[data-travel]');
      const parentFrom = parent && scenery.get(parent); const parentTo = parent && after.get(parent);
      if (!parentFrom || !parentTo || !parentTo.width || !parentTo.height) return boxOf(rect);
      const anchor = from ? parentFrom : parentTo; const sx = from ? parentFrom.width / parentTo.width : 1; const sy = from ? parentFrom.height / parentTo.height : 1;
      return { x: (rect.left - anchor.left) / sx, y: (rect.top - anchor.top) / sy, width: rect.width / sx, height: rect.height / sy };
    };
    for (const [element, to] of after) glide(element, local(element, scenery.get(element)!, true), local(element, to, false), { duration: 900, easing: 'cubic-bezier(.16, 1, .3, 1)' });
    // The page returns under the closing sleeve (a hidden page has no style to transition from).
    if (kind === 'collapse') document.querySelector('.surface-stage')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
  };
}

// Short acknowledgement on an element whose state just changed under it. A piece that is still
// gliding into place skips it: the newer transform would snap it out of its flight.
export function pulse(elements: Iterable<Element>, keyframes: Keyframe[], duration = 320) {
  if (prefersReducedMotion() || document.hidden) return;
  for (const element of elements) if (!travelling(element)) element.animate(keyframes, { duration, easing: 'cubic-bezier(.16, 1, .3, 1)' });
}

// A modal dialog's backdrop blurs the page beneath it, and the compositor blurs it again for every
// frame in which anything beneath it moves. Decorative motion (the room, the spectrum, the chrome's
// loops in the looks' stylesheets) holds still while one is open.
let modalOpen = false;
const modalListeners = new Set<() => void>();
let modalWatch: MutationObserver | null = null;
const checkModal = () => {
  let open: boolean;
  try { open = !!document.querySelector('dialog[open]:modal'); } catch { open = !!document.querySelector('dialog[open]'); }
  if (open === modalOpen) return;
  modalOpen = open;
  for (const listener of modalListeners) listener();
};
export const underModal = () => modalOpen;
// Under a modal other than the one holding this element (a full-screen visualizer's own dialog
// doesn't cover its canvas). It queries the page, so call it when onModal fires, not per frame.
export function coveredByModal(element: Element) {
  if (!modalOpen) return false;
  let modals: Element[];
  try { modals = [...document.querySelectorAll('dialog[open]:modal')]; } catch { modals = [...document.querySelectorAll('dialog[open]')]; }
  const own = element.closest('dialog');
  return modals.some(modal => modal !== own);
}
export function onModal(listener: () => void) {
  if (!modalWatch) {
    modalWatch = new MutationObserver(checkModal);
    modalWatch.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
    checkModal();
  }
  modalListeners.add(listener);
  return () => {
    modalListeners.delete(listener);
    if (!modalListeners.size) { modalWatch?.disconnect(); modalWatch = null; modalOpen = false; }
  };
}
