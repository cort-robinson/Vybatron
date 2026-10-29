import { test, expect } from './test';
import { mockPortal, gotoSession, openServer, openSettings, streamAction } from './fixtures';

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

test('an open search keeps its form and query across the breakpoint, and never doubles up', async ({ page }) => {
  await page.setViewportSize(phone);
  await mockPortal(page); await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('Midnight');
  await page.setViewportSize({ width: 1280, height: 900 });
  const field = page.locator('.search-page').getByRole('searchbox', { name: 'Music search' });
  await expect(field).toHaveValue('Midnight');
  await page.getByRole('button', { name: 'Home', exact: true }).focus();
  // The top-bar search goes to the Search page already showing, not a second search on top of it.
  await page.getByRole('button', { name: 'Search music' }).click();
  await expect(field).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Shared Queue', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A desktop dialog stays a dialog on a phone, and resizing never opens one.
  await page.getByRole('button', { name: 'Search music' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add music' });
  await expect(dialog.getByRole('searchbox', { name: 'Music search' })).toBeFocused();
  await page.setViewportSize(phone);
  await expect(dialog.getByRole('searchbox', { name: 'Music search' })).toHaveValue('Midnight');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('resizing with the player open over phone Search leaves the player open and opens nothing', async ({ page }) => {
  await page.setViewportSize(phone);
  await mockPortal(page); await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.setViewportSize(phone);
  await expect(page.getByRole('button', { name: 'Close player', exact: true }).filter({ visible: true })).toBeVisible();
});

test('a playback error shows while the player covers the phone Search page', async ({ page }) => {
  await page.setViewportSize(phone);
  await mockPortal(page); await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.route('**/api/guilds/*/commands', route => route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Playback control is unavailable right now.' } } }));
  await page.getByRole('button', { name: 'Skip current song' }).filter({ visible: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Playback control is unavailable right now.' })).toBeVisible();
});

test('shared mixes list the mixes before the tools for making new ones', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: /Shared mixes/ }).click();
  const mix = await page.getByRole('button', { name: 'View mix Night shift' }).boundingBox();
  const save = await page.getByLabel('Save this session as a mix').boundingBox();
  expect(mix!.y).toBeLessThan(save!.y);
});

test('offline Home explains the wait once, in the connection banner', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await streamAction(page, 'disconnect');
  await expect(page.locator('.connection-banner')).toBeVisible();
  await expect(page.locator('.home-view .permission-note')).toHaveCount(0);
});

test('the phone Search field sticks to the top edge, with one focus ring in every look', async ({ page }) => {
  await page.setViewportSize(phone);
  for (const skin of ['fantastic', 'haunted', 'overdrive', 'classic']) {
    await page.addInitScript(s => localStorage.setItem('vybertron.skin', s), skin);
    const fixture = await mockPortal(page);
    for (let i = 0; i < 8; i++) fixture.state.library.favorites.push({ ...fixture.state.library.favorites[0], id: `fav${i}`.padEnd(24, '0'), title: `Song ${i}`, uri: `https://example.com/music/s${i}` });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Search' }).click();
    const field = page.locator('.search-page').getByRole('searchbox', { name: 'Music search' });
    await expect(field).toBeFocused();
    // The field's own pill draws the ring; the input inside it draws none.
    expect(await field.evaluate(el => getComputedStyle(el).boxShadow)).toBe('none');
    await page.evaluate(() => scrollTo(0, 400));
    await expect.poll(async () => Math.round((await page.locator('.search-page .search-form').boundingBox())!.y)).toBe(0);
  }
});
