import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from './test';
import { mockPortal } from './fixtures';
import type { GuildSnapshot } from '../src/types';

const emit = (page: Page, data: GuildSnapshot) => page.evaluate(snapshot => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(snapshot), data);
const chunk = /\/assets\/Visualizer-[\w-]+\.js$/;
const milkdropChunk = /\/assets\/milkdrop-[\w-]+\.js$/;

async function openPlayer(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.motion);
}
const fullScreen = (page: Page) => page.getByRole('dialog', { name: 'Visualizer' });
// A preset chosen before the page loads, as a returning visitor's would be.
const stored = (page: Page, preset: string) => page.addInitScript(value => localStorage.setItem('vybertron.visualizer', value), preset);
// The share of a 2D canvas's pixels that are lit: MilkDrop draws a picture, not a blank.
const lit = (canvas: Locator) => canvas.evaluate((element: HTMLCanvasElement) => {
  const { data } = element.getContext('2d')!.getImageData(0, 0, element.width, element.height); let on = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 48) on++;
  return on / (data.length / 4);
});
// MilkDrop compiles each preset as it loads, which takes a while on the tests' software GPU.
const slowly = { timeout: 15_000 };
// Neither the page's canvases nor Butterchurn's own offscreen one get a WebGL2 context.
const withoutWebGL2 = (page: Page) => page.addInitScript(() => {
  for (const type of [HTMLCanvasElement, OffscreenCanvas]) {
    const original = type.prototype.getContext as (...args: unknown[]) => unknown;
    (type.prototype as { getContext: unknown }).getContext = function (this: unknown, kind: string, ...rest: unknown[]) { return kind === 'webgl2' ? null : original.call(this, kind, ...rest); };
  }
});

// Counts each visualizer canvas's drawn frames: the shader presets' draws to their screen, and
// MilkDrop's copies of its own WebGL2 frames to its canvas.
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const record = window as unknown as { visualFrames: Record<string, number> }; record.visualFrames = { sleeve: 0, full: 0, gone: 0 };
    const count = (canvas: HTMLCanvasElement) => { record.visualFrames[!canvas.isConnected ? 'gone' : canvas.closest('.sleeve-visualizer') ? 'sleeve' : canvas.closest('.visualizer-stage') ? 'full' : 'gone']++; };
    const draw = WebGL2RenderingContext.prototype.drawArrays;
    WebGL2RenderingContext.prototype.drawArrays = function (this: WebGL2RenderingContext, ...args: Parameters<typeof draw>) {
      const canvas = this.canvas;
      if (canvas instanceof HTMLCanvasElement && !this.getParameter(this.FRAMEBUFFER_BINDING) && !canvas.classList.contains('scene-canvas')) count(canvas);
      return draw.apply(this, args);
    };
    const copy = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (args[0] instanceof OffscreenCanvas && this.canvas instanceof HTMLCanvasElement) count(this.canvas);
      return (copy as (...args: unknown[]) => void).apply(this, args);
    } as typeof copy;
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
  // MilkDrop's own chunk waits until someone chooses it.
  expect(requested.filter(path => milkdropChunk.test(path))).toEqual([]);
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
  // A song that isn't a YouTube video has no energy map to ask for.
  expect(requested.filter(path => path.includes('/analysis/'))).toEqual([]);
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
  for (const name of ['MilkDrop', 'Cosmic Broadcast', 'Receiver', 'MilkDrop']) {
    await dialog.getByRole('radio', { name }).check();
    await expect(dialog.getByRole('radio', { name })).toBeChecked();
    await page.waitForTimeout(150);
    await expect(dialog.locator('.visualizer-fallback')).toHaveCount(0);
  }
  await expect(dialog.locator('canvas[data-drawn]')).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem('vybertron.visualizer'))).toBe('milkdrop');
  // Arrow keys move through the group.
  await dialog.getByRole('radio', { name: 'MilkDrop' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog.getByRole('radio', { name: 'Gridrunner' })).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.getByRole('radio', { name: 'MilkDrop' })).toBeChecked();

  await page.evaluate(() => localStorage.setItem('vybertron.skin', 'classic'));
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).getByRole('radio', { name: 'MilkDrop' })).toBeChecked();
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

