import { test, expect } from './test';
import AxeBuilder from '@axe-core/playwright';
import { mockPortal } from './fixtures';

test('voice context and an accessible main landmark remain available in the expanded phone player', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page, { outsideVoice: true });
  fixture.state.snapshot.session.textChannel = { id: 'text', name: 'music-commands' };
  await page.goto('/');
  await expect(page.locator('.guild-status')).toContainText('General');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  // Opening the player focuses its heading once the transition settles; skip-link checks come after.
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
  await expect(page.getByTestId('player').getByRole('heading', { level: 2 })).toBeFocused();
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('region', { name: 'Music player' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main').getByText('Join General to add music or use playback controls.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
  await page.getByRole('link', { name: 'Skip to content' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  expect(fixture.commands).toEqual([]);
});

test('basic members get personal preferences without requesting the admin catalog', async ({ page }) => {
  const fixture = await mockPortal(page, { basic: true }); await page.goto('/');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Preferences', exact: true })).toBeVisible();
  await expect(page.getByLabel('Ambient motion')).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  await expect(page.locator('#music-channel')).toHaveCount(0);
  expect(fixture.requests.filter(url => url.endsWith('/configuration'))).toEqual([]);
  await page.getByRole('tab', { name: 'Advanced controls' }).click();
  await expect(page.getByLabel('Command', { exact: true })).toBeVisible();
});

test('server settings drafts survive navigation and opening the artwork player', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Default volume', { exact: true }).fill('42');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.getByRole('button', { name: 'Close player', exact: true }).click();
  await expect(page.getByLabel('Default volume', { exact: true })).toHaveValue('42');
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await expect(page.getByLabel('Default volume', { exact: true })).toHaveValue('42');
  expect(fixture.commands).toEqual([]);
});

test('a player first mounted in a hidden tab resumes its elapsed display when visible', async ({ page }) => {
  await page.addInitScript(() => {
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    (window as unknown as { revealPlayer: () => void }).revealPlayer = () => { hidden = false; document.dispatchEvent(new Event('visibilitychange')); };
  });
  const fixture = await mockPortal(page); await page.goto('/');
  const position = page.getByRole('slider', { name: 'Playback position' });
  await expect(position).toBeEnabled();
  await expect(position).toHaveValue('107000');
  await page.evaluate(() => (window as unknown as { revealPlayer: () => void }).revealPlayer());
  await expect.poll(async () => Number(await position.inputValue())).toBeGreaterThan(107000);
  expect(fixture.commands).toEqual([]);
});
