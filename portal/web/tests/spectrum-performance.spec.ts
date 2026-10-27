import { expect, test, type Locator, type Page } from './test';
import { mockPortal, openSettings } from './fixtures';

type SpectrumCounters = { spectrumDrawCounts: WeakMap<HTMLCanvasElement, number>; blurredDraws: number };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const counts = new WeakMap<HTMLCanvasElement, number>();
    const counters = window as unknown as SpectrumCounters;
    counters.spectrumDrawCounts = counts; counters.blurredDraws = 0;
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, width, height) {
      // Cover-palette extraction also uses canvas: count only the visible UI's spectra.
      if (this.canvas instanceof HTMLCanvasElement && this.canvas.matches('canvas.spectrum')) counts.set(this.canvas, (counts.get(this.canvas) || 0) + 1);
      return clear.call(this, x, y, width, height);
    };
    // Any canvas drawing that has to blur (a shadow or a filter), wherever it draws.
    for (const name of ['fill', 'fillRect', 'drawImage'] as const) {
      const draw = CanvasRenderingContext2D.prototype[name] as (...args: unknown[]) => void;
      (CanvasRenderingContext2D.prototype[name] as (...args: unknown[]) => void) = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
        if (this.shadowBlur > 0 || this.filter !== 'none') counters.blurredDraws++;
        return draw.apply(this, args);
      };
    }
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
});

const draws = (canvas: Locator) => canvas.evaluate(element => (window as unknown as SpectrumCounters).spectrumDrawCounts.get(element as HTMLCanvasElement) || 0);

async function expectMoving(canvas: Locator) {
  const before = await draws(canvas);
  await expect.poll(() => draws(canvas)).toBeGreaterThan(before);
}

async function expectStill(page: Page, canvas: Locator) {
  // Give ResizeObserver/IntersectionObserver and any queued frame time to react.
  // Static preferences may first finish the current cover-color transition.
  let previous = -1;
  await expect.poll(async () => {
    const count = await draws(canvas); const stopped = count === previous; previous = count; return stopped;
  }, { intervals: [150] }).toBe(true);
  const before = await draws(canvas);
  await page.waitForTimeout(220);
  expect(await draws(canvas)).toBe(before);
}

async function openPortal(page: Page, height = 844) {
  await page.setViewportSize({ width: 390, height });
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback', exact: true })).toBeEnabled();
}

test('a spectrum suspends drawing when concealed or offscreen and resumes when revealed', async ({ page }) => {
  await openPortal(page);
  const canvas = page.locator('canvas.player-spectrum');
  await expectMoving(canvas);
  await expect(canvas).toHaveAttribute('aria-hidden', 'true');

  await canvas.evaluate(element => { (element as HTMLElement).style.display = 'none'; });
  await expect(canvas).toBeHidden();
  await expectStill(page, canvas);
  await canvas.evaluate(element => { (element as HTMLElement).style.removeProperty('display'); });
  await expect(canvas).toBeVisible();
  await expectMoving(canvas);

  await canvas.evaluate(element => { (element as HTMLElement).style.height = '0px'; });
  await expect.poll(() => canvas.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await expectStill(page, canvas);
  await canvas.evaluate(element => { (element as HTMLElement).style.removeProperty('height'); });
  await expect(canvas).toBeVisible();
  await expectMoving(canvas);

  await canvas.evaluate(element => { (element as HTMLElement).style.transform = 'translateX(-200vw)'; });
  await expect.poll(() => canvas.evaluate(element => element.getBoundingClientRect().right)).toBeLessThan(0);
  await expectStill(page, canvas);
  await canvas.evaluate(element => { (element as HTMLElement).style.removeProperty('transform'); });
  await expectMoving(canvas);
});

test('a playing spectrum keeps its glow without blurring on every draw', async ({ page }) => {
  await openPortal(page);
  const canvas = page.locator('canvas.player-spectrum');
  await expectMoving(canvas);
  const blurred = () => page.evaluate(() => (window as unknown as SpectrumCounters).blurredDraws);
  const before = { blurred: await blurred(), draws: await draws(canvas) };
  await expect.poll(() => draws(canvas)).toBeGreaterThan(before.draws + 10);
  expect(await blurred()).toBe(before.blurred);

  // The glow still spills into the gap between the first two columns at the always-lit bottom row
  // (the deck draws no ghost segments, so only glow can be there).
  const gapAlpha = await canvas.evaluate(element => {
    const surface = element as HTMLCanvasElement; const scale = surface.width / surface.clientWidth;
    const x = Math.round(surface.clientWidth / 56 * scale); const y = Math.round((surface.clientHeight - 1.5) * scale);
    return surface.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
  });
  expect(gapAlpha).toBeGreaterThan(12);
});

test('the short-phone sleeve stays idle until its spectrum has room and stops again when resized', async ({ page }) => {
  await openPortal(page, 667);
  await expectMoving(page.locator('canvas.player-spectrum'));
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const sleeve = page.locator('canvas.sleeve-spectrum');
  await expect(sleeve).toHaveCount(1);
  await expect(sleeve).toBeHidden();
  expect(await sleeve.evaluate(element => element.getBoundingClientRect().height)).toBe(0);
  await expectStill(page, sleeve);
  expect(await draws(sleeve)).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sleeve).toBeVisible();
  await expectMoving(sleeve);
  await page.setViewportSize({ width: 390, height: 667 });
  await expect(sleeve).toBeHidden();
  await expectStill(page, sleeve);

  await page.getByRole('button', { name: 'Close player', exact: true }).first().click();
  await expectMoving(page.locator('canvas.player-spectrum'));
});

for (const preference of ['ambient off', 'reduced motion'] as const) {
  test(`${preference} leaves a still spectrum while playback continues, and motion can resume`, async ({ page }) => {
    await openPortal(page);
    const canvas = page.locator('canvas.player-spectrum');
    await expectMoving(canvas);
    if (preference === 'ambient off') {
      await openSettings(page);
      await page.getByLabel('Ambient motion', { exact: true }).selectOption('off');
    } else await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect(canvas).toBeVisible();
    await expectStill(page, canvas);
    expect(await draws(canvas)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Pause playback', exact: true })).toBeEnabled();

    if (preference === 'ambient off') await page.getByLabel('Ambient motion', { exact: true }).selectOption('on');
    else await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectMoving(canvas);
  });
}
