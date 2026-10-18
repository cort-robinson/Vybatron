import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

test('Classic look renders without Overdrive scenery and switches back live from Settings', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('vybertron.skin', 'classic'); sessionStorage.setItem('seeded', '1'); } });
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'classic');
  await expect(page.locator('.od-horizon')).toHaveCount(0);
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('overdrive');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await expect(page.locator('.od-horizon')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
});

test('Fantastic Four is opt-in: it swaps in the Earth-828 scenery and the sleeve television, and persists', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('fantastic');
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'fantastic');
  await expect(page.locator('.ff-scene')).toHaveCount(1);
  await expect(page.locator('.od-horizon')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'fantastic');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(page.locator('.sleeve-artwork .ff-tv')).toHaveCount(1);
  await expect(page.locator('.sleeve-artwork .od-cover-hud')).toHaveCount(0);
});

// Record the look's styles at the instant the app first commits and whenever data-skin flips;
// a look applied before its stylesheet arrives would flash another one.
async function watchLook(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = []; (window as unknown as { looks: string[] }).looks = seen;
    const record = (moment: string) => {
      const style = getComputedStyle(document.documentElement);
      seen.push(`${moment}:${document.documentElement.dataset.skin}:${style.getPropertyValue('--neon').trim() ? 'od' : ''}${style.getPropertyValue('--ff-cream').trim() ? 'ff' : ''}`);
    };
    // Init scripts run before <html> exists, so watch the whole document.
    new MutationObserver(() => record('flip')).observe(document, { subtree: true, attributeFilter: ['data-skin'] });
    const first = new MutationObserver(() => { if (document.getElementById('root')?.firstElementChild) { first.disconnect(); record('commit'); } });
    first.observe(document, { subtree: true, childList: true });
  });
  return () => page.evaluate(() => (window as unknown as { looks: string[] }).looks);
}

test('Fantastic loads only when chosen, and every look is styled the moment it applies', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', request => { if (/\/assets\/fantastic-/i.test(request.url())) requested.push(request.url()); });
  const looks = await watchLook(page);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect(page.locator('.od-horizon')).toHaveCount(1);
  expect(requested).toEqual([]);
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('fantastic');
  await expect(page.locator('.ff-scene')).toHaveCount(1);
  expect(requested.some(url => url.endsWith('.css'))).toBe(true);
  // Overdrive is styled at first commit; Fantastic's stylesheet is in place before it applies.
  expect((await looks()).filter(entry => !entry.startsWith('flip:overdrive'))).toEqual(['commit:overdrive:od', 'flip:fantastic:ff']);
  await page.reload();
  await expect(page.locator('.ff-scene')).toHaveCount(1);
  expect(await looks()).toEqual(['flip:fantastic:', 'commit:fantastic:ff']);
});

test('a look that fails to load keeps the current one, and choosing it again fetches it and applies it styled', async ({ page }) => {
  let failures = 1;
  await page.route(/\/assets\/fantastic-[^/]*\.css$/i, route => failures-- > 0 ? route.abort() : route.continue());
  const looks = await watchLook(page);
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  const look = page.getByLabel('Portal look');
  await look.selectOption('fantastic');
  await expect(page.getByText('That look couldn’t load. Check your connection, then reload the page and try again.')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await expect(look).toHaveValue('overdrive');
  await look.selectOption('fantastic');
  await expect(page.locator('.ff-scene')).toHaveCount(1);
  expect((await looks()).filter(entry => !entry.startsWith('flip:overdrive'))).toEqual(['commit:overdrive:od', 'flip:fantastic:ff']);
});

test('a look whose script fails keeps the current one across the reload it asks for, then applies when chosen again', async ({ page }) => {
  let failures = 1;
  await page.route(/\/assets\/Fantastic-[^/]*\.js$/, route => failures-- > 0 ? route.fulfill({ status: 503, body: '' }) : route.continue());
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('fantastic');
  await expect(page.getByText('That look couldn’t load. Check your connection, then reload the page and try again.')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-skin', 'overdrive');
  await page.reload();
  await expect(page.locator('.od-horizon')).toHaveCount(1);
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByLabel('Portal look').selectOption('fantastic');
  await expect(page.locator('.ff-scene')).toHaveCount(1);
});

test('performance mode drops glass blur and stills the scene, and stays on after a reload', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  // The sidebar's glass, drawn by the WebGL room (--glass) or by backdrop-filter without it.
  const blur = () => page.locator('.sidebar').evaluate(element => getComputedStyle(element).getPropertyValue('--glass').trim());
  // The one-time power-on animates the chrome; read the settled style.
  await expect(page.locator('html')).not.toHaveAttribute('data-boot');
  expect(await blur()).not.toBe('none');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Performance mode' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-performance', '');
  expect(await blur()).toBe('none');
  await expect(page.locator('.ambient-scene')).toHaveClass(/settled/);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-performance', '');
  await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByRole('switch', { name: 'Performance mode' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-performance');
});

test('a mouse drags an overflowing shelf sideways without pressing what it grabbed', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const fixture = await mockPortal(page); await page.goto('/');
  const shelf = page.getByRole('list', { name: 'Your mixes' });
  await expect(shelf).toHaveClass(/can-drag/);
  const play = shelf.getByRole('button', { name: /^Play/ }).first();
  await play.scrollIntoViewIfNeeded();
  const box = (await play.boundingBox())!;
  const before = fixture.commands.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  for (let step = 1; step <= 8; step++) await page.mouse.move(box.x + box.width / 2 - step * 30, box.y + box.height / 2);
  await page.waitForTimeout(150); await page.mouse.up();
  // The drag outruns the shelf, so it ends scrolled fully to the far edge.
  await expect.poll(() => shelf.evaluate(element => element.scrollWidth - element.clientWidth - element.scrollLeft)).toBeLessThanOrEqual(1);
  expect(await shelf.evaluate(element => element.scrollLeft)).toBeGreaterThan(20);
  await page.waitForTimeout(300);
  expect(fixture.commands.length).toBe(before);
  // A press that barely moves is still an ordinary click.
  await play.click();
  await expect.poll(() => fixture.commands.length).toBe(before + 1);
});
