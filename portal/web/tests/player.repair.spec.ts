import { expect, test, type Locator, type Page } from '@playwright/test';
import { mockPortal, streamAction } from './fixtures';

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
      await page.goto('/');
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
      for (const selector of ['.guild-channel', '.guild-status']) {
        expect(await page.locator(selector).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(14);
      }
      await open.click();
      await expect(player.getByRole('heading', { name: longTitle, exact: true })).toBeVisible();
      expect(fixture.commands).toHaveLength(0);
      await player.getByRole('button', { name: 'Back to queue', exact: true }).first().click();
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
    await page.goto('/');
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
    await expect(player.locator('.player-more .menu-panel')).toHaveCount(1);
    await visibleBounds(player.locator('.player-more > .menu-panel'), page);
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
  await page.goto('/');
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const player = page.getByTestId('player');
  const heading = player.getByRole('heading', { name: longTitle, exact: true });
  await visibleBounds(heading, page);
  const artist = await visibleBounds(player.locator('.player-identity p'), page);
  const sleeve = await player.locator('.sleeve-main').boundingBox();
  expect(artist.y + artist.height).toBeLessThanOrEqual(sleeve!.y + sleeve!.height + 1);
  expect(await player.locator('.sleeve-main').evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  const art = await visibleBounds(player.locator('.sleeve-artwork > .artwork'), page);
  const queue = await player.locator('.sleeve-queue').boundingBox();
  expect(art.x + art.width).toBeLessThan(queue!.x);
  expect(artist.y + artist.height).toBeLessThan((await player.locator('.player-footer').boundingBox())!.y);
});

test('expanded permission explanation names the voice destination and leaves controls disabled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page, { outsideVoice: true });
  fixture.state.snapshot.session.voiceChannel!.name = 'Chill Lounge';
  fixture.state.snapshot.session.textChannel!.name = 'music-commands';
  fixture.state.snapshot.session.reason = 'Join Chill Lounge to add music or use playback controls.';
  await page.goto('/');
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const player = page.getByTestId('player');
  await expect(player.locator('.player-destination')).toContainText('Audio in Chill Lounge');
  await expect(player.locator('.player-permission')).toHaveText('Join Chill Lounge to add music or use playback controls.');
  await expect(player.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await expect(player.getByRole('slider', { name: 'Volume', exact: true })).toBeDisabled();
  expect(fixture.commands).toHaveLength(0);
});

test('player action popover dismisses by Escape, outside activation, and completed action', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
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
  await player.getByRole('button', { name: 'Turn artist radio on', exact: true }).click();
  await expect(player.locator('.player-more > .menu-panel')).toHaveCount(0);
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('radio');
});

test('short offline sleeve keeps transport visible and reduced motion leaves intentional syncing feedback', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await mockPortal(page);
  await page.goto('/');
  await waitForPlayer(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  fixture.delayCommand(1500);
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
});
