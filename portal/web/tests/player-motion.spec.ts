import { expect, test } from './test';
import { mockPortal, suggestedTracks } from './fixtures';

for (const skin of ['classic', 'overdrive', 'fantastic']) {
  for (const expanded of [false, true]) {
    test(`${skin} ${expanded ? 'expanded' : 'compact'} title stays fully visible through a track change`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript(skin => localStorage.setItem('vybertron.skin', skin), skin);
      const fixture = await mockPortal(page); await page.goto('/');
      await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
      if (expanded) await page.getByRole('button', { name: 'Open player', exact: true }).click();
      await page.waitForFunction(() => !document.documentElement.dataset.motion);
      const caption = page.locator(expanded ? '.player-identity' : '.compact-title');
      // Finish the initial entrance before observing only the song-change acknowledgement.
      await caption.evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => undefined))); });
      const shadow = await caption.locator(expanded ? 'h2' : '.compact-track-title').evaluate(el => getComputedStyle(el).textShadow);
      const state = fixture.state.snapshot;
      state.session.current = { ...state.session.current!, id: 'next-title', title: 'The next song' };
      state.revision = 'next-title';
      await page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), state);
      await expect(caption).toContainText('The next song');
      const samples = await caption.evaluate(el => {
        const title = el.querySelector('h2, .compact-track-title')!;
        const animations = el.getAnimations({ subtree: true });
        animations.forEach(a => a.pause());
        return [0, 120, 300, 460, 720].map(time => {
          animations.forEach(a => { a.currentTime = time; });
          return { opacity: getComputedStyle(el).opacity, shadow: getComputedStyle(title).textShadow };
        });
      });
      expect(samples.every(sample => sample.opacity === '1')).toBe(true);
      expect(samples.every(sample => sample.shadow === shadow)).toBe(true);
    });
  }
}

for (const surface of ['Home', 'Session', 'My Music', 'Server']) {
  test(`opening and closing the player preserves the ${surface} page`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await mockPortal(page);
    if (surface === 'Session') fixture.state.snapshot.session.suggestions = suggestedTracks();
    await page.goto('/');
    if (surface !== 'Home') await page.getByRole('button', { name: surface, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    const selector = surface === 'Home' ? '.home-view .shelf-card' : surface === 'Session' ? '.surface-stage .queue .track-row' : surface === 'Server' ? '.server-view .settings-list' : '.library-track-list > li';
    const content = page.locator(selector).first();
    await expect(content).toBeVisible();
    const original = await content.elementHandle();
    const resourceReads = () => fixture.requests.filter(path => path.endsWith('/stats') || path.endsWith('/configuration')).length;
    const reads = resourceReads();
    for (let i = 0; i < 2; i++) {
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      await expect(page.locator('.surface-stage')).toBeHidden();
      expect(await original!.evaluate(el => el.isConnected)).toBe(true);
      if (surface === 'Session') {
        const headings = await page.locator('.suggested h3').evaluateAll(elements => elements.map(el => el.id));
        expect(headings).toHaveLength(2);
        expect(new Set(headings).size).toBe(2);
      }
      await page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true }).click();
      await expect(content).toBeVisible();
      expect(await content.evaluate((el, original) => el === original, original)).toBe(true);
    }
    expect(resourceReads()).toBe(reads);
  });
}

// The cover's glide (motion.ts) is its only plain Animation; CSS animations and transitions subclass it.
for (const width of [390, 1280]) {
  test(`the ${width}px cover flies between deck and sleeve and the caption has one entrance`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockPortal(page); await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    const deck = page.locator('.player-expand-trigger > .artwork'); const sleeve = page.locator('.sleeve-artwork > .artwork');
    // The cover's box at the start and the end of its flight, and whether it is the topmost thing at
    // its starting point (a clipped or covered cover still reports its box).
    const ends = (cover: typeof deck) => cover.evaluate(element => {
      const glide = element.getAnimations().find(animation => animation.constructor === Animation)!;
      glide.pause(); glide.currentTime = 0; const from = element.getBoundingClientRect();
      const seen = document.elementFromPoint(from.x + from.width / 2, from.y + from.height / 2) === element;
      glide.finish(); const to = element.getBoundingClientRect();
      return { seen, boxes: [from, to].map(box => ({ x: box.x, y: box.y, width: box.width, height: box.height })) };
    });
    const near = (a: Record<string, number>, b: Record<string, number> | null) => { for (const key of ['x', 'y', 'width', 'height']) expect(Math.abs(a[key] - b![key])).toBeLessThanOrEqual(1); };
    const compact = await deck.boundingBox();
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    await expect.poll(() => sleeve.evaluate(element => !!element.getAnimations().find(animation => animation.constructor === Animation))).toBe(true);
    // One entrance for the caption: its rise-in, with nothing fading it a second time.
    expect(await page.locator('.player-identity').evaluate(element => element.getAnimations().filter(animation => animation instanceof CSSAnimation).length)).toBe(1);
    const { seen: rising, boxes: [opening, opened] } = await ends(sleeve);
    expect(rising).toBe(true);
    near(opening, compact); near(opened, await sleeve.boundingBox());
    const open = await sleeve.boundingBox();
    await page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true }).click();
    await expect.poll(() => deck.evaluate(element => !!element.getAnimations().find(animation => animation.constructor === Animation))).toBe(true);
    const { seen: falling, boxes: [closing, closed] } = await ends(deck);
    expect(falling).toBe(true);
    near(closing, open); near(closed, compact);
  });
}

