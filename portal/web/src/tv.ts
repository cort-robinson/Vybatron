// The portal with a remote (ADR-0019): on a TV the arrow keys move focus to the next control in the
// pressed direction, within the topmost open layer (a menu, then a dialog, then the now-playing
// screen, then the page). They follow the page's rows and columns: Left and Right keep to a row,
// Up and Down go row by row in line with the column, the page's parts (content, navigation, header,
// player) hand focus back where it was, and focus never lands off the screen or under fixed chrome.
// A slider or text field is focused like any control; OK starts editing it, and the arrows then
// change its value or move the caret until OK or Back stops editing.
//
// TV mode starts from the app (`app.info` `form: "tv"`) or, for testing in a browser, from `?tv=1`,
// kept for the tab in sessionStorage. `?tv=0` turns it off, even in the app on a TV. Nothing here
// runs outside TV mode except `closeTopLayer`, which the app's Back uses in every form.

const FLAG = 'vybertron.tv';
/** What the address (now or earlier in this tab) asked for: TV mode on, off, or nothing. */
export function tvChoice(): boolean | null {
  try {
    const asked = new URLSearchParams(location.search).get('tv');
    if (asked === '1' || asked === '0') sessionStorage.setItem(FLAG, asked);
    const kept = sessionStorage.getItem(FLAG);
    return kept === '1' ? true : kept === '0' ? false : null;
  } catch { return null; }
}
/** Whether the address asked for TV mode. */
export const tvFlag = () => tvChoice() === true;

type Direction = 'up' | 'down' | 'left' | 'right';
const directions: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const focusable = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]';
// Fields whose arrows belong to the field: they wait for OK before taking them.
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'password']);
const isRange = (element: Element): element is HTMLInputElement => element instanceof HTMLInputElement && element.type === 'range';
export const editable = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement && (element.type === 'range' || textTypes.has(element.type));
const isText = (element: Element) => editable(element) && !isRange(element);


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

// Where focus can go. Containers mark the page's parts for the arrows:
// - `data-tv-region`: a part of the screen (the page's content, its header, the navigation, the
//   player). The arrows stay inside it while it has a control that way; leaving it, focus goes to the
//   control it last had, or the navigation's current page.
// - `data-tv-group`: a row of its own (a shelf). Coming back to it, focus returns to the control it
//   last had there.
type Item = { element: HTMLElement; box: DOMRect };
type Range = { start: number; end: number };
const memory = new WeakMap<Element, HTMLElement>();

const onScreen = (box: DOMRect) => box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
// Whether an element is in fixed chrome (the player, the tab bar, a dialog), which the page's
// scrolling doesn't move.
function fixedIn(element: Element, stop: Element | null, cache: Map<Element, boolean>): boolean {
  if (!element || element === stop || element === document.documentElement) return false;
  const known = cache.get(element); if (known !== undefined) return known;
  const value = getComputedStyle(element).position === 'fixed' || !!element.parentElement && fixedIn(element.parentElement, stop, cache);
  cache.set(element, value);
  return value;
}
// A control off the screen is reachable only if something scrolls it into view: a scrolling box
// around it (a shelf, a long dialog), or the page, unless it sits in fixed chrome or before the
// page's start (a skip link parked above the top).
type Scrolls = Map<Element, 'scrolls' | 'fixed' | 'still'>;
function reachable(element: HTMLElement, box: DOMRect, scrolls: Scrolls) {
  if (onScreen(box)) return true;
  for (let node: Element | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    let kind = scrolls.get(node);
    if (!kind) {
      const style = getComputedStyle(node);
      kind = node !== element && /auto|scroll/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth) ? 'scrolls' : style.position === 'fixed' ? 'fixed' : 'still';
      scrolls.set(node, kind);
    }
    if (kind !== 'still') return kind === 'scrolls';
  }
  return box.bottom + scrollY > 0 && box.right + scrollX > 0;
}
function shown(element: HTMLElement, scrolls: Scrolls = new Map()) {
  if (element.closest('[inert], [hidden]')) return false;
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1 || !reachable(element, box, scrolls)) return false;
  return typeof element.checkVisibility !== 'function' || element.checkVisibility({ visibilityProperty: true });
}
function candidates(layer: ParentNode) {
  const scrolls: Scrolls = new Map();
  return Array.from(layer.querySelectorAll<HTMLElement>(focusable)).filter(element =>
    element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled && shown(element, scrolls));
}
// A focusable container (a sideways shelf, a tab stop for scrolling) is never a target itself on a
// TV: its controls are.
function leaves(list: HTMLElement[]) {
  const all = new Set<Element>(list); const containers = new Set<Element>();
  for (const element of list) for (let node = element.parentElement; node; node = node.parentElement) if (all.has(node)) containers.add(node);
  return list.filter(element => !containers.has(element));
}

