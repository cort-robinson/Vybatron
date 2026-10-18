import { expect, test, type Page } from '@playwright/test';
import { mockPortal } from './fixtures';
import type { GuildSnapshot } from '../src/types';

const emit = (page: Page, data: GuildSnapshot) => page.evaluate(snapshot => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(snapshot), data);

async function openLyrics(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
  const toggle = page.getByRole('button', { name: 'Show lyrics', exact: true });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Hide lyrics', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

test('synced lyrics replace the cover and follow the playback position', async ({ page }) => {
  const fixture = await mockPortal(page);
  // Paused keeps the position still, so the sung line is exact.
  fixture.state.snapshot.session.status = 'paused';
  await openLyrics(page);
  const panel = page.getByRole('region', { name: 'Lyrics' });
  await expect(panel).toBeVisible();
  await expect(page.locator('.sleeve-artwork > .artwork')).toHaveCount(0);
  await expect(panel.locator('[aria-current="true"]')).toHaveText('We keep the evening light between us two');
  await expect(panel.getByText('Lyrics from LRCLIB')).toBeVisible();

  const state = fixture.state.snapshot;
  state.session.positionMs = 115_000; state.revision = 'later';
  await emit(page, state);
  await expect(panel.locator('[aria-current="true"]')).toHaveText('Hold on, the night is almost through');
  await expect(panel.locator('li.past')).toHaveCount(3);

  // Closing the player puts the cover back for next time.
  await page.getByRole('button', { name: 'Close player', exact: true }).last().click();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show lyrics', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sleeve-artwork > .artwork')).toHaveCount(1);
});

test('lyrics show plain text, a clear no-lyrics state and a retry when unavailable', async ({ page }) => {
  const fixture = await mockPortal(page);
  const found = fixture.state.lyrics;
  fixture.state.lyrics = { trackId: found.trackId, status: 'unavailable', lyrics: null };
  await openLyrics(page);
  await expect(page.getByText('Lyrics are unavailable right now.')).toBeVisible();

  fixture.state.lyrics = { ...found, lyrics: { ...found.lyrics!, synced: false, lines: found.lyrics!.lines.map(line => ({ ...line, startMs: null })) } };
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Lyrics' });
  await expect(panel.getByText('Streetlights hum along the avenue')).toBeVisible();
  await expect(panel.locator('[aria-current]')).toHaveCount(0);
  await expect(panel.getByText('Lyrics from LRCLIB · not synced to playback')).toBeVisible();

  // A new song asks again; nothing found is said plainly.
  const state = fixture.state.snapshot;
  state.session.current = { ...state.session.current!, id: 'b'.repeat(24), title: 'Instrumental' };
  state.revision = 'instrumental';
  fixture.state.lyrics = { trackId: 'b'.repeat(24), status: 'not_found', lyrics: null };
  await emit(page, state);
  await expect(page.getByText('No lyrics found for this song.')).toBeVisible();
});

test('long lyrics open scrolled to the sung line', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.status = 'paused';
  fixture.state.lyrics.lyrics!.lines = Array.from({ length: 80 }, (_, index) => ({ startMs: index * 2000, text: `Line ${index + 1}` }));
  await openLyrics(page);
  const panel = page.getByRole('region', { name: 'Lyrics' });
  const current = panel.locator('[aria-current="true"]');
  await expect(current).toHaveText('Line 54');
  // Settle any smooth scroll, then the sung line must sit inside the panel.
  await page.waitForTimeout(800);
  await expect(current).toBeInViewport();
  expect(await panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
});

for (const skin of ['overdrive', 'fantastic', 'classic'] as const) {
  for (const width of [390, 1280]) {
    test(`${skin} lyrics panel fits the open player at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 600 ? 844 : 800 });
      await page.addInitScript(look => localStorage.setItem('vybertron.skin', look), skin);
      await mockPortal(page);
      await openLyrics(page);
      const panel = page.getByRole('region', { name: 'Lyrics' });
      const box = (await panel.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.height).toBeGreaterThan(100);
      // The transport stays clear of the panel.
      const play = (await page.getByRole('button', { name: 'Pause playback' }).boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(play.y + 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const toggle = (await page.getByRole('button', { name: 'Hide lyrics', exact: true }).boundingBox())!;
      expect(toggle.width).toBeGreaterThanOrEqual(44);
      expect(toggle.height).toBeGreaterThanOrEqual(44);
    });
  }
}

test('reduced motion keeps the sung line still: no color fade and an instant scroll', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockPortal(page);
  await openLyrics(page);
  const line = page.getByRole('region', { name: 'Lyrics' }).locator('[aria-current="true"]');
  await expect(line).toBeVisible();
  expect(await line.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
});
