import { prefersReducedMotion } from './motion';

// Touch moves things the way phone music apps do: drag the compact deck up to open the player, pull
// the open player or a sheet down to close it, push the current song aside to change it. What moves
// follows the finger; a long or quick enough pull commits, anything less springs back. Mouse input
// never starts a swipe, so desktop clicks and text selection are unchanged. A swipe that ends on a
// button never presses it. The innermost surface along an axis owns a touch, so a sheet inside the
// player closes the sheet rather than the player.
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';
// `settle` clears the drag offset. Call it inside the state change so the transition starts from
// where the finger left off instead of snapping back first. Return false to spring back instead.
export type SwipeCommit = (direction: SwipeDirection, settle: () => void) => boolean | void;
const slop = 4;

export function swipe(element: HTMLElement | null, directions: SwipeDirection | SwipeDirection[], commit: SwipeCommit, moving: HTMLElement | null = element) {
  if (!element || !moving) return;
  const allowed = ([] as SwipeDirection[]).concat(directions);
  const axis = allowed[0] === 'left' || allowed[0] === 'right' ? 'x' : 'y';
  const owner = axis === 'x' ? 'swipeX' : 'swipeY';
  const along = (dx: number, dy: number) => axis === 'x' ? dx : dy;
  const named = (delta: number): SwipeDirection => axis === 'x' ? delta < 0 ? 'left' : 'right' : delta < 0 ? 'up' : 'down';
  // Opening the player is a nudge: the deck lifts a little and the transition does the travelling.
  const nudge = allowed.length === 1 && allowed[0] === 'up';
  let start: { x: number; y: number } | null = null;
  let engaged = false; let distance = 0; let velocity = 0; let last = 0; let lastTime = 0; let suppressUntil = 0;
  element.dataset[owner] = '';
  const settle = () => { element.classList.remove('swiping'); moving.style.transform = ''; moving.style.opacity = ''; };
  const springBack = () => {
    const from = { transform: moving.style.transform || 'none', opacity: moving.style.opacity || '1' };
    settle();
    if (!prefersReducedMotion()) moving.animate([from, { transform: 'none', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  };
  // Pulling down from content that has scrolled away from its top scrolls it back first.
  const scrolled = (target: Element) => {
    for (let node: Element | null = target; node && node !== element.parentElement; node = node.parentElement) if (node.scrollTop > 0) return true;
    return false;
  };
  const blocked = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest('input, select, textarea, .drag-handle')) return true;
    const layer = target.closest('.menu-panel, dialog');
    if (layer && layer !== element && element.contains(layer)) return true;
    return target.closest(`[data-swipe-${axis}]`) !== element || allowed.includes('down') && scrolled(target);
  };
  const size = () => axis === 'x' ? moving.offsetWidth : element.offsetHeight;
  const follow = (delta: number) => {
    if (nudge) { moving.style.transform = `translateY(${-Math.min(56, Math.max(0, -delta) * .35)}px)`; return; }
    const offset = allowed.includes(named(delta)) ? delta : 0;
    moving.style.transform = axis === 'x' ? `translateX(${offset}px)` : `translateY(${offset}px)`;
    moving.style.opacity = String(1 - Math.min(axis === 'x' ? .6 : .25, Math.abs(offset) / size() / (axis === 'x' ? 1 : 2)));
  };
  const begin = (event: TouchEvent) => {
    if (engaged) springBack();
    engaged = false;
    start = event.touches.length === 1 && !blocked(event.target) ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    last = 0; lastTime = event.timeStamp; velocity = 0; distance = 0;
  };
  const move = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.touches[0];
    const dx = touch.clientX - start.x; const dy = touch.clientY - start.y;
    const delta = along(dx, dy); const across = axis === 'x' ? dy : dx;
    if (!engaged) {
      if (Math.abs(dx) < slop && Math.abs(dy) < slop) return;
      // Movement along the other axis, the wrong way, or a scroll the browser already owns is not a swipe.
      if (Math.abs(across) >= Math.abs(delta) || !allowed.includes(named(delta)) || !event.cancelable) { start = null; return; }
      engaged = true; element.classList.add('swiping');
    }
    event.preventDefault();
    const elapsed = event.timeStamp - lastTime;
    if (elapsed > 0) velocity = .8 * ((delta - last) / elapsed) + .2 * velocity;
    last = delta; lastTime = event.timeStamp; distance = delta;
    follow(delta);
  };
  const end = (event: TouchEvent) => {
    if (!start || event.touches.length) return;
    start = null;
    if (!engaged) return;
    engaged = false; suppressUntil = event.timeStamp + 400;
    // A finger that stopped before lifting carries no fling.
    const fling = event.timeStamp - lastTime > 80 ? 0 : velocity;
    const direction = named(distance);
    const far = nudge ? distance < -40 || fling < -.35 && distance < -16
      : Math.abs(distance) > Math.min(140, size() * (axis === 'x' ? .3 : .25)) || Math.sign(fling) === Math.sign(distance) && Math.abs(fling) > .45 && Math.abs(distance) > 32;
    if (event.type === 'touchend' && allowed.includes(direction) && far && commit(direction, settle) !== false) return;
    springBack();
  };
  const click = (event: MouseEvent) => { if (event.timeStamp < suppressUntil) { event.preventDefault(); event.stopPropagation(); } };
  element.addEventListener('touchstart', begin, { passive: true });
  element.addEventListener('touchmove', move, { passive: false });
  element.addEventListener('touchend', end); element.addEventListener('touchcancel', end);
  element.addEventListener('click', click, true);
  return () => {
    settle(); delete element.dataset[owner];
    element.removeEventListener('touchstart', begin); element.removeEventListener('touchmove', move);
    element.removeEventListener('touchend', end); element.removeEventListener('touchcancel', end);
    element.removeEventListener('click', click, true);
  };
}
