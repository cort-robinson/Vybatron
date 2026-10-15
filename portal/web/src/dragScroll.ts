// A mouse has no sideways swipe, so a sideways shelf scrolls when dragged. Touch and pen keep
// native scrolling; a press that moves under the threshold stays an ordinary click, and the
// click that ends a real drag is swallowed so a card's button never fires by accident.
const threshold = 6;

export function dragScroll(element: HTMLElement | null) {
  if (!element) return;
  let pointer = -1; let startX = 0; let startScroll = 0; let dragging = false; let suppress = false;
  let lastX = 0; let lastTime = 0; let velocity = 0; let frame = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const overflowing = () => element.scrollWidth - element.clientWidth > 1;
  const settle = () => { element.classList.remove('dragging'); };
  const glide = () => {
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min(32, now - previous); previous = now;
      element.scrollLeft += velocity * elapsed; velocity *= Math.exp(-elapsed / 180);
      if (Math.abs(velocity) > .02) frame = requestAnimationFrame(step); else { frame = 0; settle(); }
    };
    frame = requestAnimationFrame(step);
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || !overflowing()) return;
    if ((event.target as Element).closest('input, select, textarea, [contenteditable="true"]')) return;
    cancelAnimationFrame(frame); frame = 0;
    pointer = event.pointerId; startX = lastX = event.clientX; startScroll = element.scrollLeft; lastTime = event.timeStamp; velocity = 0; dragging = false;
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    const distance = event.clientX - startX;
    if (!dragging) {
      if (Math.abs(distance) < threshold) return;
      dragging = true; element.setPointerCapture(pointer); element.classList.add('dragging');
    }
    element.scrollLeft = startScroll - distance;
    const elapsed = event.timeStamp - lastTime;
    if (elapsed > 0) velocity = .8 * ((lastX - event.clientX) / elapsed) + .2 * velocity;
    lastX = event.clientX; lastTime = event.timeStamp;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    pointer = -1;
    if (!dragging) return;
    dragging = false; suppress = true; setTimeout(() => { suppress = false; }, 0);
    // A drag that stopped before release should not fling.
    if (event.timeStamp - lastTime > 80 || reduced()) { velocity = 0; settle(); } else glide();
  };
  const click = (event: MouseEvent) => { if (suppress) { event.preventDefault(); event.stopPropagation(); suppress = false; } };
  const dragStart = (event: DragEvent) => event.preventDefault();
  const sync = () => element.classList.toggle('can-drag', overflowing());
  // Size changes and late-loading cards both change overflow; hovering re-checks before a grab.
  const observer = new ResizeObserver(sync); observer.observe(element); sync();
  element.addEventListener('pointerenter', sync);
  element.addEventListener('pointerdown', down); element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', up); element.addEventListener('pointercancel', up);
  element.addEventListener('click', click, true); element.addEventListener('dragstart', dragStart);
  return () => {
    cancelAnimationFrame(frame); observer.disconnect(); element.removeEventListener('pointerenter', sync);
    element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', up); element.removeEventListener('pointercancel', up);
    element.removeEventListener('click', click, true); element.removeEventListener('dragstart', dragStart);
  };
}