for (const preset of ['gridrunner', 'milkdrop']) test(`without WebGL2 the sleeve keeps its cover and full screen falls back to the spectrum (${preset})`, async ({ page }) => {
  await withoutWebGL2(page); await stored(page, preset);
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

test('MilkDrop takes Neon’s place, and someone who chose Neon lands on it', async ({ page }) => {
  await stored(page, 'neon');
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page);
  await expect(dialog.locator('.visualizer-presets label')).toHaveText(['MilkDrop', 'Gridrunner', 'Cosmic Broadcast', 'Receiver']);
  await expect(dialog.getByRole('radio', { name: 'MilkDrop' })).toBeChecked();
  await expect(dialog.locator('canvas[data-drawn]')).toHaveCount(1, slowly);
  expect(await page.evaluate(() => localStorage.getItem('vybertron.visualizer'))).toBe('milkdrop');
});

test('MilkDrop loads its code when chosen, draws in the sleeve and full screen at no more than 30fps, and moves on to the next preset', async ({ page }) => {
  // Butterchurn's passes are slow on the software GPU tests run with: a smaller screen, and longer.
  test.slow();
  await page.setViewportSize({ width: 960, height: 600 });
  await countFrames(page); await stored(page, 'milkdrop');
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const requested: string[] = []; page.on('request', request => requested.push(new URL(request.url()).pathname));
  await mockPortal(page);
  await openPlayer(page);
  expect(requested.filter(path => milkdropChunk.test(path))).toEqual([]);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  const sleeve = page.locator('.sleeve-visualizer canvas[data-drawn]');
  await expect(sleeve).toHaveCount(1, slowly);
  expect(requested.some(path => milkdropChunk.test(path))).toBe(true);
  await expect.poll(() => lit(sleeve)).toBeGreaterThan(.05);
  const playing = await framesOver(page, 2000);
  expect(playing.sleeve).toBeGreaterThan(10);
  expect(playing.sleeve).toBeLessThanOrEqual(66);

  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page); const canvas = dialog.locator('canvas[data-drawn]');
  await expect(canvas).toHaveCount(1, slowly);
  await page.waitForTimeout(200);
  const covered = await framesOver(page, 1000);
  expect(covered.sleeve).toBe(0);
  // A software GPU shared with other tests manages only a few of these a second.
  expect(covered.full).toBeGreaterThan(1);
  expect(covered.full).toBeLessThanOrEqual(33);
  await expect.poll(() => lit(canvas)).toBeGreaterThan(.05);
  // The preset showing is named, and Next moves on to another.
  const name = dialog.locator('.visualizer-preset-name');
  await expect(name).not.toBeEmpty(slowly);
  const first = await name.getAttribute('title');
  await dialog.getByRole('button', { name: 'Next preset' }).click();
  await expect(name).not.toHaveAttribute('title', first!, slowly);
  await expect(dialog.locator('.visualizer-fallback')).toHaveCount(0);

  // A shader preset takes a canvas of its own, without MilkDrop's controls, and MilkDrop comes back.
  await dialog.getByRole('radio', { name: 'Receiver' }).check();
  await expect(dialog.locator('.visualizer-milkdrop')).toHaveCount(0);
  await expect(canvas).toHaveCount(1, slowly);
  await dialog.getByRole('radio', { name: 'MilkDrop' }).check();
  await expect(canvas).toHaveCount(1, slowly);
  await expect(name).not.toBeEmpty(slowly);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const closed = await framesOver(page, 600);
  expect(closed.full + closed.gone).toBe(0);
  expect(closed.sleeve).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('MilkDrop under reduced motion shows one composed frame instead of a loop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await countFrames(page); await stored(page, 'milkdrop');
  await mockPortal(page);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  const sleeve = page.locator('.sleeve-visualizer canvas[data-drawn]');
  await expect(sleeve).toHaveCount(1, slowly);
  await page.waitForTimeout(300);
  expect((await framesOver(page, 800)).sleeve).toBe(0);
  expect(await lit(sleeve)).toBeGreaterThan(.05);
});

// The portal server's own production policy (portal/server/src/security.js), served with the page.
const policy = readFileSync(new URL('../../server/src/security.js', import.meta.url), 'utf8').match(/'Content-Security-Policy', "([^"]+)"/)![1];
async function underPolicy(page: Page, csp: string) {
  await page.addInitScript(() => {
    const record = window as unknown as { violations: string[] }; record.violations = [];
    document.addEventListener('securitypolicyviolation', event => record.violations.push(`${event.effectiveDirective} ${event.blockedURI}`));
  });
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') { await route.fallback(); return; }
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
}
// The fixtures' avatars come from a plain-HTTP test server, which the policy rightly refuses;
// production artwork is HTTPS. Everything else counts.
const violations = (page: Page) => page.evaluate(() => (window as unknown as { violations: string[] }).violations.filter(violation => !/^img-src http:\/\/[^ ]+\/test-art\//.test(violation)));

test('MilkDrop runs under the production CSP without a violation, and needs only its WebAssembly allowance', async ({ page }) => {
  test.slow();
  expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval';");
  expect(policy).not.toContain("'unsafe-eval'");
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await stored(page, 'milkdrop');
  await mockPortal(page);
  await underPolicy(page, policy);
  await openPlayer(page);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page); const name = dialog.locator('.visualizer-preset-name');
  await expect(dialog.locator('canvas[data-drawn]')).toHaveCount(1, slowly);
  await expect(name).not.toBeEmpty(slowly);
  // Every curated preset the order reaches compiles: skip through a few.
  for (let i = 0; i < 4; i++) {
    const shown = await name.getAttribute('title');
    await dialog.getByRole('button', { name: 'Next preset' }).click();
    await expect(name).not.toHaveAttribute('title', shown!, slowly);
  }
  expect(await violations(page)).toEqual([]);
  expect(errors).toEqual([]);

  // Without it the equations can't compile, the browser reports why, and full screen falls back.
  const strict = await page.context().newPage();
  await stored(strict, 'milkdrop'); await mockPortal(strict); await underPolicy(strict, policy.replace(" 'wasm-unsafe-eval'", ''));
  await openPlayer(strict);
  await strict.getByRole('button', { name: 'More playback controls' }).click();
  await strict.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(strict).locator('canvas.visualizer-fallback')).toHaveCount(1, slowly);
  expect((await violations(strict)).some(violation => violation.startsWith('script-src') && violation.endsWith('wasm-eval'))).toBe(true);
});

