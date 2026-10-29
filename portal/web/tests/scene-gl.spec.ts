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

for (const skin of ['fantastic', 'haunted', 'classic']) {
  test(`the ${skin} look draws its room in the canvas too`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(value => localStorage.setItem('vybertron.skin', value), skin);
    await mockPortal(page); await page.goto('/');
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(page.locator('.ambient-scene.gl-scene .scene-canvas')).toHaveCount(1);
    if (skin === 'fantastic') await expect(page.locator('.ff-burst').first()).toHaveCSS('animation-name', 'none');
    if (skin === 'haunted') await expect(page.locator('.hh-lantern').first()).toHaveCSS('animation-name', 'none');
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

// Counts the room's frames and every style read the page makes (the room used to read a dozen per frame).
async function countRoom(page: import('./test').Page) {
  await page.addInitScript(() => {
    const record = window as unknown as { room: { frames: number; styles: number } }; record.room = { frames: 0, styles: 0 };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (this: WebGL2RenderingContext, ...args: Parameters<typeof draw>) {
      if (!this.getParameter(this.FRAMEBUFFER_BINDING) && !this.isEnabled(this.SCISSOR_TEST)) record.room.frames++;
      return draw.apply(this, args);
    };
    const style = window.getComputedStyle;
    window.getComputedStyle = function (...args: Parameters<typeof style>) { record.room.styles++; return style.apply(window, args); };
  });
}
const roomOver = (page: import('./test').Page, ms: number) => page.evaluate(async ms => {
  const { room } = window as unknown as { room: { frames: number; styles: number } };
  const start = { ...room }; await new Promise(resolve => setTimeout(resolve, ms));
  return { frames: room.frames - start.frames, styles: room.styles - start.styles };
}, ms);

test('the playing room draws its ambient motion at no more than 30fps without reading styles each frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await countRoom(page);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.ambient-scene.moving .scene-canvas')).toHaveCount(1);
  // The cover's palette arrives just after the session; let its relight and the power-on finish, so
  // only the canvas clock moves the room.
  await page.waitForTimeout(1500);
  await expect.poll(() => page.locator('.ambient-scene').evaluate(scene => scene.getAnimations({ subtree: true })
    .filter(animation => animation.playState === 'running' || animation.pending).length), { timeout: 10_000 }).toBe(0);
  await expect(page.locator('.room-colors')).toHaveCount(1);
  await page.waitForTimeout(300);
  const { frames, styles } = await roomOver(page, 2000);
  expect(frames).toBeGreaterThan(0);
  expect(frames).toBeLessThanOrEqual(66);
  // The room used to read a dozen styles per frame; now only a page change (a pane check) reads any.
  expect(styles).toBeLessThanOrEqual(frames + 10);
});

test('a modal dialog holds the room and the spectrum still under its backdrop, and they resume when it closes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await countRoom(page);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.ambient-scene.moving .scene-canvas')).toHaveCount(1);
  await expect.poll(async () => (await roomOver(page, 300)).frames).toBeGreaterThan(0);
  const spectrum = page.locator('canvas.player-spectrum');
  const spectrumImage = () => spectrum.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());

  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(async () => (await roomOver(page, 400)).frames).toBe(0);
  const held = await spectrumImage();
  await page.waitForTimeout(300);
  expect(await spectrumImage()).toBe(held);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect.poll(async () => (await roomOver(page, 300)).frames).toBeGreaterThan(0);
  await expect.poll(spectrumImage).not.toBe(held);
});
