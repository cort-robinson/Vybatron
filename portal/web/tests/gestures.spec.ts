import { expect, test, type Locator, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';

test.use({ hasTouch: true });

// One-finger drag through the browser's real touch pipeline, so scrolling, touch-action, and
// event cancelability behave as they do on a phone.
async function drag(page: Page, locator: Locator, { dx = 0, dy, duration = 160, hold = 0 }: { dx?: number; dy: number; duration?: number; hold?: number }) {
  const box = (await locator.boundingBox())!; const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page); const steps = 8;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  if (hold) await page.waitForTimeout(hold);
  for (let i = 1; i <= steps && (dx || dy); i++) { await page.waitForTimeout(duration / steps); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / steps, y: y + dy * i / steps }] }); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
const press = (page: Page, locator: Locator, hold: number) => drag(page, locator, { dy: 0, hold });
// Sends a whole quick gesture (start, vertical moves, end) back to back without awaiting each event,
// so it reaches the page as a quick tap or flick however slow the machine is. Awaited steps can
// stretch into a long hold under load, which is then rightly treated as one.
async function burst(page: Page, locator: Locator, moves: number[] = [], { holdAfter = 0 } = {}) {
  const box = (await locator.boundingBox())!; const x = box.x + box.width / 2; const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await Promise.all([
    cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }),
    ...moves.map(dy => cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy }] })),
    ...holdAfter ? [] : [cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })],
  ]);
  // A finger that moved and then rests stays down for `holdAfter` before lifting.
  if (holdAfter) { await page.waitForTimeout(holdAfter); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
  await cdp.detach();
}
// Motion has settled once view transitions end and the player's cover has landed (motion.ts).
const settled = (page: Page) => page.waitForFunction(() => !document.documentElement.dataset.motion && !document.querySelector('[data-cover-flight]'));
// Like a tap, a swipe leaves no keyboard focus ring behind.
const ringless = async (page: Page) => expect(await page.evaluate(() => document.querySelector(':focus-visible')?.outerHTML.slice(0, 80) ?? null)).toBeNull();

test('phone player opens with a swipe up and closes with a pull down', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  const player = page.getByTestId('player');
  await expect(player).toHaveClass(/collapsed/);
  // A swipe that starts on the compact identity opens the player without also pressing it.
  await drag(page, player.locator('.compact-title'), { dy: -90 }); await settled(page);
  await expect(player).toHaveClass(/expanded/);
  await expect(player.getByRole('heading', { name: 'Evening Light', exact: true })).toBeVisible();
  await ringless(page);
  // Open, the player takes the whole screen; the header and tabs return when it closes.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  // A short, slow pull springs back.
  await drag(page, player.locator('.sleeve-artwork'), { dy: 40, duration: 600 });
  await expect(player).toHaveClass(/expanded/);
  await expect.poll(() => player.evaluate(element => element.style.transform)).toBe('');
  // A quick pull closes it, starting from the controls as well as the cover.
  await drag(page, player.locator('.transport'), { dy: 220 }); await settled(page);
  await expect(player).toHaveClass(/collapsed/);
  expect(await player.evaluate(element => [element.style.transform, element.style.opacity])).toEqual(['', '']);
  await ringless(page);
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  expect(fixture.commands).toEqual([]);
});

test('sideways or downward drags leave the compact player closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  const player = page.getByTestId('player');
  await drag(page, player.locator('.compact-title'), { dx: 150, dy: -60 });
  await drag(page, player.locator('.compact-title'), { dy: 80 });
  await page.waitForTimeout(200);
  await expect(player).toHaveClass(/collapsed/);
  expect(fixture.commands).toEqual([]);
});

test('pulling down in scrolled player content scrolls instead of closing', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await mockPortal(page); await page.goto('/');
  const player = page.getByTestId('player');
  await page.getByRole('button', { name: 'Open player', exact: true }).click(); await settled(page);
  const content = player.locator('.sleeve-content');
  await content.evaluate(element => { element.style.paddingBottom = '600px'; element.scrollTop = 120; });
  await drag(page, player.locator('.sleeve-artwork'), { dy: 220 });
  await expect(player).toHaveClass(/expanded/);
  // Back at the top, the same pull closes the player.
  await content.evaluate(element => { element.scrollTop = 0; });
  await drag(page, player.locator('.sleeve-artwork'), { dy: 220 }); await settled(page);
  await expect(player).toHaveClass(/collapsed/);
});

