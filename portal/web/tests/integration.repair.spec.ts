import { test, expect } from '@playwright/test';
import { mockPortal, streamAction } from './fixtures';
import { startHttpFixture } from './http-fixture';

for (const width of [1280, 390]) {
  for (const command of ['clear', 'stop']) {
    test(`expanded ${width}px ${command} confirmation accepts pointer cancellation and one deliberate write`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 720 });
      const fixture = await mockPortal(page); await page.goto('/');
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      const open = async () => {
        await page.getByRole('button', { name: 'More playback controls' }).click();
        await page.getByRole('button', { name: command === 'clear' ? 'Clear upcoming queue' : 'Stop and discard session', exact: true }).click();
      };
      await open();
      const dialog = page.getByRole('dialog');
      expect(await dialog.evaluate(e => getComputedStyle(e).pointerEvents)).toBe('auto');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(fixture.commands).toEqual([]);
      await open(); await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      expect(fixture.commands).toEqual([]);
      await open();
      await dialog.getByRole('button', { name: command === 'clear' ? 'Clear queue' : 'Stop and discard', exact: true }).click();
      await expect.poll(() => fixture.commands.length).toBe(1);
      expect(fixture.commands[0]).toEqual(command === 'clear' ? { command, expectedRevision: 'revision-1' } : { command });
      await expect(dialog).toHaveCount(0);
    });
  }
}

test('advanced drafts survive navigation and expansion without recapturing selected identity', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByRole('tab', { name: 'Advanced controls' }).click();
  await page.getByLabel('Command', { exact: true }).selectOption('playnext');
  await page.getByLabel('query', { exact: false }).fill('keep my typed song');
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await expect(page.getByLabel('query', { exact: false })).toHaveValue('keep my typed song');
  await page.getByLabel('Command', { exact: true }).selectOption('favorite');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('remove');
  await page.getByLabel('index', { exact: false }).fill('1');
  const original = fixture.state.library.favorites[0].id;
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  fixture.state.library.favorites.reverse();
  await page.getByRole('button', { name: 'Back to queue', exact: true }).click();
  await expect(page.getByText('Selected: Night Drive', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply control', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0].expectedTrackId).toBe(original);
  expect(fixture.commands[0].options?.index).toBe(1);
});

for (const width of [1024, 1280, 1488]) {
  test(`expanded ${width}px queue has readable titles and desktop navigation receives pointer input`, async ({ page }) => {
    await page.setViewportSize({ width, height: 768 });
    const fixture = await mockPortal(page); await page.goto('/');
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    const text = page.locator('.queue-compact .track-text').first();
    expect((await text.boundingBox())!.width).toBeGreaterThan(70);
    expect(await text.locator('strong').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'My Music', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Favorites', exact: true })).toBeVisible();
    expect(fixture.commands).toEqual([]);
  });
}

for (const status of [403, 404]) {
  test(`search retires server results after authoritative ${status} and cannot redisplay them`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await page.route('**/api/guilds/testing/search?*', route => route.fulfill({ json: { tracks: [{ ...server.state.snapshot.session.current!, title: 'Midnight City' }], notice: null } }));
      await page.goto(server.origin);
      await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
      await page.getByRole('button', { name: 'Add music', exact: true }).click();
      await page.getByRole('searchbox', { name: 'Music search' }).fill('my private draft');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(page.getByText('Midnight City', { exact: true })).toBeVisible();
      server.applicationError(status);
      await expect(page.getByText('Midnight City', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('my private draft');
      await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await page.getByRole('button', { name: 'Add music', exact: true }).click();
      await expect(page.getByText('Midnight City', { exact: true })).toHaveCount(0);
      expect(server.commands).toEqual([]);
    } finally { await page.close(); await server.close(); }
  });
}

test('transient disconnect retains search results and typed input while disabling additions', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Add music', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('a song draft');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Midnight City', { exact: true })).toBeVisible();
  await streamAction(page, 'disconnect');
  await expect(page.getByText('Midnight City', { exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('a song draft');
  await expect(page.getByRole('button', { name: 'Add Midnight City to queue', exact: true })).toBeDisabled();
  expect(fixture.commands).toEqual([]);
});
