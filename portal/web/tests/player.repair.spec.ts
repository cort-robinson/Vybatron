import { expect, test, type Locator, type Page } from './test';
import { landed, mockPortal, streamAction, gotoSession } from './fixtures';

const longTitle = 'Evening Light — a very long live performance title with extended artist credits, a remastered collection name, and a full recording description';

async function visibleBounds(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
  return box!;
}

async function waitForPlayer(page: Page) {
  await expect(page.getByTestId('player')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const width of [320, 390]) {
  for (const outsideVoice of [false, true]) {
    test(`compact ${width}px long title has separate targets (${outsideVoice ? 'read only' : 'enabled'})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const fixture = await mockPortal(page, { outsideVoice });
      fixture.state.snapshot.session.current!.title = longTitle;
      await gotoSession(page);
      await waitForPlayer(page);
      const player = page.getByTestId('player');
      const identity = player.getByRole('button', { name: `Open player for ${longTitle}`, exact: true });
      const pause = player.getByRole('button', { name: 'Pause playback', exact: true });
      const skip = player.getByRole('button', { name: 'Skip current song', exact: true });
      const open = player.getByRole('button', { name: 'Open player', exact: true });
      const boxes = await Promise.all([identity, pause, skip, open].map(locator => visibleBounds(locator, page)));
      for (let i = 0; i < boxes.length; i++) {
        expect(boxes[i].width).toBeGreaterThanOrEqual(44);
        expect(boxes[i].height).toBeGreaterThanOrEqual(44);
        if (i) expect(boxes[i - 1].x + boxes[i - 1].width).toBeLessThanOrEqual(boxes[i].x + 1);
      }
      const text = await player.locator('.compact-title').evaluate(element => {
        const title = element.querySelector('.compact-track-title')!;
        const meta = element.querySelector('.compact-track-meta')!;
        return { clipped: title.scrollWidth > title.clientWidth, titleSize: parseFloat(getComputedStyle(title).fontSize), metaSize: parseFloat(getComputedStyle(meta).fontSize), right: element.getBoundingClientRect().right };
      });
      expect(text.clipped).toBe(true);
      expect(text.titleSize).toBeGreaterThanOrEqual(16);
      expect(text.metaSize).toBeGreaterThanOrEqual(14);
      expect(text.right).toBeLessThanOrEqual(boxes[1].x);
      const server = await page.getByRole('combobox', { name: 'Server', exact: true }).boundingBox();
      expect(server!.height).toBeGreaterThanOrEqual(44);
      for (const selector of ['.guild-status']) {
        expect(await page.locator(selector).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      }
      await open.click();
      await expect(player.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
      expect(fixture.commands).toHaveLength(0);
      await player.getByRole('button', { name: 'Close player', exact: true }).first().click();
      await identity.click();
      await expect(player.getByRole('heading', { name: longTitle, exact: true })).toBeFocused();
      expect(fixture.commands).toHaveLength(0);
    });
  }
}

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 640, height: 400 }]) {
  test(`expanded transport stays on screen at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await mockPortal(page);
    fixture.state.snapshot.session.current!.title = longTitle;
    await gotoSession(page);
    await waitForPlayer(page);
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    const player = page.getByTestId('player');
    for (const name of ['Shuffle queue', 'Restart current song', 'Pause playback', 'Skip current song', 'Repeat: off. Change repeat mode', 'More playback controls']) {
      const box = await visibleBounds(player.getByRole('button', { name, exact: true }), page);
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await visibleBounds(player.getByRole('slider', { name: 'Playback position' }), page);
    await visibleBounds(player.getByRole('slider', { name: 'Volume', exact: true }), page);
    await visibleBounds(player.getByRole('combobox', { name: 'Audio filter' }), page);
    await expect(player.locator('.transport')).toHaveCount(1);
    await expect(player.getByRole('slider', { name: 'Playback position' })).toHaveCount(1);
    await player.getByRole('button', { name: 'More playback controls' }).click();
    // Phones get the menu as a bottom sheet; wider screens keep the popover inside the deck.
    const menu = page.getByRole('group', { name: 'More playback controls' }).or(player.locator('.player-more > .menu-panel'));
    await expect(menu).toHaveCount(1);
    await menu.evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await visibleBounds(menu, page);
    await page.keyboard.press('Escape');
    const titleLines = await player.locator('.player-identity h2').evaluate(element => element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight));
    expect(titleLines).toBeGreaterThan(1.5);
    expect(titleLines).toBeLessThanOrEqual(2.1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('desktop sleeve keeps artwork left, Up Next right, and identity readable without scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.current!.title = longTitle;
  await gotoSession(page);
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const player = page.getByTestId('player');
  const heading = player.getByRole('heading', { name: longTitle, exact: true });
  await visibleBounds(heading, page);
  // Measure the settled sleeve, not its entrance rise.
  await player.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => undefined))));
  const artist = await visibleBounds(player.locator('.player-identity p'), page);
  const sleeve = await player.locator('.sleeve-main').boundingBox();
  expect(artist.y + artist.height).toBeLessThanOrEqual(sleeve!.y + sleeve!.height + 1);
  expect(await player.locator('.sleeve-main').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const art = await visibleBounds(player.locator('.sleeve-artwork > .artwork'), page);
  const queue = await player.locator('.sleeve-queue').boundingBox();
  expect(art.x + art.width).toBeLessThan(queue!.x);
  expect(artist.y + artist.height).toBeLessThan((await player.locator('.player-footer').boundingBox())!.y);
});

test('expanded permission explanation keeps the voice destination in view and leaves controls disabled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page, { outsideVoice: true });
  fixture.state.snapshot.session.voiceChannel!.name = 'Chill Lounge';
  fixture.state.snapshot.session.textChannel!.name = 'music-commands';
  fixture.state.snapshot.session.reason = 'Join Chill Lounge to add music or use playback controls.';
  await gotoSession(page);
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(page.locator('.guild-status')).toContainText('Chill Lounge');
  await expect(player.locator('.player-permission')).toHaveText('Join Chill Lounge to add music or use playback controls.');
  await expect(player.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await expect(player.getByRole('slider', { name: 'Volume', exact: true })).toBeDisabled();
  expect(fixture.commands).toHaveLength(0);
});

test('player action popover dismisses by Escape, outside activation, and completed action', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  await waitForPlayer(page);
  const player = page.getByTestId('player');
  const more = player.getByRole('button', { name: 'More playback controls' });
  await more.click();
  await expect(player.getByRole('button', { name: 'Vote to skip', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(player.locator('.player-more > .menu-panel')).toHaveCount(0);
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('heading', { name: 'Shared Queue', exact: true }).click();
  await expect(player.locator('.player-more > .menu-panel')).toHaveCount(0);
  await more.click();
  await player.getByRole('button', { name: 'Turn autoplay on', exact: true }).click();
  await expect(player.locator('.player-more > .menu-panel')).toHaveCount(0);
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('radio');
});

test('short offline sleeve keeps transport visible and reduced motion leaves intentional syncing feedback', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockPortal(page);
  await gotoSession(page);
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  // The reply waits until the checks below finish; landing earlier would end the offline state they look at.
  const release = fixture.holdCommands();
  await page.getByTestId('player').getByRole('button', { name: 'Pause playback' }).click();
  const pending = page.getByTestId('player').locator('.player-confirmation .spinner');
  await expect(pending).toBeVisible();
  const feedback = await pending.evaluate(element => ({ animation: getComputedStyle(element).animationName, border: getComputedStyle(element).borderTopStyle }));
  expect(feedback).toEqual({ animation: 'none', border: 'dotted' });
  // A slow confirmation is shown quietly; the player itself stays usable.
  await expect(page.getByRole('group', { name: 'Playback controls' })).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('player').getByText('Syncing with Discord…', { exact: true })).toBeVisible();
  await expect(page.getByTestId('player').locator('.play-button .spinner')).toHaveCount(0);
  await expect(page.getByTestId('player').getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await streamAction(page, 'disconnect');
  const resume = page.getByTestId('player').getByRole('button', { name: 'Resume playback' });
  await expect(resume).toBeDisabled();
  await visibleBounds(resume, page);
  await expect(page.getByTestId('player').locator('.player-permission')).toContainText('Reconnect for fresh state');
  release();
});

test('phone sleeve centers the empty cover icon and rings the whole filter pill', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockPortal(page, { saved: true });
  await gotoSession(page);
  await waitForPlayer(page);
  const player = page.getByTestId('player');
  await player.getByRole('button', { name: 'Open player', exact: true }).click();
  const cover = player.locator('.sleeve-artwork > .artwork-empty');
  await landed(cover);
  const [coverBox, iconBox] = await Promise.all([visibleBounds(cover, page), visibleBounds(cover.locator('svg'), page)]);
  expect(Math.abs((iconBox.x + iconBox.width / 2) - (coverBox.x + coverBox.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((iconBox.y + iconBox.height / 2) - (coverBox.y + coverBox.height / 2))).toBeLessThanOrEqual(1);
  const filter = player.getByRole('combobox', { name: 'Audio filter', exact: true });
  await filter.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const ring = await filter.evaluate(select => {
    const pill = select.parentElement!;
    const a = select.getBoundingClientRect(); const b = pill.getBoundingClientRect();
    return { select: [a.left, a.top, a.right, a.bottom], pill: [b.left, b.top, b.right, b.bottom].map((v, i) => v + (i < 2 ? 1 : -1)), pillOutline: getComputedStyle(pill).outlineStyle, selectOutline: getComputedStyle(select).outlineStyle };
  });
  ring.select.forEach((value, i) => expect(Math.abs(value - ring.pill[i])).toBeLessThanOrEqual(1));
  expect(ring.pillOutline).toBe('solid');
  expect(ring.selectOutline).toBe('none');
});

test('icon-only transport controls keep their name as a hover tooltip while usable', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  const transport = page.getByRole('group', { name: 'Playback controls' });
  await expect(transport.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(transport.getByRole('button', { name: 'Shuffle queue' })).toHaveAttribute('title', 'Shuffle queue');
  await expect(transport.getByRole('button', { name: /^Repeat: / })).toHaveAttribute('title', /^Repeat: /);
});

test('Back returns to the previous song early in a track and restarts it later', async ({ page }) => {
  const fixture = await mockPortal(page);
  Object.assign(fixture.state.snapshot.session, { status: 'paused', positionMs: 1_000, hasPrevious: true });
  await gotoSession(page);
  await waitForPlayer(page);
  const player = page.getByTestId('player');
  const revision = fixture.state.snapshot.revision;
  await player.getByRole('button', { name: 'Previous song', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'back', expectedRevision: revision });

  Object.assign(fixture.state.snapshot.session, { positionMs: 60_000 });
  await page.reload();
  await waitForPlayer(page);
  await player.getByRole('button', { name: 'Restart current song', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('seek');
  expect(fixture.commands.at(-1)?.options).toEqual({ timestamp: '00:00' });
});

test('open player upgrades a YouTube cover to its sharpest frame, skipping placeholders', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const frame = (width: number, height: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#c84"/></svg>`;
  // YouTube answers a size the video lacks with a 120×90 placeholder.
  const sizes: Record<string, [number, number]> = { mqdefault: [320, 180], maxresdefault: [120, 90], hq720: [1280, 720] };
  await page.route('https://i.ytimg.com/vi/**', route => {
    const [width, height] = sizes[new URL(route.request().url()).pathname.split('/').at(-1)!.replace('.jpg', '')] ?? [120, 90];
    return route.fulfill({ status: width === 120 ? 404 : 200, contentType: 'image/svg+xml', body: frame(width, height) });
  });
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.current!.artworkUrl = 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg';
  await gotoSession(page);
  await waitForPlayer(page);
  const player = page.getByTestId('player');
  await expect(player.locator('.player-expand-trigger > .artwork')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
  await player.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(player.locator('.sleeve-artwork > img.artwork')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/hq720.jpg');
});
