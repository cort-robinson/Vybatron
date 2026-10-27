import { test, expect } from './test';
import { mockPortal, gotoSession, INVITE_URL, openSettings } from './fixtures';

const external = { target: '_blank', rel: 'noopener noreferrer' };

test('account menu and settings page offer the Discord add-to-server link in a new tab', async ({ page }) => {
  await mockPortal(page); await gotoSession(page);
  await page.getByRole('button', { name: 'Account options' }).click();
  const menuLink = page.getByRole('link', { name: 'Add Vybatron to a server' });
  for (const [name, value] of Object.entries({ href: INVITE_URL, ...external })) await expect(menuLink).toHaveAttribute(name, value);
  await page.keyboard.press('Escape');
  await openSettings(page);
  await expect(page.getByRole('link', { name: 'Add to server' })).toHaveAttribute('href', INVITE_URL);
});

test('a listener with no shared servers is offered an install instead of a dead end', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.bootstrap.guilds = [];
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'No listening spaces available' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add to a server' })).toHaveAttribute('href', INVITE_URL);
  await expect(page.getByRole('button', { name: 'Refresh access' })).toBeVisible();
});

test('without an install link the portal hides every add-to-server entry', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.bootstrap.inviteUrl = null;
  await gotoSession(page);
  await page.getByRole('button', { name: 'Account options' }).click();
  await expect(page.getByRole('link', { name: /Add .*server/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openSettings(page);
  await expect(page.getByRole('link', { name: /Add .*server/ })).toHaveCount(0);
});
