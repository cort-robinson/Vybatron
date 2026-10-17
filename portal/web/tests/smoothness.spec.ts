import { test, expect, type Page } from '@playwright/test';
import { mockPortal, landed } from './fixtures';
import { startHttpFixture } from './http-fixture';
import { fileURLToPath } from 'node:url';

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
    // The cover flies in from the deck as the player opens; let it land before the song changes.
    await landed(cover);
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

const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent'));
async function settledAccent(page: Page) {
  await expect(page.locator('.room-colors')).toHaveCount(1);
  return accent(page);
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
test('a song change dissolves fixed room palettes without repeatedly changing inherited page colors', async ({ page }) => {
  await page.clock.install();
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const before = await settledAccent(page);
  await relightTo(page, fixture, 'Golden Hour');
  const final = await accent(page); expect(final).not.toBe(before);
  await expect(page.locator('.room-colors')).toHaveCount(2);
  const incoming = page.locator('.room-incoming');
  await expect(incoming.locator('.od-horizon')).toHaveCount(1);
  await expect(incoming.locator('.od-horizon')).toHaveCSS('animation-name', 'none');
  const clocks = await page.locator('.room-colors').evaluateAll(rooms => {
    const animations = rooms.map(room => room.querySelector('.od-plane')!.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === 'od-roll')!);
    return { starts: animations.map(a => a.startTime), difference: Math.abs(Number(animations[0].currentTime) - Number(animations[1].currentTime)) };
  });
  // A shared timeline origin remains correct even when CI delays the incoming layer's first paint.
  expect(clocks.starts[0]).not.toBeNull();
  expect(clocks.starts[1]).toBe(clocks.starts[0]);
  expect(clocks.difference).toBeLessThan(50);
  const samples = await incoming.evaluate(element => {
    const animation = element.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === 'room-relight')!;
    animation.pause();
    return [0, 550, 1100, 1650, 2199].map(time => {
      animation.currentTime = time;
      return { opacity: Number(getComputedStyle(element).opacity), accent: getComputedStyle(element).getPropertyValue('--accent'), base: getComputedStyle(element.previousElementSibling!).opacity };
    });
  });
  expect(samples[0].opacity).toBe(0);
  expect(samples.at(-1)!.opacity).toBeGreaterThan(.99);
  expect(samples.slice(1, -1).every(s => s.opacity > 0 && s.opacity < 1)).toBe(true);
  expect(samples.every(s => s.base === '1')).toBe(true);
  expect(new Set(samples.map(s => s.accent)).size).toBe(1);
  for (let i = 0; i < 12; i++) { await page.clock.runFor(150); expect(await accent(page)).toBe(final); }
  expect(await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSTransition && a.transitionProperty.startsWith('--')).length)).toBe(0);
  await page.clock.runFor(500);
  await expect(page.locator('.room-colors')).toHaveCount(1);
  const state = fixture.state.snapshot;
  const motionState = () => page.locator('.od-plane').evaluate(el => el.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === 'od-roll')!.playState);
  state.session.status = 'paused'; state.revision = 'paused-after-relight';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(motionState).toBe('paused');
  state.session.current = state.session.queue.shift()!; state.revision = 'relight-while-paused';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(() => accent(page)).not.toBe(final);
  await expect(page.locator('.room-colors')).toHaveCount(2);
  await expect.poll(() => page.locator('.od-plane').evaluateAll(elements => elements.map(el => el.getAnimations().find(a => a instanceof CSSAnimation && a.animationName === 'od-roll')!.playState))).toEqual(['paused', 'paused']);
  await page.clock.runFor(2300);
  await expect(page.locator('.room-colors')).toHaveCount(1);
  state.session.status = 'playing'; state.revision = 'resumed-after-relight';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(motionState).toBe('running');
});

test('reduced motion turned on mid-glide finishes the glide quickly', async ({ page }) => {
  await page.clock.install();
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await settledAccent(page);
  await relightTo(page, fixture, 'Golden Hour');
  await page.clock.runFor(160);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.room-incoming')).toHaveCSS('animation-duration', '0.3s');
  await page.clock.runFor(350);
  await expect(page.locator('.room-colors')).toHaveCount(1);
});

test('rapid track changes keep a complete room visible and settle on the latest palette', async ({ page }) => {
  await page.clock.install();
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await settledAccent(page);
  await relightTo(page, fixture, 'Golden Hour');
  const first = await page.locator('.room-colors').first().evaluate(el => getComputedStyle(el).getPropertyValue('--accent'));
  const state = fixture.state.snapshot; state.session.current = state.session.queue.shift()!; state.revision = 'rapid-next';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
  await expect.poll(() => accent(page)).not.toBe(await page.locator('.room-incoming').evaluate(el => getComputedStyle(el).getPropertyValue('--accent')));
  await expect(page.locator('.room-colors')).toHaveCount(2);
  expect(await page.locator('.room-colors').first().evaluate(el => getComputedStyle(el).getPropertyValue('--accent'))).toBe(first);
  await page.clock.runFor(4500);
  await expect(page.locator('.room-colors')).toHaveCount(1);
  expect(await page.locator('.room-colors').evaluate(el => getComputedStyle(el).getPropertyValue('--accent'))).toBe(await accent(page));
});

test('a slow cover survives background cleanup and appears only after it decodes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  const fixture = await mockPortal(page);
  const old = 'https://covers.example/evening.png'; const next = 'https://covers.example/golden.png';
  fixture.state.snapshot.session.current!.artworkUrl = old;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  // A host without pixel-reading permission uses the default palette, so only artwork changes.
  await page.route('https://covers.example/*.png', async route => {
    if (route.request().url() === next) await pending;
    await route.fulfill({ path: fileURLToPath(new URL(`./art/${route.request().url() === old ? 'evening' : 'golden'}.png`, import.meta.url)), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': 'https://another.example' } });
  });
  try {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    await expect(page.locator('.artwork-field.shown')).toHaveAttribute('src', old);
    const state = fixture.state.snapshot; state.session.current = { ...state.session.queue[0], artworkUrl: next }; state.revision = 'slow-cover';
    await page.evaluate(data => (window as unknown as { portalTest: { emit: (d: unknown) => void } }).portalTest.emit(data), state);
    await page.clock.runFor(1500);
    await expect(page.locator('.artwork-field.shown')).toHaveAttribute('src', old);
    release();
    await expect(page.locator('.artwork-field.shown')).toHaveAttribute('src', next);
    expect(await page.locator('.artwork-field.shown').evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.clock.runFor(1300);
    await expect(page.locator('.artwork-field')).toHaveCount(1);
  } finally { release(); }
});
