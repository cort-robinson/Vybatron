import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mockPortal, streamAction } from './fixtures';

test('capture approved desktop and phone states with interaction and console evidence', async ({ browser }) => {
  test.setTimeout(90_000);
  const directory = new URL('../.impeccable/review/', import.meta.url); await mkdir(directory, { recursive: true });
  const evidence: unknown[] = [];
  for (const { name, width, height, density } of [{ name: 'desktop', width: 1488, height: 1056, density: 1 }, { name: 'mobile', width: 426, height: 928, density: 2 }, { name: 'phone-small', width: 393, height: 852, density: 1 }, { name: 'tablet', width: 820, height: 1180, density: 1 }]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: density, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await mockPortal(page); await page.goto('http://127.0.0.1:4178/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).filter(image => image.getBoundingClientRect().width > 0).map(image => { image.loading = 'eager'; return image.decode().catch(() => {}); })); });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-queue.png`, directory)) });
    if (name === 'desktop') await page.screenshot({ path: fileURLToPath(new URL('hero-repro.png', directory)) });
    await page.getByRole('button', { name: 'Open player', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).filter(image => image.getBoundingClientRect().width > 0).map(image => { image.loading = 'eager'; return image.decode().catch(() => {}); })); });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, directory)) });
    const playerOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    evidence.push({ name, width, height, density, errors, playerOverflow, violations: accessibility.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.html) })) });
    await page.getByRole('button', { name: 'Session', exact: true }).click();
    if (name === 'desktop') {
      await page.getByRole('button', { name: 'Add music', exact: true }).click(); await page.getByRole('searchbox', { name: 'Music search' }).fill('Midnight City'); await page.getByRole('button', { name: 'Search', exact: true }).click(); await expect(page.getByText('Midnight City', { exact: true })).toBeVisible();
      await page.screenshot({ path: fileURLToPath(new URL('search.png', directory)) });
      await page.getByRole('button', { name: 'Close dialog' }).click(); await streamAction(page, 'disconnect');
      await page.screenshot({ path: fileURLToPath(new URL('disconnected.png', directory)) });
    }
    await context.close();
  }
  await writeFile(new URL('browser-evidence.json', directory), JSON.stringify(evidence, null, 2));
  for (const item of evidence as { errors: string[]; playerOverflow: boolean; violations: unknown[] }[]) { expect(item.errors).toEqual([]); expect(item.playerOverflow).toBe(false); expect(item.violations).toEqual([]); }
});
