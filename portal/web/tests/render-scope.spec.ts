import { test, expect, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';
import type { GuildSnapshot, Track } from '../src/types';

// Render scope: how much of the React tree one event re-renders. A stand-in for React DevTools'
// commit hook counts, on the production build, every component that rendered in each commit and
// every queue row that mounted. Minified builds have no component names, so a component is labelled
// by its first element (for example `li.track-row`).
declare global { interface Window { renderScope: { reset: () => void; read: () => { commits: number; rendered: number; rows: number; rowMounts: number; labels: Record<string, number> } } } }

function installCounter() {
  const counts = { commits: 0, rendered: 0, rows: 0, rowMounts: 0, labels: {} as Record<string, number> };
  type Fiber = { tag: number; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; stateNode: unknown; type: unknown; memoizedProps: { className?: string } | null };
  // FunctionComponent, ClassComponent, ForwardRef, SimpleMemoComponent.
  const components = new Set([0, 1, 11, 15]);
  const PerformedWork = 1; const HostComponent = 5;
  const label = (fiber: Fiber) => {
    for (let node: Fiber | null = fiber.child; node; node = node.child) {
      if (node.tag === HostComponent) return `${String(node.type)}.${String(node.memoizedProps?.className || '').trim().split(/\s+/)[0]}`;
    }
    return '(none)';
  };
  const row = (fiber: Fiber) => fiber.tag === HostComponent && fiber.type === 'li' && /\btrack-row\b/.test(String(fiber.memoizedProps?.className || ''));
  const rendered = (fiber: Fiber) => {
    counts.rendered++;
    const name = label(fiber); counts.labels[name] = (counts.labels[name] || 0) + 1;
  };
  const mount = (fiber: Fiber) => {
    if (components.has(fiber.tag)) rendered(fiber);
    if (row(fiber)) counts.rowMounts++;
    for (let child = fiber.child; child; child = child.sibling) mount(child);
  };
  // As DevTools does: a subtree whose child list is the same object as before was skipped.
  const update = (fiber: Fiber) => {
    const previous = fiber.alternate;
    if (!previous) { mount(fiber); return; }
    if (components.has(fiber.tag) && fiber.flags & PerformedWork) rendered(fiber);
    // A row element given new props was rebuilt by a render above it.
    if (row(fiber) && fiber.memoizedProps !== previous.memoizedProps) counts.rows++;
    if (fiber.child !== previous.child) for (let child = fiber.child; child; child = child.sibling) update(child);
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { configurable: true, value: {
    supportsFiber: true, isDisabled: false, renderers: new Map(), inject: () => 1, checkDCE: () => undefined,
    onScheduleFiberRoot: () => undefined, onCommitFiberUnmount: () => undefined, onPostCommitFiberRoot: () => undefined,
    onCommitFiberRoot: (_: number, root: { current: Fiber }) => { counts.commits++; update(root.current); },
  } });
  window.renderScope = {
    reset: () => { counts.commits = 0; counts.rendered = 0; counts.rows = 0; counts.rowMounts = 0; counts.labels = {}; },
    read: () => structuredClone(counts),
  };
}

const queueOf = (base: Track[], length: number) => Array.from({ length }, (_, index) => {
  const source = base[index % base.length];
  return { ...source, id: `${index.toString(16).padStart(4, '0')}${source.id.slice(4)}`, title: `${source.title} ${index + 1}`, uri: `${source.uri}-${index}` };
});
const emit = (page: Page, snapshot: GuildSnapshot) => page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), snapshot);
// Measures what one event re-renders once the page has settled after it.
async function measure(page: Page, name: string, event: () => Promise<unknown>) {
  await page.waitForTimeout(400);
  await page.evaluate(() => window.renderScope.reset());
  await event();
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => window.renderScope.read());
  console.log(`[render-scope] ${name}: ${result.rendered} components in ${result.commits} commits; ${result.rows} queue rows rendered, ${result.rowMounts} mounted`);
  if (process.env.RENDER_SCOPE_LABELS) console.log(JSON.stringify(result.labels));
  return result;
}

test('one keystroke, one unchanged live frame and one skip re-render only what they change', async ({ page }) => {
  await page.addInitScript(installCounter);
  const fixture = await mockPortal(page);
  // A paused session keeps the progress clock still, so only the measured event renders.
  Object.assign(fixture.state.snapshot.session, { status: 'paused', queue: queueOf(fixture.state.snapshot.session.queue, 30) });
  await gotoSession(page);
  const rows = page.locator('main .queue .track-list > li.track-row');
  await expect(rows).toHaveCount(30);

  await page.getByRole('button', { name: 'Search music' }).click();
  const field = page.getByRole('dialog', { name: 'Add music' }).getByRole('searchbox', { name: 'Music search' });
  await expect(field).toBeFocused();
  const keystroke = await measure(page, 'one search keystroke', () => page.keyboard.type('n'));
  await expect(field).toHaveValue('n');
  await expect(page.getByRole('button', { name: 'Search music' })).toContainText('n');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Add music' })).toHaveCount(0);

  const unchanged = await measure(page, 'one unchanged live frame', () => emit(page, structuredClone(fixture.state.snapshot)));

  const before = fixture.state.snapshot.session;
  const skipped = structuredClone(fixture.state.snapshot);
  Object.assign(skipped, { revision: 'revision-skipped' });
  Object.assign(skipped.session, { current: before.queue[0], queue: before.queue.slice(1), positionMs: 0, durationMs: before.queue[0].durationMs });
  const skip = await measure(page, 'one skip', async () => {
    await emit(page, skipped);
    await expect(rows).toHaveCount(29);
    await expect(rows.first()).toContainText(before.queue[1].title);
  });

  // With the player open over the Queue page, a frame renders the player's queue, not the hidden page's too.
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Now playing' })).toBeAttached();
  const sleeve = await measure(page, 'one unchanged frame with the player open', () => emit(page, structuredClone(skipped)));

  // Typing re-renders the search field and the top bar's echo of it, not the page behind them.
  for (const page of ['div.app-shell', 'aside.sidebar', 'section.persistent-player', 'section.queue', 'div.home-view']) expect(keystroke.labels[page], page).toBeUndefined();
  expect(keystroke.rows).toBe(0);
  // An unchanged frame reaches the player and the queue's heading (was 633 components), but no row renders again.
  expect(unchanged.rendered).toBeLessThan(150);
  expect(unchanged.rows).toBe(0);
  expect(unchanged.rowMounts).toBe(0);
  // A skip renumbers the rows that stay, but every one keeps its element and its loaded cover.
  expect(skip.rowMounts).toBe(0);
  expect(sleeve.labels['section.queue']).toBe(1);
  expect(sleeve.rows).toBe(0);
});