const isHorizontal = (direction: Direction) => direction === 'left' || direction === 'right';
const isForward = (direction: Direction) => direction === 'right' || direction === 'down';
const along = (box: DOMRect, direction: Direction): Range => isHorizontal(direction) ? { start: box.left, end: box.right } : { start: box.top, end: box.bottom };
const across = (box: DOMRect, direction: Direction): Range => isHorizontal(direction) ? { start: box.top, end: box.bottom } : { start: box.left, end: box.right };
const overlap = (one: Range, two: Range) => Math.min(one.end, two.end) - Math.max(one.start, two.start);
const gap = (one: Range, two: Range) => Math.max(0, two.start - one.end, one.start - two.end);
// Ahead of `from` in the pressed direction: wholly past its far edge, or beside it (sharing some of
// its row or column) and further along at both edges. A wide slider above a row of buttons isn't to
// the right of any of them.
function ahead(from: DOMRect, to: DOMRect, direction: Direction) {
  const one = along(from, direction); const two = along(to, direction); const forward = isForward(direction);
  if (forward ? two.start >= one.end - 4 : two.end <= one.start + 4) return true;
  const centre = (range: Range) => (range.start + range.end) / 2;
  return overlap(across(from, direction), across(to, direction)) >= 0
    && (forward ? two.start > one.start && two.end > one.end && centre(two) > centre(one) + 1 : two.start < one.start && two.end < one.end && centre(two) < centre(one) - 1);
}
const distance = (from: DOMRect, to: DOMRect, direction: Direction) => {
  const one = along(from, direction); const two = along(to, direction);
  return Math.max(0, isForward(direction) ? two.start - one.end : one.start - two.end);
};
function least<T>(list: T[], key: (item: T) => number[]) {
  let best: T | null = null; let bestKey: number[] = [];
  for (const item of list) {
    const value = key(item);
    const index = value.findIndex((part, at) => part !== bestKey[at]);
    if (!best || index >= 0 && value[index] < bestKey[index]) { best = item; bestKey = value; }
  }
  return best;
}
// How far off a row a control may sit and still count as in it.
const LEVEL = 24;
// The control the pressed arrow moves to among `items`, keeping to lines a remote can follow:
// - Left and right stay in the row: only controls sharing some of it count, nearest first.
// - Up and down go to the next row (the nearest control that way and those level with it), and in
//   it to the control in line with the column focus keeps to: sharing some of it (the one starting
//   nearest its start), or failing that the nearest beside it.
function lane(origin: DOMRect, items: Item[], direction: Direction, column: Range, loose = true): Item | null {
  let ahead_ = items.filter(item => ahead(origin, item.box, direction));
  if (!ahead_.length) return null;
  if (isHorizontal(direction)) {
    // A card's button a little lower than its neighbour's still shares the row.
    const row = across(origin, direction);
    const inRow = ahead_.filter(item => overlap(across(item.box, direction), row) > 0);
    const nearRow = inRow.length || !loose ? inRow : ahead_.filter(item => gap(across(item.box, direction), row) <= LEVEL);
    return least(nearRow, item => [gap(across(item.box, direction), row), distance(origin, item.box, direction), -overlap(across(item.box, direction), row)]);
  }
  // Up and down pass over the controls level with this one off to its side: those are its row.
  const sideways = (item: Item) => overlap(across(item.box, direction), across(origin, direction)) <= 0 && gap(along(item.box, direction), along(origin, direction)) <= LEVEL;
  if (ahead_.some(item => !sideways(item))) ahead_ = ahead_.filter(item => !sideways(item));
  const next = least(ahead_, item => [distance(origin, item.box, direction), gap(across(item.box, direction), column)])!;
  const level = along(next.box, direction); const middle = (level.start + level.end) / 2;
  const row = ahead_.filter(item => { const range = along(item.box, direction); return isForward(direction) ? range.start < middle : range.end > middle; });
  return least(row, item => {
    const range = across(item.box, direction);
    return overlap(range, column) > 0 ? [0, Math.abs(range.start - column.start)] : [1, gap(range, column), distance(origin, item.box, direction)];
  });
}
// The fallback for leaving chrome when nothing is in line: the gap along the direction, plus the
// gap across it (twice as costly), and a little of the offset between centers to settle ties.
function score(from: DOMRect, to: DOMRect, direction: Direction) {
  const fromAcross = across(from, direction); const toAcross = across(to, direction);
  const offset = Math.abs((toAcross.start + toAcross.end) / 2 - (fromAcross.start + fromAcross.end) / 2);
  return distance(from, to, direction) + gap(fromAcross, toAcross) * 2 + offset * .1;
}

