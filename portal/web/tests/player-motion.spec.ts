import { expect, test } from '@playwright/test';
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

for (const width of [390, 1280]) {
  test(`the ${width}px cover lands in place and the caption has one entrance`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const start = document.startViewTransition.bind(document);
      const record = window as unknown as { playerMotions: { sizes: string[]; bounds: { x: number; y: number; width: number; height: number }[]; captionOpacity?: string; captionEntrances?: number }[] };
      record.playerMotions = [];
      document.startViewTransition = ((update: () => void) => {
        const view = start(update);
        void view.ready.then(async () => {
          // Let the app's ready callback install the compositor animation first.
          await Promise.resolve();
          const effect = document.getAnimations().map(a => a.effect).find(effect => effect instanceof KeyframeEffect && effect.pseudoElement === '::view-transition-group(player-cover)') as KeyframeEffect | undefined;
          if (!effect) return;
          const frames = effect.getKeyframes();
          const caption = document.querySelector('.player-identity');
          record.playerMotions.push({ sizes: frames.map(frame => `${frame.width}:${frame.height}`), bounds: frames.map(frame => {
            const matrix = new DOMMatrix(String(frame.transform));
            const origin = matrix.transformPoint({ x: 0, y: 0 });
            const corner = matrix.transformPoint({ x: parseFloat(String(frame.width)), y: parseFloat(String(frame.height)) });
            return { x: origin.x, y: origin.y, width: corner.x - origin.x, height: corner.y - origin.y };
          }), captionOpacity: caption ? getComputedStyle(caption).opacity : undefined,
          captionEntrances: caption?.getAnimations().filter(a => a instanceof CSSAnimation).length });
        }, () => undefined);
        return view;
      }) as typeof start;
    });
    await mockPortal(page); await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.evaluate(() => document.fonts.ready);
    const compact = (await page.locator('.player-expand-trigger > .artwork').boundingBox())!;
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    const read = () => page.evaluate(() => (window as unknown as { playerMotions: { sizes: string[]; bounds: { x: number; y: number; width: number; height: number }[]; captionOpacity?: string; captionEntrances?: number }[] }).playerMotions);
    await expect.poll(async () => (await read()).length).toBe(1);
    const sleeve = (await page.locator('.sleeve-artwork > .artwork').boundingBox())!;
    const [opening] = await read();
    expect(opening.captionOpacity).toBe('1');
    expect(opening.captionEntrances).toBe(0);
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(opening.bounds[0][key] - compact[key])).toBeLessThanOrEqual(1);
      expect(Math.abs(opening.bounds[1][key] - sleeve[key])).toBeLessThanOrEqual(1);
    }
    await page.waitForFunction(() => !document.documentElement.dataset.motion);
    await page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true }).click();
    await expect.poll(async () => (await read()).length).toBe(2);
    const [, closing] = await read();
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(closing.bounds[0][key] - sleeve[key])).toBeLessThanOrEqual(1);
      expect(Math.abs(closing.bounds[1][key] - compact[key])).toBeLessThanOrEqual(1);
    }
  });
}

test('a permission update during opening moves the cover destination with the live layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = ((update: () => void) => {
      const view = start(update);
      void view.ready.then(() => {
        const cover = document.getAnimations().find(a => (a.effect as KeyframeEffect)?.pseudoElement === '::view-transition-group(player-cover)');
        cover?.pause(); if (cover) cover.currentTime = 120;
      }, () => undefined);
      return view;
    }) as typeof start;
  });
  const fixture = await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.getAnimations().find(a => (a.effect as KeyframeEffect)?.pseudoElement === '::view-transition-group(player-cover)')?.playState)).toBe('paused');
  fixture.state.snapshot.session.canControl = false;
  fixture.state.snapshot.session.reason = 'Join General to control playback.';
  fixture.state.snapshot.revision = 'permission-during-opening';
  await page.evaluate(data => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(data), fixture.state.snapshot);
  await expect(page.locator('.player-permission')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const effect = document.getAnimations().find(a => (a.effect as KeyframeEffect)?.pseudoElement === '::view-transition-group(player-cover)')!.effect as KeyframeEffect;
    const frame = effect.getKeyframes().at(-1)!;
    const matrix = new DOMMatrix(String(frame.transform));
    const origin = matrix.transformPoint({ x: 0, y: 0 });
    const corner = matrix.transformPoint({ x: parseFloat(String(frame.width)), y: parseFloat(String(frame.height)) });
    const box = document.querySelector('.sleeve-artwork > .artwork')!.getBoundingClientRect();
    return Math.max(Math.abs(origin.x - box.x), Math.abs(origin.y - box.y), Math.abs(corner.x - origin.x - box.width), Math.abs(corner.y - origin.y - box.height));
  })).toBeLessThanOrEqual(1);
});
