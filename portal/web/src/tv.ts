// The portal with a remote (ADR-0019): on a TV the arrow keys move focus to the nearest control in
// the pressed direction, within the topmost open layer (a menu, then a dialog, then the now-playing
// screen, then the page). A slider or text field is focused like any control; OK starts editing it,
// and the arrows then change its value or move the caret until OK or Back stops editing.
//
// TV mode starts from the app (`app.info` `form: "tv"`) or, for testing in a browser, from `?tv=1`,
// kept for the tab in sessionStorage (`?tv=0` turns it off). Nothing here runs outside TV mode
// except `closeTopLayer`, which the app's Back uses in every form.

const FLAG = 'vybertron.tv';
/** Whether the address (now or earlier in this tab) asked for TV mode. */
export function tvFlag(): boolean {
  try {
    const asked = new URLSearchParams(location.search).get('tv');
    if (asked === '1') sessionStorage.setItem(FLAG, '1');
    else if (asked === '0') sessionStorage.removeItem(FLAG);
    return sessionStorage.getItem(FLAG) === '1';
  } catch { return false; }
}

type Direction = 'up' | 'down' | 'left' | 'right';
const directions: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const focusable = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]';
// Fields whose arrows belong to the field: they wait for OK before taking them.
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);
const isRange = (element: Element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'range';
export const editable = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && (element.type === 'range' || textTypes.has(element.type));
const isText = (element: Element) => editable(element) && !isRange(element);

function shown(element: HTMLElement) {
  if (element.closest('[inert], [hidden]')) return false;
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  return typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true });
}
function candidates(layer: ParentNode) {
  return Array.from(layer.querySelectorAll<HTMLElement>(focusable)).filter(element =>
    element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && shown(element));
}

// Modal dialogs in the order they opened: the last still open is on top.
const dialogs: HTMLDialogElement[] = [];
function track(dialog: HTMLDialogElement) {
  const at = dialogs.indexOf(dialog); if (at >= 0) dialogs.splice(at, 1);
  if (dialog.open) dialogs.push(dialog);
}
function topDialog() {
  for (let index = dialogs.length - 1; index >= 0; index--) {
    const dialog = dialogs[index];
    if (dialog.open && dialog.isConnected && !dialog.closest('[inert]')) return dialog;
    if (!dialog.open || !dialog.isConnected) dialogs.splice(index, 1);
  }
  return null;
}
function topMenu() {
  const menus = Array.from(document.querySelectorAll<HTMLElement>('.menu-panel')).filter(menu => !menu.closest('[inert]'));
  return menus[menus.length - 1] ?? null;
}
/** The topmost open layer: focus stays inside it. */
export function topLayer(): HTMLElement {
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[data-tv-layer]')).filter(layer => !layer.closest('[inert], [hidden]'));
  return topMenu() ?? topDialog() ?? layers[layers.length - 1] ?? document.body;
}

