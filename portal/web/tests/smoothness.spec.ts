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

// Relight helpers. The glide runs on a paused page clock stepped one 16ms frame at a time, so a slow
// machine (CI's software rendering) changes neither the glide nor how it is sampled.
type Sample = { accent: string; pageWide: number };
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));
async function settledAccent(page: Page) {
  let previous = '';
  await expect.poll(async () => { const now = await accent(page); const stable = now === previous; previous = now; return stable; }, { intervals: [400] }).toBe(true);
  return previous;
}
// Pauses the clock, changes song, and waits (in real time) until the new cover's colors have
// started their glide: the theme color is set to the new ground when the glide begins.
async function relightTo(page: Page, fixture: Awaited<ReturnType<typeof mockPortal>>, title: string) {
  const theme = () => page.evaluate(() => document.querySelector('meta[name="theme-color"]')!.getAttribute('content'));
  const before = await theme();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const state = fixture.state.snapshot; state.session.current = state.session.queue.splice(state.session.queue.findIndex(track => track.title === title), 1)[0]; state.revision = `revision-${state.session.current.id}`;
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(theme).not.toBe(before);
}
// Advances the paused clock frame by frame, recording the accent and any color transition outside
// the three light pools after each frame.
async function frames(page: Page, ms: number) {
  const samples: Sample[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await page.clock.runFor(16);
    samples.push(await page.evaluate(() => ({
      accent: getComputedStyle(document.documentElement).getPropertyValue('--accent'),
      pageWide: document.getAnimations().filter(animation => animation instanceof CSSTransition && animation.transitionProperty.startsWith('--') && !((animation.effect as KeyframeEffect).target as Element).classList.contains('light')).length,
    })));
  }
  return samples;
}

test('a song change glides the page to the new colors without restyling it every frame', async ({ page }) => {
  await page.clock.install();
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const before = await settledAccent(page);
  await relightTo(page, fixture, 'Golden Hour');
  const all = await frames(page, 1600);
  // Colors that transition on :root restyle and repaint the whole page every frame; only the three
  // light pools run CSS color transitions, at any point in the glide.
  expect(all.filter(sample => sample.pageWide).length).toBe(0);
  // The accent passes through in-between colors in steps about every 50ms over 1.2s: not every frame.
  const distinct = new Set(all.map(sample => sample.accent).filter(value => value !== before));
  expect(distinct.size).toBeGreaterThan(10);
  expect(distinct.size).toBeLessThanOrEqual(32);
  const final = all.at(-1)!.accent;
  expect(final).not.toBe(before);
  expect((await frames(page, 500)).every(sample => sample.accent === final)).toBe(true);
});

test('reduced motion turned on mid-glide finishes the glide quickly', async ({ page }) => {
  await page.clock.install();
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await settledAccent(page);
  await relightTo(page, fixture, 'Golden Hour');
  await frames(page, 160);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The clock is paused, so the glide stands still while the app reacts to the media change.
  await page.waitForTimeout(500);
  const all = await frames(page, 1200);
  const lastChange = all.reduce((last, sample, index) => index > 0 && sample.accent !== all[index - 1].accent ? index : last, -1);
  // The short glide is 300ms; left alone, the full glide keeps changing the color for most of a second.
  expect(lastChange).toBeGreaterThan(0);
  expect(lastChange * 16).toBeLessThan(400);
});
