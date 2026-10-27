import { expect, test, type Page } from './test';
import { mockPortal } from './fixtures';
import type { GuildSnapshot } from '../src/types';

const emit = (page: Page, data: GuildSnapshot) => page.evaluate(snapshot => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(snapshot), data);
const chunk = /\/assets\/Visualizer-[\w-]+\.js$/;

async function openPlayer(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
}
const fullScreen = (page: Page) => page.getByRole('dialog', { name: 'Visualizer' });

// Counts each visualizer canvas's drawn frames (draws to its screen, not to Neon's buffers).
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const record = window as unknown as { visualFrames: Record<string, number> }; record.visualFrames = { sleeve: 0, full: 0, gone: 0 };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (this: WebGL2RenderingContext, ...args: Parameters<typeof draw>) {
      const canvas = this.canvas as HTMLCanvasElement;
      if (!this.getParameter(this.FRAMEBUFFER_BINDING) && !canvas.classList.contains('scene-canvas')) {
        const where = !canvas.isConnected ? 'gone' : canvas.closest('.sleeve-visualizer') ? 'sleeve' : canvas.closest('.visualizer-stage') ? 'full' : 'gone';
        record.visualFrames[where]++;
      }
      return draw.apply(this, args);
    };
  });
}
const framesOver = (page: Page, ms: number) => page.evaluate(async ms => {
  const { visualFrames } = window as unknown as { visualFrames: Record<string, number> };
  const start = { ...visualFrames }; await new Promise(resolve => setTimeout(resolve, ms));
  return { sleeve: visualFrames.sleeve - start.sleeve, full: visualFrames.full - start.full, gone: visualFrames.gone - start.gone };
}, ms);

