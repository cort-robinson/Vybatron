import { test, expect } from './test';
import { mockPortal } from './fixtures';

// The fixture defaults to the CSS scenery; these specs run the canvas.
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { if (!sessionStorage.getItem('scene-seeded')) { localStorage.setItem('vybertron.scene', 'gl'); sessionStorage.setItem('scene-seeded', '1'); } }); });

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

for (const skin of ['fantastic', 'classic']) {
  test(`the ${skin} look draws its room in the canvas too`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('vybertron.skin', value), skin);
    await mockPortal(page); await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(page.locator('.ambient-scene.gl-scene .scene-canvas')).toHaveCount(1);
    if (skin === 'fantastic') await expect(page.locator('.ff-burst').first()).toHaveCSS('animation-name', 'none');
    expect(errors).toEqual([]);
  });
}

test('panes over the room take their frosted glass from the canvas, and keep backdrop-filter without it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPortal(page); await page.goto('/');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const queue = page.locator('.sleeve-queue');
  await expect(queue).toHaveCSS('backdrop-filter', 'none');
  expect(await queue.evaluate(element => getComputedStyle(element).getPropertyValue('--glass'))).toContain('blur(28px)');
  // The compact deck has page content scrolling under it, so it keeps its own blur.
  await page.goto('/?scene=css');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.locator('.sleeve-queue')).toHaveCSS('backdrop-filter', /blur/);
});
