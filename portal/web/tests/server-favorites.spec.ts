import { test, expect, type Page } from '@playwright/test';
import { mockPortal } from './fixtures';

async function openServerFavorites(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: 'Server favorites' }).click();
}

test('server favorites show both ranked lists and queue them with Play all or Shuffle', async ({ page }) => {
  const fixture = await mockPortal(page);
  await openServerFavorites(page);
  const onRepeat = page.getByRole('region', { name: 'On repeat' });
  const gems = page.getByRole('region', { name: 'Forgotten gems' });
  await expect(onRepeat.getByRole('listitem')).toHaveCount(4);
  await expect(onRepeat.getByRole('listitem').first()).toContainText('9 plays');
  await expect(gems.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('tabpanel')).not.toContainText('requested by', { ignoreCase: true });

  await onRepeat.getByRole('button', { name: 'Play all of On repeat' }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle: false } });
  await expect(gems.getByRole('button', { name: 'Shuffle Forgotten gems' })).toBeEnabled();
  await gems.getByRole('button', { name: 'Shuffle Forgotten gems' }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'top', subcommand: 'play', options: { list: 'forgotten-gems', shuffle: true } });
});

test('server favorites respect add permission and explain empty and failed states', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.canAdd = false;
  fixture.state.stats.serverFavorites.forgottenGems = [];
  await openServerFavorites(page);
  await expect(page.getByRole('button', { name: 'Play all of On repeat' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Forgotten gems' })).toContainText('No forgotten gems yet');
  await expect(page.getByRole('button', { name: 'Shuffle Forgotten gems' })).toHaveCount(0);

  fixture.state.stats.serverFavorites.onRepeat = [];
  await page.getByRole('button', { name: 'Refresh server favorites' }).click();
  await expect(page.getByRole('heading', { name: 'Your server’s favorites start here' })).toBeVisible();

  await page.route('**/api/guilds/*/stats*', route => route.fulfill({ status: 503, json: { error: { code: 'stats_unavailable', message: 'Listening stats are unavailable right now. Playback is unaffected.' } } }));
  await page.getByRole('tab', { name: 'History' }).click();
  await page.getByRole('tab', { name: 'Server favorites' }).click();
  await expect(page.getByRole('alert')).toContainText('Playback is unaffected');
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('server favorites tab joins keyboard tab navigation', async ({ page }) => {
  await mockPortal(page);
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: /Favorites/ }).first().focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Server favorites' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /^Favorites/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Server favorites' })).toHaveAttribute('aria-selected', 'true');
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`server favorites layout holds on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockPortal(page);
    await openServerFavorites(page);
    await expect(page.getByRole('region', { name: 'On repeat' }).getByRole('listitem')).toHaveCount(4);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/server-favorites-${name}.png`, fullPage: true });
  });
}
