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

test('a song change relights the room without animating the whole page', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));
  await expect.poll(accent).not.toBe('#5fdcd2');
  const before = await accent();
  const state = fixture.state.snapshot; state.session.current = state.session.queue.shift()!; state.revision = 'revision-relight';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(accent).not.toBe(before);
  // Colors that glide on :root restyle and repaint the whole page every frame; only the light pools glide.
  const gliding = await page.evaluate(() => document.getAnimations().filter(animation => animation instanceof CSSTransition && animation.transitionProperty.startsWith('--'))
    .map(animation => `${((animation.effect as KeyframeEffect).target as Element).className}:${(animation as CSSTransition).transitionProperty}`));
  expect(gliding.length).toBeGreaterThan(0);
  expect(gliding.every(name => name.startsWith('light '))).toBe(true);
});