test('the sleeve swaps its cover for a visualizer, whose code loads only then', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requested: string[] = []; page.on('request', request => requested.push(new URL(request.url()).pathname));
  await mockPortal(page);
  await openPlayer(page);
  expect(requested.filter(path => chunk.test(path) || /visualizer-[\w-]+\.css$/.test(path))).toEqual([]);

  const toggle = page.getByRole('button', { name: 'Show visualizer', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Hide visualizer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const visual = page.locator('.sleeve-artwork > .sleeve-visualizer');
  await expect(visual).toHaveAttribute('aria-hidden', 'true');
  await expect(visual.locator('canvas[data-drawn]')).toHaveCount(1);
  await expect(page.locator('.sleeve-artwork > img.artwork')).toHaveCount(0);
  expect(requested.some(path => chunk.test(path))).toBe(true);
  expect(requested.some(path => /visualizer-[\w-]+\.css$/.test(path))).toBe(true);
  // It takes the cover's box exactly, so the layout around it doesn't move.
  const box = await visual.boundingBox();
  await page.getByRole('button', { name: 'Hide visualizer', exact: true }).click();
  await expect(page.locator('.sleeve-artwork > img.artwork')).toHaveCount(1);
  expect(await page.locator('.sleeve-artwork > img.artwork').boundingBox()).toEqual(box);

  // Lyrics and the visualizer take turns in the sleeve.
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Show lyrics', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Lyrics' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide lyrics', exact: true }).click();
  await expect(page.locator('.sleeve-artwork > img.artwork')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('full screen opens from the sleeve and the menu, and closes with its button, Escape and Back', async ({ page }) => {
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  const opener = page.getByRole('button', { name: 'Full-screen visualizer', exact: true });
  await opener.click();
  const dialog = fullScreen(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
  await expect(dialog.getByText('Glass Avenue')).toBeVisible();
  await expect(dialog.locator('.visualizer-time')).toContainText('of 3:57');
  await expect(dialog.locator('.visualizer-source')).toHaveText(/^Ambient/);
  await expect(dialog.locator('.visualizer-stage')).toHaveAttribute('aria-hidden', 'true');
  await expect(dialog.locator('canvas[data-drawn]')).toHaveCount(1);
  await expect(dialog.getByRole('group', { name: 'Visualizer' }).getByRole('radio')).toHaveCount(4);
  await dialog.getByRole('button', { name: 'Close visualizer' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  // From the player's menu; Escape closes it and leaves the player open.
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).last().click();
  await expect(fullScreen(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fullScreen(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();

  // Back closes the full screen first, then the player.
  await opener.click();
  await expect(fullScreen(page)).toBeVisible();
  await page.goBack();
  await expect(fullScreen(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Evening Light' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: 'Open player', exact: true })).toBeVisible();
});

test('presets follow the look until one is chosen, and the choice is remembered', async ({ page }) => {
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page);
  await expect(dialog.getByRole('radio', { name: 'Gridrunner' })).toBeChecked();
  // Every preset compiles and draws; a failed program would swap in the spectrum fallback.
  for (const name of ['Neon', 'Cosmic Broadcast', 'Receiver', 'Neon']) {
    await dialog.getByRole('radio', { name }).check();
    await expect(dialog.getByRole('radio', { name })).toBeChecked();
    await page.waitForTimeout(150);
    await expect(dialog.locator('.visualizer-fallback')).toHaveCount(0);
  }
  expect(await page.evaluate(() => localStorage.getItem('vybertron.visualizer'))).toBe('neon');
  // Arrow keys move through the group.
  await dialog.getByRole('radio', { name: 'Neon' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Gridrunner' })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('radio', { name: 'Neon' })).toBeChecked();

  await page.evaluate(() => localStorage.setItem('vybertron.skin', 'classic'));
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).getByRole('radio', { name: 'Neon' })).toBeChecked();
  await page.evaluate(() => localStorage.removeItem('vybertron.visualizer'));
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).getByRole('radio', { name: 'Receiver' })).toBeChecked();
});

test('the full screen overlay rests without input and returns on a key', async ({ page }) => {
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page);
  await expect(dialog).not.toHaveClass(/resting/);
  await expect(dialog).toHaveClass(/resting/, { timeout: 6000 });
  await page.keyboard.press('Shift');
  await expect(dialog).not.toHaveClass(/resting/);
});

test('visualizers draw at no more than 30fps, only while seen, and stop once paused', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await countFrames(page);
  const fixture = await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await expect(page.locator('.sleeve-visualizer canvas[data-drawn]')).toHaveCount(1);
  const playing = await framesOver(page, 2000);
  expect(playing.sleeve).toBeGreaterThan(10);
  expect(playing.sleeve).toBeLessThanOrEqual(66);

  // Full screen covers the sleeve: only the full screen draws, and closing it stops it.
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).locator('canvas[data-drawn]')).toHaveCount(1);
  await page.waitForTimeout(200);
  const covered = await framesOver(page, 1000);
  expect(covered.sleeve).toBe(0);
  expect(covered.full).toBeGreaterThan(5);
  expect(covered.full).toBeLessThanOrEqual(33);
  await page.keyboard.press('Escape');
  await expect(fullScreen(page)).toHaveCount(0);
  const closed = await framesOver(page, 600);
  expect(closed.full + closed.gone).toBe(0);
  expect(closed.sleeve).toBeGreaterThan(0);

  // Paused, it eases into standby and then stops drawing.
  const state = fixture.state.snapshot; state.session.status = 'paused'; state.revision = 'paused';
  await emit(page, state);
  await expect.poll(async () => (await framesOver(page, 500)).sleeve, { timeout: 10_000 }).toBe(0);
  // A hidden sleeve (the cover back in place) leaves nothing drawing.
  state.session.status = 'playing'; state.revision = 'playing-again'; await emit(page, state);
  await expect.poll(async () => (await framesOver(page, 300)).sleeve).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Hide visualizer', exact: true }).click();
  const hidden = await framesOver(page, 500);
  expect(hidden.sleeve + hidden.gone).toBe(0);
});

test('reduced motion shows one composed frame instead of a loop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await countFrames(page);
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await expect(page.locator('.sleeve-visualizer canvas[data-drawn]')).toHaveCount(1);
  await page.waitForTimeout(200);
  expect((await framesOver(page, 800)).sleeve).toBe(0);
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).locator('canvas[data-drawn]')).toHaveCount(1);
  await page.waitForTimeout(200);
  expect((await framesOver(page, 800)).full).toBe(0);
});

test('without WebGL2 the sleeve keeps its cover and full screen falls back to the spectrum', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof original;
  });
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await expect(page.getByText('The visualizer isn’t available on this device.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show visualizer', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sleeve-artwork > img.artwork')).toHaveCount(1);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).locator('canvas.spectrum.visualizer-fallback')).toHaveCount(1);
  await expect(fullScreen(page).getByRole('heading', { name: 'Evening Light' })).toBeVisible();
});

test.describe('on a high-density screen', () => {
  test.use({ deviceScaleFactor: 2 });
  test('the full screen fallback spectrum keeps its size', async ({ page }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        return type === 'webgl2' ? null : (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
      } as typeof original;
    });
    await mockPortal(page);
    await openPlayer(page);
    await page.getByRole('button', { name: 'More playback controls' }).click();
    await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
    const fallback = fullScreen(page).locator('canvas.visualizer-fallback');
    await expect(fallback).toHaveCount(1);
    const size = () => fallback.evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.clientWidth]);
    const first = await size(); await page.waitForTimeout(500);
    expect(await size()).toEqual(first);
    expect(first[1]).toBeLessThanOrEqual(page.viewportSize()!.width);
  });
});
