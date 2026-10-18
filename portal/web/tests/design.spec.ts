import { test, expect, cssScene } from './test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mockPortal, streamAction } from './fixtures';

const viewports = [{ name: 'desktop', width: 1488, height: 1056, density: 1 }, { name: 'mobile', width: 426, height: 928, density: 2 }, { name: 'phone-small', width: 393, height: 852, density: 1 }, { name: 'tablet', width: 820, height: 1180, density: 1 }];
const settle = () => document.fonts.ready.then(() => Promise.all(Array.from(document.images).filter(image => image.getBoundingClientRect().width > 0).map(image => { image.loading = 'eager'; return image.decode().catch(() => {}); })));

for (const { name, width, height, density } of viewports) {
  test(`capture approved ${name} states with interaction and console evidence`, async ({ browser }) => {
    const directory = new URL('../.impeccable/review/', import.meta.url); await mkdir(directory, { recursive: true });
    const shot = (file: string) => page.screenshot({ path: fileURLToPath(new URL(file, directory)) });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: density, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(cssScene);
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await mockPortal(page); await page.goto(String(test.info().project.use.baseURL));
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.evaluate(settle);
    await shot(`${name}-queue.png`);
    if (name === 'desktop') await shot('hero-repro.png');
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
    await page.evaluate(settle);
    await shot(`${name}.png`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.html) }))).toEqual([]);
    // Below 1024px the open player is full screen; the tabs return when it closes.
    if (name !== 'desktop') await page.getByRole('button', { name: 'Close player', exact: true }).first().click();
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    if (name === 'desktop') {
      await page.getByRole('button', { name: 'Add music', exact: true }).click(); await page.getByRole('searchbox', { name: 'Music search' }).fill('Midnight City'); await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(page.getByRole('dialog').getByText('Midnight City', { exact: true })).toBeVisible();
      await shot('search.png');
      await page.getByRole('button', { name: 'Close dialog' }).click(); await streamAction(page, 'disconnect');
      await shot('disconnected.png');
    }
    expect(errors).toEqual([]);
    await context.close();
  });
}
