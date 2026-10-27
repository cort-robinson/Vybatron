import { test, expect } from './test';
import { mockPortal, gotoSession, openServer, openSettings } from './fixtures';

const phone = { width: 393, height: 852 };

test('a search result plays next in one step', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Search music' }).click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('Midnight City');
  await page.getByRole('button', { name: 'Play Midnight City next' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['playnext']);
});

test('desktop queue rows play next and remove without opening the menu', async ({ page }) => {
  const fixture = await mockPortal(page); await gotoSession(page);
  // The first upcoming song is already next.
  await expect(page.getByRole('button', { name: 'Play Night Drive next' })).toBeDisabled();
  await page.getByRole('button', { name: 'Play Afterglow next' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('move');
  expect(fixture.commands.at(-1)?.options).toMatchObject({ from: 4, to: 1 });
  await page.getByRole('button', { name: 'Remove Golden Hour from queue' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('remove');
});

test('desktop keeps personal settings apart from the server page', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await openSettings(page);
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Ambient motion')).toBeVisible();
  await expect(page.getByLabel('Default volume')).toBeHidden();
  await page.getByRole('button', { name: 'Account options' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Portal look')).toBeVisible();
  await openServer(page);
  await expect(page.getByLabel('Default volume')).toBeVisible();
  await expect(page.getByLabel('Portal look')).toBeHidden();
  // Search lives in the top bar on desktop, not the sidebar.
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' })).toBeHidden();
});

test('phone navigation keeps Search in the bottom bar and Server and Settings in the account menu', async ({ page }) => {
  await page.setViewportSize(phone);
  const fixture = await mockPortal(page); await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('button').filter({ visible: true })).toHaveText(['Home', 'Search', 'Queue', 'My Music']);
  await nav.getByRole('button', { name: 'Search' }).click();
  const field = page.getByRole('searchbox', { name: 'Music search' });
  await expect(field).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await field.fill('Midnight City');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['play']);
  await page.getByRole('button', { name: 'Account options' }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Server', exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole('tablist', { name: 'Server sections' })).toBeVisible();
  await page.getByRole('button', { name: 'Account options' }).filter({ visible: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel('Portal look')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('the phone mini player favorites the current song without opening the player', async ({ page }) => {
  await page.setViewportSize(phone);
  await mockPortal(page); await page.goto('/');
  const heart = page.getByRole('button', { name: /current song (to|from) favorites/ }).filter({ visible: true });
  await expect(heart).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Open player', exact: true })).toBeVisible();
  const [deck, button] = [(await page.locator('.player-footer').boundingBox())!, (await heart.boundingBox())!];
  expect(button.width).toBeGreaterThanOrEqual(44);
  expect(button.y).toBeGreaterThanOrEqual(deck.y);
});