test('Up next opens as a sheet by tap or swipe, and Back closes the sheet, then the player', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  const player = page.getByTestId('player'); const sheet = player.locator('.sleeve-queue');
  await page.getByRole('button', { name: 'Open player', exact: true }).click(); await settled(page);
  const handle = player.locator('.up-next-handle');
  await expect(handle).toHaveAccessibleName('Up next 4 songs');
  await expect(sheet).toBeHidden();
  await handle.click();
  await expect(sheet.getByRole('heading', { name: 'Up Next' })).toBeVisible();
  await expect(sheet.locator('.queue-sheet-now')).toContainText('Evening Light');
  await expect(handle).toHaveAttribute('aria-expanded', 'true'); await expect(handle).toHaveAccessibleName('Hide queue');
  // The transport stays under the sheet.
  await expect(player.getByRole('button', { name: 'Pause playback', exact: true })).toBeInViewport();
  await drag(page, sheet.locator('.queue-sheet-now'), { dy: 240 });
  await expect(sheet).toBeHidden();
  await expect(player.getByRole('heading', { name: 'Evening Light', exact: true })).toBeVisible();
  await drag(page, handle, { dy: -90 });
  await expect(sheet).toBeVisible();
  await page.goBack();
  await expect(sheet).toBeHidden(); await expect(player).toHaveClass(/expanded/);
  await page.goBack(); await settled(page);
  await expect(player).toHaveClass(/collapsed/);
  // Closing by button consumes the player's history entry, so Back is never needed twice.
  await page.getByRole('button', { name: 'Open player', exact: true }).click(); await settled(page);
  await page.getByRole('button', { name: 'Close player', exact: true }).first().click(); await settled(page);
  await expect.poll(() => page.evaluate(() => history.state?.vybatronLayer ?? 0)).toBe(0);
  expect(fixture.commands).toEqual([]);
});

test('a touch drag on the handle moves a queued song where the finger lifts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await gotoSession(page);
  const rows = page.locator('.queue .track-list > .track-row');
  const handle = (await rows.nth(0).locator('.drag-handle').boundingBox())!; const target = (await rows.nth(2).boundingBox())!;
  const x = handle.x + handle.width / 2; const y = handle.y + handle.height / 2; const to = target.y + target.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 10; i++) { await page.waitForTimeout(25); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (to - y) * i / 10 }] }); }
  await expect(rows.nth(0)).toHaveClass(/lifted/); await expect(rows.nth(2)).toHaveClass(/drop-target/);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => fixture.commands).toEqual([expect.objectContaining({ command: 'move', options: { from: 1, to: 3 }, expectedRevision: 'revision-1' })]);
  await expect(page.locator('.track-row.lifted, .track-row.drop-target')).toHaveCount(0);
});

test('phone song menus are bottom sheets that close by scrim, swipe, or action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await gotoSession(page);
  const options = (title: string) => page.getByRole('button', { name: `Song options for ${title}`, exact: true });
  const sheet = page.getByRole('group', { name: 'Song options for Golden Hour' });
  await options('Golden Hour').click();
  await expect(sheet).toBeVisible();
  await expect.poll(async () => { const box = (await sheet.boundingBox())!; return [box.width, Math.round(box.y + box.height)]; }).toEqual([390, 844]);
  await page.locator('.menu-sheet-scrim').click({ position: { x: 20, y: 20 } });
  await expect(sheet).toBeHidden();
  await options('Golden Hour').click();
  await drag(page, sheet.locator('p').first(), { dy: 260 });
  await expect(sheet).toBeHidden();
  expect(fixture.commands).toEqual([]);
  await options('Golden Hour').click();
  await sheet.getByRole('button', { name: 'Play next', exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(() => fixture.commands).toEqual([expect.objectContaining({ command: 'move', options: { from: 3, to: 1 } })]);
});

test('holding a queue row opens its menu; a tap or a scroll does not', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await gotoSession(page);
  const row = page.locator('.queue .track-row', { hasText: 'Slow Motion' }).locator('.track-text');
  const sheet = page.getByRole('group', { name: 'Song options for Slow Motion' });
  await burst(page, row);
  // A scroll whose finger then rests past the hold time is still a scroll.
  await burst(page, row, [-15, -30, -45, -60], { holdAfter: 700 });
  await expect(sheet).toHaveCount(0);
  await press(page, row, 700);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Play now', exact: true })).toBeVisible();
  expect(fixture.commands).toEqual([]);
});

test('a sideways swipe never changes the song in a shared Discord session', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page); await page.goto('/');
  const player = page.getByTestId('player');
  await drag(page, player.locator('.compact-title'), { dx: -220, dy: 0 });
  await page.waitForTimeout(300);
  await expect(player.locator('.compact-track-title')).toHaveText('Evening Light');
  expect(fixture.commands).toEqual([]);
});
