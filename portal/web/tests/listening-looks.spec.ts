import { test, expect } from './test';
import { mockPortal, openSettings } from './fixtures';

test('a device can switch between paper, dark ink and the studio desk, and restore its previous look', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPortal(page);
  await page.goto('/');
  await openSettings(page);
  const look = page.getByLabel('Portal look');
  for (const [choice, name, scheme] of [['sleeve-light', 'Sleeve Notes · Light', 'light'], ['sleeve-dark', 'Sleeve Notes · Dark', 'dark'], ['broadcast', 'Broadcast Desk', 'dark']]) {
    await look.getByRole('button', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-skin', choice);
    await expect(page.locator('html')).toHaveCSS('color-scheme', scheme);
  }
  await page.reload();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'broadcast');
  await expect(page.getByTestId('player').getByText('Added by Jordan')).toBeVisible();
  const deck = await page.getByTestId('player').boundingBox();
  const rows = await page.locator('.queue .track-list').boundingBox();
  expect(deck!.x + deck!.width).toBeLessThanOrEqual(rows!.x);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await expect(page.getByRole('button', { name: 'Sleep timer' })).toBeVisible();
  await page.keyboard.press('Escape');
  await openSettings(page);
  await look.getByRole('button', { name: 'Classic', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'classic');
  await expect(page.locator('.ambient-scene')).toBeVisible();
});

test('Listening Wall previews the next three tracks and opens the complete queue on desktop and phone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPortal(page);
  await page.goto('/');
  await openSettings(page);
  await page.getByLabel('Portal look').getByRole('button', { name: 'Listening Wall', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'wall');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.locator('.queue-filmstrip li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Open full queue' }).click();
  await expect(page.getByRole('dialog').getByText('Afterglow', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open full queue' })).toBeFocused();
  await page.goBack();
  const openPlayer = page.getByRole('button', { name: 'Open player', exact: true });
  await expect(openPlayer).toBeVisible();
  await openPlayer.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /^Up next/ }).click();
  await expect(page.locator('.sleeve-queue').getByText('Afterglow', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Hide queue' }).click();
  await expect(page.getByRole('button', { name: 'Show visualizer' })).toBeVisible();
});

test('Listening Wall on TV opens on the artwork and gives the remote access to the queue and visualizer', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vybertron.skin', 'wall'));
  await mockPortal(page);
  await page.goto('/?tv=1');
  const tv = page.getByTestId('tv-home');
  await expect(tv.locator('.tv-stage > img.artwork')).toBeVisible();
  await tv.getByRole('button', { name: 'Open full queue' }).click();
  await expect(page.getByRole('dialog').getByText('Afterglow', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await tv.getByRole('button', { name: 'Visualizer', exact: true }).click();
  await tv.getByRole('button', { name: 'Show visualizer' }).click();
  await expect(tv.getByRole('button', { name: 'Show cover art' })).toBeVisible();
  await tv.getByRole('button', { name: 'Show cover art' }).click();
  await expect(tv.locator('.tv-stage > img.artwork')).toBeVisible();
});