// How far a candidate is in the pressed direction: the gap along it, plus the gap across it (twice
// as costly, so a control in line wins over a nearer one off to the side), and a little of the
// offset between centers to settle ties. Only candidates ahead of the focused control count: a
// wide slider above a row of buttons isn't to the right of any of them.
function score(from: DOMRect, to: DOMRect, direction: Direction) {
  const horizontal = direction === 'left' || direction === 'right';
  const [fromStart, fromEnd, toStart, toEnd] = horizontal ? [from.left, from.right, to.left, to.right] : [from.top, from.bottom, to.top, to.bottom];
  const [crossFromStart, crossFromEnd, crossToStart, crossToEnd] = horizontal ? [from.top, from.bottom, to.top, to.bottom] : [from.left, from.right, to.left, to.right];
  const forward = direction === 'right' || direction === 'down';
  const fromCenter = (fromStart + fromEnd) / 2; const toCenter = (toStart + toEnd) / 2;
  const across = Math.max(0, crossToStart - crossFromEnd, crossFromStart - crossToEnd);
  // Wholly past the focused control's far edge, or beside it (sharing some of its row or column)
  // and further along at both edges.
  const beyond = forward ? toStart >= fromEnd - 4 : toEnd <= fromStart + 4;
  const beside = across === 0 && (forward ? toStart > fromStart && toEnd > fromEnd && toCenter > fromCenter + 1 : toStart < fromStart && toEnd < fromEnd && toCenter < fromCenter - 1);
  if (!beyond && !beside) return Infinity;
  const along = Math.max(0, forward ? toStart - fromEnd : fromStart - toEnd);
  const offset = Math.abs((crossToStart + crossToEnd) / 2 - (crossFromStart + crossFromEnd) / 2);
  return along + across * 2 + offset * .1;
}
/** The control focus moves to from `from` in `direction`, within `layer`. */
export function nearest(from: HTMLElement, direction: Direction, layer: ParentNode = topLayer()) {
  const origin = from.getBoundingClientRect();
  let best: HTMLElement | null = null; let bestScore = Infinity;
  for (const element of candidates(layer)) {
    if (element === from || element.contains(from) || from.contains(element)) continue;
    const value = score(origin, element.getBoundingClientRect(), direction);
    if (value < bestScore) { best = element; bestScore = value; }
  }
  return best;
}
// With nothing focused in the layer, the first press lands on its chosen control, or its first.
function entry(layer: HTMLElement) {
  const preferred = layer.querySelector<HTMLElement>('[data-tv-autofocus]');
  if (preferred && candidates(layer).includes(preferred)) return preferred;
  return candidates(layer).sort((a, b) => {
    const one = a.getBoundingClientRect(); const two = b.getBoundingClientRect();
    return Math.abs(one.top - two.top) > 8 ? one.top - two.top : one.left - two.left;
  })[0] ?? null;
}
/** Focuses `preferred` if it can take focus, or the layer's own first control. */
export function focusEntry(layer: HTMLElement, preferred?: Element | null) {
  const target = preferred instanceof HTMLElement && preferred.isConnected && candidates(layer).includes(preferred) ? preferred : entry(layer);
  target?.focus({ preventScroll: true });
  return !!target;
}
function move(to: HTMLElement) {
  to.focus({ preventScroll: true });
  to.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Editing: the field that has the arrows. A text field shows no keyboard until it's edited.
let editing: HTMLInputElement | HTMLTextAreaElement | null = null;
const keyboards = new WeakMap<HTMLElement, string | null>();
function quiet(element: HTMLElement) {
  if (!isText(element) || keyboards.has(element)) return;
  keyboards.set(element, element.getAttribute('inputmode'));
  element.setAttribute('inputmode', 'none');
}
function restoreKeyboard(element: HTMLElement) {
  if (!keyboards.has(element)) return;
  const mode = keyboards.get(element); keyboards.delete(element);
  if (mode === null || mode === undefined) element.removeAttribute('inputmode'); else element.setAttribute('inputmode', mode);
}
export function startEditing(element: HTMLInputElement | HTMLTextAreaElement) {
  if (editing === element) return;
  stopEditing();
  editing = element; element.dataset.tvEditing = '';
  if (isText(element)) {
    restoreKeyboard(element);
    // The caret starts after what is already typed.
    try { const end = element.value.length; element.setSelectionRange(end, end); } catch { /* Not every type has a caret. */ }
    (navigator as Navigator & { virtualKeyboard?: { show(): void } }).virtualKeyboard?.show();
  }
}
/** Stops editing the field that has the arrows, if any. */
export function stopEditing(): boolean {
  const element = editing; if (!element) return false;
  editing = null; delete element.dataset.tvEditing;
  if (document.activeElement === element) quiet(element);
  return true;
}
export const isEditing = () => !!editing && editing.isConnected;

// A slider's step for a remote: `data-tv-step` (ten seconds of a song, five points of volume), not
// the one-unit steps a keyboard's arrows make.
function step(range: HTMLInputElement, direction: Direction) {
  const size = Number(range.dataset.tvStep); if (!(size > 0)) return false;
  const min = Number(range.min || 0); const max = Number(range.max || 100);
  const next = Math.min(max, Math.max(min, Number(range.value) + (direction === 'right' || direction === 'up' ? size : -size)));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, String(next));
  range.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

// Escape (a keyboard's Back) stops editing before a dialog or menu sees it.
function captureKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !isEditing()) return;
  event.preventDefault(); event.stopPropagation(); stopEditing();
}
// After the page's own handlers, so a control that uses a key itself keeps it.
function key(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const direction = directions[event.key];
  if (editing && editing !== active) stopEditing();
  if (editing) {
    if (event.key === 'Enter') {
      // OK stops editing; a text field's Enter still submits its form.
      if (isRange(editing)) event.preventDefault();
      stopEditing();
    } else if (direction && isRange(editing) && step(editing, direction)) event.preventDefault();
    return;
  }
  if (event.key === 'Enter' && active) {
    if (editable(active) && !active.readOnly && !active.disabled) { event.preventDefault(); startEditing(active); return; }
    // OK on a remote is Enter, which doesn't check a box or pick a radio button by itself.
    if (active instanceof HTMLInputElement && (active.type === 'checkbox' || active.type === 'radio')) { event.preventDefault(); active.click(); }
    return;
  }
  if (!direction) return;
  const layer = topLayer();
  const inLayer = active && layer.contains(active) && candidates(layer).includes(active);
  // A control that would use the arrows itself never gets them while it isn't being edited.
  const control = active && (editable(active) || active instanceof HTMLSelectElement || active instanceof HTMLInputElement);
  if (control) event.preventDefault();
  const target = inLayer ? nearest(active, direction, layer) : entry(active && layer.contains(active) ? active : layer) ?? entry(layer);
  if (!target) return;
  event.preventDefault();
  move(target);
}
function focusIn(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target !== editing) quiet(event.target);
}
function focusOut(event: FocusEvent) {
  if (event.target === editing) stopEditing();
}