test.describe('on a high-density screen', () => {
  test.use({ deviceScaleFactor: 2 });
  test('the full screen fallback spectrum keeps its size', async ({ page }) => {
    await withoutWebGL2(page);
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

// The current song as a YouTube video, so it has an energy map to fetch.
const VIDEO = 'dX3k_QDnzHE';
const onYouTube = (fixture: Awaited<ReturnType<typeof mockPortal>>) => { fixture.state.snapshot.session.current!.uri = `https://www.youtube.com/watch?v=${VIDEO}`; };
// A map whose low eight bands are full and high eight silent throughout, with a beat every half second.
function energyMap(durationMs = 237_000) {
  const frameCount = Math.ceil(durationMs * 30 / 1000); const levels = new Uint8Array(frameCount * 16);
  for (let i = 0; i < frameCount; i++) levels.fill(255, i * 16, i * 16 + 8);
  return { version: 1, status: 'ready', frameRate: 30, frameCount, bandCount: 16, bandHz: [40, 58, 85, 123, 179, 260, 379, 551, 800, 1164, 1693, 2462, 3580, 5206, 7570, 11008, 16000],
    durationMs, tempo: 120, levels: Buffer.from(levels).toString('base64'), onsets: [], beats: Array.from({ length: Math.floor(durationMs / 500) }, (_, i) => i * 500) };
}
// The band levels each visualizer canvas last drew with (its uB uniform).
async function recordBands(page: Page) {
  await page.addInitScript(() => {
    const record = window as unknown as { visualBands: Record<string, number[]> }; record.visualBands = {};
    const locate = WebGL2RenderingContext.prototype.getUniformLocation;
    WebGL2RenderingContext.prototype.getUniformLocation = function (this: WebGL2RenderingContext, program: WebGLProgram, name: string) {
      const location = locate.call(this, program, name); if (location) (location as { uniform?: string }).uniform = name; return location;
    };
    const set = WebGL2RenderingContext.prototype.uniform1fv;
    WebGL2RenderingContext.prototype.uniform1fv = function (this: WebGL2RenderingContext, location: WebGLUniformLocation | null, data: Float32List, ...rest: unknown[]) {
      const canvas = this.canvas as HTMLCanvasElement;
      if ((location as { uniform?: string } | null)?.uniform === 'uB') record.visualBands[canvas.closest('.visualizer-stage') ? 'full' : 'sleeve'] = Array.from(data as Float32Array);
      return (set as (...args: unknown[]) => void).call(this, location, data, ...rest);
    } as typeof set;
  });
}
const bands = (page: Page, where: 'full' | 'sleeve') => page.evaluate(where => (window as unknown as { visualBands: Record<string, number[]> }).visualBands[where] || [], where);

test('a song with an energy map moves to it, says Live, and fetches it once only when a visualizer opens', async ({ page }) => {
  await recordBands(page);
  const fixture = await mockPortal(page); onYouTube(fixture);
  const asked: string[] = [];
  await page.route('**/api/guilds/*/analysis/*', async route => { asked.push(new URL(route.request().url()).pathname); await route.fulfill({ json: energyMap() }); });
  await openPlayer(page);
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);
  await page.getByRole('button', { name: 'Show visualizer', exact: true }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const dialog = fullScreen(page);
  await expect(dialog.locator('.visualizer-source')).toHaveText(/^Live/);
  await expect(dialog.locator('.visualizer-source')).toContainText('moving with this song’s measured energy');
  // The bands follow the map: the low half full, the high half resting.
  await expect.poll(async () => { const drawn = await bands(page, 'full'); return drawn.length === 16 && drawn[0] > .85 && drawn[7] > .85 && drawn[8] < .1 && drawn[15] < .1; }).toBe(true);
  for (const name of ['MilkDrop', 'Cosmic Broadcast', 'Receiver', 'Gridrunner']) {
    await dialog.getByRole('radio', { name }).check();
    await page.waitForTimeout(150);
    await expect(dialog.locator('.visualizer-fallback')).toHaveCount(0);
  }
  // The sleeve and the full screen share one request; reopening is answered without another.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  await expect(fullScreen(page).locator('.visualizer-source')).toHaveText(/^Live/);
  expect(asked).toEqual([`/api/guilds/${fixture.state.snapshot.guild.id}/analysis/${VIDEO}`]);
});

test('a map still being measured is asked again, and a song without one stays Ambient without retrying', async ({ page }) => {
  const fixture = await mockPortal(page); onYouTube(fixture);
  let asked = 0; let missing = false;
  await page.route('**/api/guilds/*/analysis/*', async route => {
    asked++;
    if (missing) await route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'This guild or resource is unavailable to you.' } } });
    else await route.fulfill({ json: asked === 1 ? { version: 1, status: 'pending', retryMs: 500 } : energyMap() });
  });
  await openPlayer(page);
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Full-screen visualizer', exact: true }).click();
  const chip = fullScreen(page).locator('.visualizer-source');
  await expect(chip).toHaveText(/^Ambient/);
  await expect(chip).toHaveText(/^Live/);
  expect(asked).toBe(2);

  // The next song can't be measured: it stays on generated motion, asked once.
  missing = true; asked = 0;
  const state = fixture.state.snapshot;
  state.session.current = { ...state.session.queue[0], uri: 'https://youtu.be/aaaaaaaaaaa' }; state.revision = 'next-song';
  await emit(page, state);
  await expect(chip).toHaveText(/^Ambient/);
  await page.waitForTimeout(1500);
  await expect(chip).toHaveText(/^Ambient/);
  expect(asked).toBe(1);
  await expect(fullScreen(page).locator('canvas[data-drawn]')).toHaveCount(1);
});
