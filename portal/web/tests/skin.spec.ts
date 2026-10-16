import { test, expect } from '@playwright/test';
import { mockPortal } from './fixtures';

test('Classic look renders without Overdrive scenery and switches back live from Settings', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('vybertron.skin', 'classic'); sessionStorage.setItem('seeded', '1'); } });
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'classic');
  await expect(page.locator('.od-horizon')).toHaveCount(0);
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('overdrive');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await expect(page.locator('.od-horizon')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
});

test('Fantastic Four is opt-in: it swaps in the Earth-828 scenery and the sleeve television, and persists', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('fantastic');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'fantastic');
  await expect(page.locator('.ff-scene')).toHaveCount(1);
  await expect(page.locator('.od-horizon')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'fantastic');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.locator('.sleeve-artwork .ff-tv')).toHaveCount(1);
  await expect(page.locator('.sleeve-artwork .od-cover-hud')).toHaveCount(0);
});

test('performance mode drops glass blur and stills the scene, and stays on after a reload', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const blur = () => page.locator('.sidebar').evaluate(element => getComputedStyle(element).backdropFilter);
  // The one-time power-on animates the chrome; read the settled style.
  await expect(page.locator('html')).not.toHaveAttribute('data-boot');
  expect(await blur()).not.toBe('none');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Performance mode' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-performance', '');
  expect(await blur()).toBe('none');
  await expect(page.locator('.ambient-scene')).toHaveClass(/settled/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-performance', '');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByRole('switch', { name: 'Performance mode' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-performance');
});

test('a mouse drags an overflowing shelf sideways without pressing what it grabbed', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const fixture = await mockPortal(page); await page.goto('/');
  const shelf = page.getByRole('list', { name: 'Your mixes' });
  await expect(shelf).toHaveClass(/can-drag/);
  const play = shelf.getByRole('button', { name: /^Play/ }).first();
  await play.scrollIntoViewIfNeeded();
  const box = (await play.boundingBox())!;
  const before = fixture.commands.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width / 2 - step * 30, box.y + box.height / 2);
  await page.waitForTimeout(150); await page.mouse.up();
  // The drag outruns the shelf, so it ends scrolled fully to the far edge.
  await expect.poll(() => shelf.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1);
  expect(await shelf.evaluate(element => element.scrollLeft)).toBeGreaterThan(20);
  await page.waitForTimeout(300);
  expect(fixture.commands.length).toBe(before);
  // A press that barely moves is still an ordinary click.
  await play.click();
  await expect.poll(() => fixture.commands.length).toBe(before + 1);
});
