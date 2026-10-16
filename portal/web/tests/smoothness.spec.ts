import { test, expect, type Page } from '@playwright/test';
import { mockPortal } from './fixtures';
import { startHttpFixture } from './http-fixture';

// Records the timing of every view-transition animation once each transition is ready.
async function recordTransitions(page: Page) {
  await page.addInitScript(() => {
    const start = document.startViewTransition?.bind(document);
    if (!start) return;
    const record = window as unknown as { transitions: { pseudo: string; duration: number; delay: number; easing: string }[][] };
    record.transitions = [];
    (document as unknown as { startViewTransition: typeof start }).startViewTransition = ((update: () => void) => {
      const transition = start(update);
      void transition.ready.then(() => record.transitions.push(document.getAnimations()
        .map(animation => ({ effect: animation.effect as KeyframeEffect }))
        .filter(({ effect }) => effect?.pseudoElement?.startsWith('::view-transition'))
        .map(({ effect }) => { const timing = effect.getComputedTiming(); return { pseudo: effect.pseudoElement!, duration: Number(timing.duration), delay: Number(timing.delay), easing: String(timing.easing) }; })), () => undefined);
      return transition;
    }) as typeof start;
  });
}
const transitions = (page: Page) => page.evaluate(() => (window as unknown as { transitions: { pseudo: string; duration: number; delay: number; easing: string }[][] }).transitions);

test('changing views crossfades the page in equal halves and overlaps the views so nothing blinks', async ({ page }) => {
  await recordTransitions(page);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await expect.poll(async () => (await transitions(page)).length).toBe(1);
  const [timings] = await transitions(page);
  const find = (pseudo: string) => timings.find(timing => timing.pseudo === pseudo)!;
  // Unequal halves left both page snapshots partly transparent at once, which dimmed the screen.
  expect(find('::view-transition-old(root)')).toMatchObject({ duration: find('::view-transition-new(root)').duration, easing: find('::view-transition-new(root)').easing });
  // The incoming view starts before the outgoing one has gone, so the content area never empties.
  const old = find('::view-transition-old(surface)'); const incoming = find('::view-transition-new(surface)');
  expect(incoming.delay).toBeLessThan(old.delay + old.duration);
});

test('changing the look crossfades instead of repainting in one frame', async ({ page }) => {
  await recordTransitions(page);
  await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
  const before = (await transitions(page)).length;
  await page.getByLabel('Portal look').selectOption('classic');
  await expect.poll(async () => (await transitions(page)).length).toBe(before + 1);
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'classic');
});

test('a song change dissolves the cover in place instead of cutting to an empty frame', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.goto(server.origin);
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    const cover = page.locator('.sleeve-artwork > .artwork');
    await expect(cover).toHaveAttribute('alt', 'Artwork for Evening Light');
    const state = server.state.snapshot; const next = state.session.queue.shift()!;
    state.session.queue.push(state.session.current!); state.session.current = next; state.revision = 'revision-next-song';
    server.broadcast();
    // The previous cover lingers exactly over the next one and fades out.
    const ghost = page.locator('.sleeve-artwork > .artwork-ghost');
    await expect(ghost).toHaveCount(1);
    await ghost.evaluate(element => element.getAnimations().forEach(animation => animation.pause()));
    expect(await ghost.boundingBox()).toEqual(await cover.boundingBox());
    await expect(cover).toHaveAttribute('alt', `Artwork for ${next.title}`);
    await ghost.evaluate(element => element.getAnimations().forEach(animation => animation.play()));
    await expect(ghost).toHaveCount(0);
  } finally { await server.close(); }
});

// Relight helpers: the room's accent settles once its glide ends; a song change is a fresh snapshot.
type Sample = { at: number; accent: string; pageWide: number };
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));
async function settledAccent(page: Page) {
  let previous = '';
  await expect.poll(async () => { const now = await accent(page); const stable = now === previous; previous = now; return stable; }, { intervals: [400] }).toBe(true);
  return previous;
}
async function changeSong(page: Page, fixture: Awaited<ReturnType<typeof mockPortal>>, title?: string) {
  const state = fixture.state.snapshot; const index = title ? state.session.queue.findIndex(track => track.title === title) : 0;
  state.session.current = state.session.queue.splice(index, 1)[0]; state.revision = `revision-${state.session.current.id}`;
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
}
// Records the accent and any color transition outside the light pools on every frame, from now
// until the accent has changed and then held still for half a second (the artwork may load late).
async function sampleRelight(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { relight: Sample[]; relightDone: boolean }; w.relight = []; w.relightDone = false;
    const start = performance.now(); let changedAt = 0;
    const sample = () => {
      const now = performance.now(); const value = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      const pageWide = document.getAnimations().filter(animation => animation instanceof CSSTransition && animation.transitionProperty.startsWith('--') && !((animation.effect as KeyframeEffect).target as Element).classList.contains('light')).length;
      if (w.relight.length && value !== w.relight.at(-1)!.accent) changedAt = now;
      w.relight.push({ at: now, accent: value, pageWide });
      if ((changedAt && now - changedAt > 500) || now - start > 8000) w.relightDone = true; else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}
const samples = async (page: Page) => { await page.waitForFunction(() => (window as unknown as { relightDone: boolean }).relightDone); return page.evaluate(() => (window as unknown as { relight: Sample[] }).relight); };

test('a song change glides the page to the new colors without restyling it every frame', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const before = await settledAccent(page);
  await sampleRelight(page); await changeSong(page, fixture, 'Golden Hour');
  const all = await samples(page);
  // Colors that transition on :root restyle and repaint the whole page every frame; only the three
  // light pools run CSS color transitions, at any point in the glide.
  expect(all.filter(sample => sample.pageWide).length).toBe(0);
  // The accent passes through in-between colors, but in steps (about every 50ms over 1.2s), not every frame.
  const distinct = new Set(all.map(sample => sample.accent).filter(value => value !== before));
  expect(distinct.size).toBeGreaterThan(5);
  expect(distinct.size).toBeLessThanOrEqual(32);
  const after = await settledAccent(page);
  expect(after).not.toBe(before);
  expect(all.at(-1)!.accent).toBe(after);
});

test('reduced motion turned on mid-glide finishes the glide quickly', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const before = await settledAccent(page);
  await sampleRelight(page); await changeSong(page, fixture, 'Golden Hour');
  // Switch only once the glide is visibly under way.
  await page.waitForFunction(before => getComputedStyle(document.documentElement).getPropertyValue('--accent') !== before, before, { polling: 'raf' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const switched = await page.evaluate(() => performance.now());
  const all = await samples(page);
  const last = all.filter((sample, index) => index && sample.accent !== all[index - 1].accent).at(-1)!;
  // The short glide is 300ms; left alone, the full glide keeps changing the color for about a second.
  expect(last.at - switched).toBeLessThan(650);
});