// The region or group around an element, within the layer.
function within(element: Element, layer: Element, attribute: string) {
  for (let node = element.parentElement; node && node !== layer; node = node.parentElement) if (node.hasAttribute(attribute)) return node;
  return null;
}
const regionOf = (element: Element, layer: Element) => within(element, layer, 'data-tv-region') ?? layer;
const groupOf = (element: Element, layer: Element) => within(element, layer, 'data-tv-group');
const kind = (region: Element) => region.getAttribute('data-tv-region');
function remember(element: HTMLElement) {
  for (let node = element.parentElement; node; node = node.parentElement) if (node.hasAttribute('data-tv-region') || node.hasAttribute('data-tv-group')) memory.set(node, element);
}
// A region's or group's way in: the navigation's current page, then the control it last had (if
// that is the way the arrow points), then the one the arrow found.
function arrive(found: Item, container: Element | null, items: Item[], origin: DOMRect, direction: Direction): Item {
  if (!container) return found;
  const pick = (element: Element | null | undefined) => element ? items.find(item => item.element === element) : undefined;
  const current = kind(container) === 'nav' ? pick(container.querySelector('[aria-current="page"]')) : undefined;
  // The page's content and its shelves remember; the chrome (the player's buttons) is spatial.
  const remembered = kind(container) === 'content' || container.hasAttribute('data-tv-group') ? pick(memory.get(container)) : undefined;
  return current ?? (remembered && ahead(origin, remembered.box, direction) ? remembered : found);
}

