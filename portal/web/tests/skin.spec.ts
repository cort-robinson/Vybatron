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
