import { expect, test } from './test';
import { mockPortal, openSettings } from './fixtures';

test('the loading line shows while the script downloads and leaves the moment a look applies', async ({ page }) => {
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/assets\/index-[\w-]{8}\.js$/, async route => { await held; await route.continue(); });
  await mockPortal(page);
  await page.goto('/', { waitUntil: 'commit' });
  const shell = page.locator('.boot-shell');
  await expect(shell).toBeVisible();
  await expect(shell).toHaveText('Finding your listening space…');
  // React never adopts it: #root stays empty until the app renders.
  expect(await page.locator('#root').evaluate(root => root.childElementCount)).toBe(0);
  release();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(shell).toBeHidden();
});

test('the first screen preloads its text font and fetches the Server and Settings pages once idle', async ({ page }) => {
  const html = await (await page.request.get('/')).text();
  const font = /<link rel="preload" href="(\/assets\/archivo-latin-wdth-normal-[\w-]{8}\.woff2)" as="font" type="font\/woff2" crossorigin="">/.exec(html)?.[1];
  expect(font).toBeTruthy();
  expect((await page.request.get(font!)).headers()['content-type']).toBe('font/woff2');
  const pages = page.waitForRequest(/\/assets\/pages-[\w-]{8}\.js$/);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await pages;
  await openSettings(page);
});

test('a Server and Settings chunk that fails to load shows an error there, and trying again reloads the portal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const chunk = /\/assets\/pages-[\w-]{8}\.js$/;
  await page.route(chunk, route => route.abort());
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This page couldn’t load');
  // The rest of the portal keeps working.
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.unroute(chunk);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await openSettings(page);
});
