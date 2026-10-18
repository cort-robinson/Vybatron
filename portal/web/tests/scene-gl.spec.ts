import { test, expect } from '@playwright/test';
import { mockPortal } from './fixtures';

test('Overdrive draws its room in one canvas and keeps the DOM scenery as an unpainted layout source', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.ambient-scene.gl-scene .scene-canvas')).toHaveCount(1);
  await expect(page.locator('.od-horizon').first()).toBeAttached();
  await expect(page.locator('.room-colors').first()).toHaveCSS('visibility', 'hidden');
  // The canvas clock replaces the endless CSS animations, so none of them run behind it.
  await expect(page.locator('.ambient-scene.moving')).toHaveCount(1);
  await expect(page.locator('.od-plane').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.light').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.od-sun').first()).toHaveCSS('mix-blend-mode', 'normal');
});

test('without WebGL2 the room falls back to the CSS scenery', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return type === 'webgl2' ? null : (original as (...args: unknown[]) => RenderingContext | null).call(this, type, ...rest);
    } as typeof original;
  });
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.scene-canvas')).toHaveCount(0);
  await expect(page.locator('.ambient-scene')).not.toHaveClass(/gl-scene/);
  await expect(page.locator('.room-colors').first()).toHaveCSS('visibility', 'visible');
  await expect(page.locator('.od-plane').first()).toHaveCSS('animation-name', 'od-roll');
});

test('?scene=css chooses the CSS scenery and is remembered on this device', async ({ page }) => {
  await mockPortal(page); await page.goto('/?scene=css');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.od-horizon').first()).toBeAttached();
  await expect(page.locator('.scene-canvas')).toHaveCount(0);
  await page.goto('/');
  await expect(page.locator('.od-horizon').first()).toBeAttached();
  await expect(page.locator('.scene-canvas')).toHaveCount(0);
  await page.goto('/?scene=gl');
  await expect(page.locator('.scene-canvas')).toHaveCount(1);
});

test('other looks keep their own scenery', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('vybertron.skin', 'classic'));
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.scene-canvas')).toHaveCount(0);
  await expect(page.locator('.ambient-scene')).not.toHaveClass(/gl-scene/);
});