// The column Up and Down keep to, while they keep moving focus: a row's wide header button between
// two shelves doesn't pull the next shelf's focus across the screen.
let column: { element: HTMLElement; range: Range } | null = null;
/** The control focus moves to from `from` in `direction`, within `layer`, if any. */
export function nearest(from: HTMLElement, direction: Direction, layer: HTMLElement = topLayer()) {
  return travel(from, direction, layer)?.element ?? null;
}
function travel(from: HTMLElement, direction: Direction, layer: HTMLElement): (Item & { keep: boolean }) | null {
  const origin = from.getBoundingClientRect();
  const items = leaves(candidates(layer)).filter(element => element !== from && !element.contains(from) && !from.contains(element)).map(element => ({ element, box: element.getBoundingClientRect() }));
  const lineUp = !isHorizontal(direction) && column?.element === from ? column.range : across(origin, direction);
  const region = regionOf(from, layer); const group = groupOf(from, layer);
  const inside = (container: Element) => items.filter(item => container.contains(item.element));
  // Within the shelf for Left and Right, then within the region.
  const near = (isHorizontal(direction) && group ? lane(origin, inside(group), direction, lineUp) : null) ?? lane(origin, inside(region), direction, lineUp);
  if (near) {
    const into = groupOf(near.element, layer);
    const landed = into && into !== group ? arrive(near, into, items, origin, direction) : near;
    return { ...landed, keep: landed === near };
  }
  if (region === layer) return null;
  // Leaving the region.
  const cache = new Map<Element, boolean>();
  const fromFixed = fixedIn(from, layer, cache);
  // From fixed chrome, only the part of the page in view beside it counts, not what scrolled under it.
  const inView = (item: Item) => {
    if (!onScreen(item.box)) return false;
    const hit = document.elementFromPoint(item.box.left + item.box.width / 2, item.box.top + item.box.height / 2);
    return !!hit && (item.element.contains(hit) || hit.contains(item.element));
  };
  const outside = items.filter(item => !region.contains(item.element) && (!fromFixed || fixedIn(item.element, layer, cache) || inView(item)));
  const content = kind(region) === 'content';
  // Left or right from the page's content reaches the navigation when it runs down that side.
  const nav = layer.querySelector<HTMLElement>('[data-tv-region="nav"]');
  if (content && isHorizontal(direction) && nav && !nav.closest('[inert], [hidden]')) {
    const side = nav.getBoundingClientRect(); const page = region.getBoundingClientRect();
    if (side.width && (isForward(direction) ? side.left >= page.right - 1 : side.right <= page.left + 1) && overlap(across(side, direction), across(page, direction)) > 0) {
      const entry = inside(nav); const found = lane(origin, entry, direction, lineUp) ?? least(entry, item => [score(origin, item.box, direction)]);
      if (found) return { ...arrive(found, nav, outside, origin, direction), keep: false };
    }
  }
  // Up and down go only to the parts above or below this one (the sidebar's account below its
  // navigation, not the page beside it).
  const span = across(region.getBoundingClientRect(), direction);
  let found = lane(origin, isHorizontal(direction) ? outside : outside.filter(item => overlap(across(item.box, direction), span) > 0), direction, lineUp, false);
  // Sideways, chrome can always reach the page beside it; the page's rows never slip into others.
  if (!found && !content && isHorizontal(direction)) found = least(outside.filter(item => ahead(origin, item.box, direction)), item => [score(origin, item.box, direction)]);
  if (!found) return null;
  // A remembered control counts only if it is one of these: never one scrolled away from fixed chrome.
  const landed = arrive(found, regionOf(found.element, layer), outside, origin, direction);
  return { ...landed, keep: landed === found };
}
function closest(origin: DOMRect, list: HTMLElement[]) {
  const centre = (box: DOMRect) => [box.left + box.width / 2, box.top + box.height / 2];
  const [x, y] = centre(origin);
  return least(list, element => { const [ex, ey] = centre(element.getBoundingClientRect()); return [Math.hypot(ex - x, ey - y)]; });
}
// With nothing focused in the layer, the first press lands on its chosen control, or its first.
function entry(layer: HTMLElement) {
  const preferred = layer.querySelector<HTMLElement>('[data-tv-autofocus]');
  const all = candidates(layer);
  if (preferred && all.includes(preferred)) return preferred;
  const remembered = memory.get(layer);
  if (remembered && all.includes(remembered)) return remembered;
  return leaves(all).sort((a, b) => {
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
/**
 * After the page changes view on a TV: focus on the navigation's current page, or the view's first
 * control, so the ring is always somewhere a remote can go on from.
 */
export function focusView(view: HTMLElement) {
  const current = document.querySelector<HTMLElement>('[data-tv-region="nav"] [aria-current="page"]');
  if (current && candidates(document).includes(current)) { current.focus({ preventScroll: true }); return; }
  const first = entry(view);
  if (first) move(first); else view.focus({ preventScroll: true });
}
// Where focus last was, to put it back near there when its control goes away (a song removed from
// the queue, a list that changed under it).
let last: { element: HTMLElement; box: DOMRect; region: Element | null; group: Element | null } | null = null;
function note(element: HTMLElement) {
  const layer = topLayer();
  last = { element, box: element.getBoundingClientRect(), region: layer.contains(element) ? regionOf(element, layer) : null, group: layer.contains(element) ? groupOf(element, layer) : null };
}
const lost = () => {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected || !!active.closest('[inert], [hidden]');
};
// The control nearest to where focus was, in the same shelf or region if they are still there.
function replacement() {
  if (!last) return null;
  const layer = topLayer(); const all = leaves(candidates(layer));
  for (const scope of [last.group, last.region, layer]) {
    if (!scope || !scope.isConnected || !layer.contains(scope) || scope.closest('[inert], [hidden]')) continue;
    const list = all.filter(element => scope.contains(element));
    if (list.length) return closest(last.box, list);
  }
  return null;
}
let pending = 0;
function recover() {
  pending = 0;
  if (!lost()) return;
  const target = replacement();
  if (target) move(target);
}
function move(to: HTMLElement) {
  to.focus({ preventScroll: true });
  to.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  // Stacked chrome (the player above the tab bar) may take a step each.
  for (let step = 0; step < 4 && uncover(to); step++);
  note(to);
}

// The fixed player, navigation and bars stay over the page as it scrolls, so a control scrolled
// just into view can still be under one. Scroll it clear, with room for its focus ring.
const RING = 12;
function uncover(element: HTMLElement): boolean {
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (!hit || element.contains(hit) || hit.contains(element)) return false;
  let cover: Element | null = hit;
  while (cover && cover !== document.body && getComputedStyle(cover).position !== 'fixed' && getComputedStyle(cover).position !== 'sticky') cover = cover.parentElement;
  if (!cover || cover === document.body) return false;
  const over = cover.getBoundingClientRect();
  // Chrome in the lower half of the screen (the player, the tab bar) sits below; the rest above.
  const below = over.top + over.height / 2 > innerHeight / 2;
  const delta = below ? box.bottom - over.top + RING : -(over.bottom - box.top + RING);
  const page = scroller(element); if (!page) return false;
  const before = page.scrollTop;
  page.scrollBy({ top: delta, behavior: 'instant' });
  return page.scrollTop !== before;
}
function scroller(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.scrollingElement as HTMLElement | null;
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
  const all = candidates(layer);
  const inLayer = active && layer.contains(active) && all.includes(active) && !all.some(other => other !== active && active.contains(other));
  // A control that would use the arrows itself never gets them while it isn't being edited.
  const control = active && (editable(active) || active instanceof HTMLSelectElement || active instanceof HTMLInputElement);
  if (control) event.preventDefault();
  let target: HTMLElement | null = null; let keep = false;
  if (inLayer) { const found = travel(active, direction, layer); target = found?.element ?? null; keep = !!found?.keep; }
  // Focus on a container (a shelf, the page) goes on to its control; focus that was lost comes back
  // where it was.
  else target = active && active !== layer && layer.contains(active) ? entry(active) : lost() && last && layer.contains(last.region ?? layer) ? replacement() : null;
  target ??= inLayer ? null : entry(layer);
  // At the edge of fixed chrome (the tab bar) the page doesn't scroll on under it.
  if (!target) { if (inLayer && fixedIn(active, layer, new Map())) event.preventDefault(); return; }
  event.preventDefault();
  if (isHorizontal(direction) || !inLayer) column = null;
  else column = { element: target, range: keep && column?.element === active ? column.range : keep ? across(active!.getBoundingClientRect(), direction) : across(target.getBoundingClientRect(), direction) };
  move(target);
}
function focusIn(event: FocusEvent) {
  if (!(event.target instanceof HTMLElement)) return;
  if (event.target !== editing) quiet(event.target);
  if (event.target.tabIndex >= 0) { remember(event.target); note(event.target); }
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
    // The focused control went away or out of reach: once the page has settled (a dialog or view
    // that moves focus itself has done so), focus goes to the control nearest where it was.
    if (!pending && last && lost()) pending = window.setTimeout(recover, 0);
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'hidden', 'inert'] });
  window.addEventListener('keydown', captureKey, true);
  document.addEventListener('keydown', key);
  document.addEventListener('focusin', focusIn);
  document.addEventListener('focusout', focusOut);
  if (document.activeElement instanceof HTMLElement) quiet(document.activeElement);
  return () => {
    stopEditing();
    delete root.dataset.tv;
    observer.disconnect(); dialogs.length = 0;
    clearTimeout(pending); pending = 0; last = null; column = null;
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