test('a permission update during opening still lands the cover in its live place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const cover = page.locator('.sleeve-artwork > .artwork');
  // Hold the cover partway through its flight.
  await expect.poll(() => cover.evaluate(element => {
    const glide = element.getAnimations().find(animation => animation.constructor === Animation);
    if (!glide) return false;
    glide.pause(); glide.currentTime = 120; return true;
  })).toBe(true);
  const frame = () => page.locator('.sleeve-artwork').evaluate(element => element.getBoundingClientRect().height);
  const before = await frame();
  fixture.state.snapshot.session.canControl = false;
  fixture.state.snapshot.session.reason = 'Join General to control playback.';
  fixture.state.snapshot.revision = 'permission-during-opening';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), fixture.state.snapshot);
  await expect(page.locator('.player-permission')).toBeVisible();
  // The explanation takes room from the cover mid-flight...
  expect(await frame()).not.toBe(before);
  // ...and the flight still ends exactly where the cover now sits: no jump as it lands.
  const jump = await cover.evaluate(element => {
    const glide = element.getAnimations().find(animation => animation.constructor === Animation)!;
    glide.currentTime = Number(glide.effect!.getComputedTiming().duration) - 1;
    const arriving = element.getBoundingClientRect(); glide.finish(); const arrived = element.getBoundingClientRect();
    return Math.max(Math.abs(arriving.x - arrived.x), Math.abs(arriving.y - arrived.y), Math.abs(arriving.width - arrived.width), Math.abs(arriving.height - arrived.height));
  });
  expect(jump).toBeLessThanOrEqual(1);
});

test('a song change mid-flight neither snaps the cover nor shows its dissolve early', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const emitNext = (revision: string) => {
    const state = fixture.state.snapshot; state.session.queue.push(state.session.current!); state.session.current = state.session.queue.shift()!; state.revision = revision;
    return page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), state);
  };
  // Holds a cover partway through its flight and reports where it is.
  const hold = (cover: ReturnType<typeof page.locator>) => cover.evaluate(element => {
    const glide = element.getAnimations().find(animation => animation.constructor === Animation);
    if (!glide) return null;
    glide.pause(); glide.currentTime = 120; const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) };
  });
  const sleeve = page.locator('.sleeve-artwork > .artwork'); const deck = page.locator('.player-expand-trigger > .artwork');

  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect.poll(() => hold(sleeve)).not.toBeNull();
  await emitNext('next-while-opening');
  // The previous cover's dissolve layer waits for the travelling cover instead of appearing in its place.
  const ghost = page.locator('.sleeve-artwork > .artwork-ghost');
  await expect(ghost).toHaveCount(1);
  await ghost.evaluate(element => element.getAnimations().forEach(animation => animation.pause()));
  expect(await ghost.evaluate(element => getComputedStyle(element).visibility)).toBe('hidden');
  await sleeve.evaluate(element => element.getAnimations().find(animation => animation.constructor === Animation)!.finish());
  await expect.poll(() => ghost.evaluate(element => getComputedStyle(element).visibility)).toBe('visible');
  await ghost.evaluate(element => element.getAnimations().forEach(animation => animation.finish()));

  await page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true }).click();
  await expect.poll(() => hold(deck)).not.toBeNull();
  const flying = await hold(deck);
  // A song change acknowledges itself on the deck's cover, but not by snapping it out of its flight.
  await emitNext('next-while-closing');
  await expect(page.locator('.compact-track-title')).toHaveText(fixture.state.snapshot.session.current!.title);
  expect(await deck.evaluate(element => element.getAnimations().filter(animation => !(animation instanceof CSSTransition)).length)).toBe(1);
  expect(await hold(deck)).toEqual(flying);
});

test('a cover replaced mid-flight carries on flying instead of jumping to its place', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const emit = (change: (session: typeof fixture.state.snapshot.session) => void, revision: string) => {
    const state = fixture.state.snapshot; change(state.session); state.revision = revision;
    return page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), state);
  };
  // Holds the current cover element partway through its flight; null while none is flying.
  const held = (selector: string) => page.locator(selector).evaluate(element => {
    const glide = element.getAnimations().find(animation => animation.constructor === Animation);
    if (!glide) return null;
    glide.pause(); glide.currentTime = 120;
    return { tag: element.tagName, width: Math.round(element.getBoundingClientRect().width) };
  });
  const sleeve = '.sleeve-artwork > .artwork'; const deck = '.player-expand-trigger > .artwork';

  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect.poll(() => held(sleeve)).not.toBeNull();
  const opening = (await held(sleeve))!;
  // A song without artwork arrives mid-flight: the fallback cover replaces the picture and keeps flying.
  await emit(session => { session.queue.push(session.current!); session.current = { ...session.queue.shift()!, artworkUrl: null }; }, 'no-art-while-opening');
  await expect.poll(async () => (await held(sleeve))?.tag).toBe('PICTURE');
  expect((await held(sleeve))!.width).toBe(opening.width);
  await page.locator(sleeve).evaluate(element => element.getAnimations().find(animation => animation.constructor === Animation)!.finish());

  await page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true }).click();
  await expect.poll(() => held(deck)).not.toBeNull();
  const closing = (await held(deck))!;
  // Playback stops mid-flight: the empty sleeve replaces the cover and keeps flying.
  await emit(session => { session.current = null; session.status = 'idle'; session.queue = []; }, 'stopped-while-closing');
  await expect.poll(async () => (await held(deck))?.tag).toBe('SPAN');
  expect((await held(deck))!.width).toBe(closing.width);
});