/** Turns TV mode on: arrow-key focus movement, edit mode and the TV look. Returns how to turn it off. */
export function startTvMode(): () => void {
  const root = document.documentElement;
  root.dataset.tv = '';
  document.querySelectorAll('dialog[open]').forEach(dialog => track(dialog as HTMLDialogElement));
  const observer = new MutationObserver(records => {
    for (const record of records) if (record.target instanceof HTMLDialogElement) track(record.target);
  });
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
  window.addEventListener('keydown', captureKey, true);
  document.addEventListener('keydown', key);
  document.addEventListener('focusin', focusIn);
  document.addEventListener('focusout', focusOut);
  if (document.activeElement instanceof HTMLElement) quiet(document.activeElement);
  return () => {
    stopEditing();
    delete root.dataset.tv;
    observer.disconnect(); dialogs.length = 0;
    window.removeEventListener('keydown', captureKey, true);
    document.removeEventListener('keydown', key);
    document.removeEventListener('focusin', focusIn);
    document.removeEventListener('focusout', focusOut);
  };
}

/**
 * Back's first step (the app asks the page before it acts, ADR-0019): closes the topmost menu or
 * dialog the way Escape does, and says whether there was one. Works in every form, TV or not.
 */
export function closeTopLayer(): boolean {
  const layer = topMenu() ?? openDialog();
  if (!layer) return false;
  const active = document.activeElement;
  const target = active instanceof HTMLElement && layer.contains(active) ? active : layer;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  return true;
}
// Outside TV mode dialogs aren't tracked; the one holding focus is the one on top.
function openDialog(): HTMLElement | null {
  const tracked = topDialog(); if (tracked) return tracked;
  const active = document.activeElement?.closest('dialog[open]');
  if (active instanceof HTMLDialogElement) return active;
  const open = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter(dialog => !dialog.closest('[inert]'));
  return open[open.length - 1] ?? null;
}
