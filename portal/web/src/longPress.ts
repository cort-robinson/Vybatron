// Holding a song row on a touch screen opens its menu, as phone music apps do. A hold that moves
// (a scroll) or lifts early is an ordinary touch, and the tap that ends a hold never presses what
// was under the finger. Rows opt in by containing a .row-menu trigger.
const hold = 480;
const wobble = 10;

export function longPress(root: Document | HTMLElement = document) {
  let timer = 0; let origin: { x: number; y: number; pointer: number } | null = null; let held = -1; let suppressUntil = 0;
  const cancel = () => { clearTimeout(timer); origin = null; };
  const triggerFor = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest('input, select, textarea, a, .drag-handle, .row-menu, .menu-panel, dialog')) return null;
    const trigger = target.closest('li')?.querySelector<HTMLButtonElement>(':scope > .row-menu > button');
    return trigger && !trigger.disabled ? trigger : null;
  };
  const down = (event: Event) => {
    const pointer = event as PointerEvent;
    cancel();
    if (pointer.pointerType === 'mouse' || !pointer.isPrimary) return;
    const trigger = triggerFor(pointer.target);
    if (!trigger) return;
    origin = { x: pointer.clientX, y: pointer.clientY, pointer: pointer.pointerId };
    timer = window.setTimeout(() => {
      held = pointer.pointerId; origin = null;
      navigator.vibrate?.(10);
      trigger.click();
    }, hold);
  };
  const move = (event: Event) => {
    const pointer = event as PointerEvent;
    if (origin?.pointer === pointer.pointerId && Math.hypot(pointer.clientX - origin.x, pointer.clientY - origin.y) > wobble) cancel();
  };
  // The tap that ends a hold follows its pointerup at once; nothing after that is swallowed.
  const lift = (event: Event) => {
    if ((event as PointerEvent).pointerId === held) { held = -1; if (event.type === 'pointerup') suppressUntil = performance.now() + 300; }
    cancel();
  };
  const swallow = (event: Event) => { if (performance.now() < suppressUntil) { event.preventDefault(); event.stopPropagation(); suppressUntil = 0; } };
  // A held row would otherwise raise the browser's own context menu or start selecting its text.
  const context = (event: Event) => { if ((origin || held >= 0) && triggerFor(event.target)) event.preventDefault(); };
  root.addEventListener('pointerdown', down, true); root.addEventListener('pointermove', move, true);
  root.addEventListener('pointerup', lift, true); root.addEventListener('pointercancel', lift, true);
  root.addEventListener('click', swallow, true); root.addEventListener('contextmenu', context, true);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', down, true); root.removeEventListener('pointermove', move, true);
    root.removeEventListener('pointerup', lift, true); root.removeEventListener('pointercancel', lift, true);
    root.removeEventListener('click', swallow, true); root.removeEventListener('contextmenu', context, true);
  };
}
