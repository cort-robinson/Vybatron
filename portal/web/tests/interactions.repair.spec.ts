import { test, expect, type Page } from '@playwright/test';
import { mockPortal, streamAction } from './fixtures';

async function largeQueue(page: Page, count = 500) {
  const fixture = await mockPortal(page);
  const seed = fixture.state.snapshot.session.queue[0];
  fixture.state.snapshot.session.queue = Array.from({ length: count }, (_, index) => ({
    ...seed, id: (index + 1).toString(16).padStart(24, '0'), title: `Queued song ${index + 1}`,
  }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  return fixture;
}

for (const dismissal of ['Escape', 'Close', 'backdrop'] as const) {
  test(`header search gives the input focus and stays dismissed after ${dismissal}`, async ({ page }) => {
    await mockPortal(page); await page.goto('/');
    const trigger = page.locator('.header-search');
    await expect(trigger).toHaveJSProperty('tagName', 'BUTTON');
    await trigger.focus();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await trigger.press('Enter');
    const input = page.getByRole('searchbox', { name: 'Music search' });
    await expect(input).toBeFocused();
    await input.fill('A search draft worth keeping');
    if (dismissal === 'Escape') await input.press('Escape');
    else if (dismissal === 'Close') await page.getByRole('button', { name: 'Close dialog' }).click();
    else await page.mouse.click(4, 4);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.focus();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await trigger.press('Space');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('A search draft worth keeping');
    await input.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test('Add music search keeps native dialog tab containment and returns to its own trigger', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Add music', exact: true }).first();
  await trigger.click();
  const input = page.getByRole('searchbox', { name: 'Music search' });
  await expect(input).toBeFocused();
  await input.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(input).toBeFocused();
  await input.fill('Night Drive');
  await page.getByRole('button', { name: 'Play next', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('queue disclosure focuses its first action and returns focus on Escape and outside text', async ({ page }) => {
  const fixture = await mockPortal(page); await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Song options for Night Drive' });
  await trigger.click();
  const controls = await trigger.getAttribute('aria-controls');
  expect(controls).toBeTruthy();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Play now', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.queue .menu-panel')).toHaveCount(0);
  await trigger.click();
  await page.getByRole('heading', { name: 'Up Next', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-controls', controls!);
  await expect(page.locator('.queue .menu-panel')).toHaveCount(0);
  expect(fixture.commands).toHaveLength(0);
});

test('queue disclosure preserves outside control focus and uses the next logical Tab target', async ({ page }) => {
  await mockPortal(page); await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Song options for Night Drive' });
  await trigger.click();
  await page.keyboard.press('Shift+Tab');
  await expect(trigger).toBeFocused();
  await expect(page.locator('.queue .menu-panel')).toHaveCount(0);
  await trigger.press('Enter');
  await page.getByRole('button', { name: 'Remove from queue', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save Slow Motion to favorites' })).toBeFocused();
  await expect(page.locator('.queue .menu-panel')).toHaveCount(0);
  await trigger.click();
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toBeFocused();
  await expect(page.locator('.queue .menu-panel')).toHaveCount(0);
});

test('an unavailable queue disclosure remains keyboard dismissible without enabling mutations', async ({ page }) => {
  const fixture = await mockPortal(page, { outsideVoice: true }); await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Song options for Night Drive' });
  await trigger.click();
  const panel = page.locator('.queue .menu-panel');
  await expect(panel).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Play now', exact: true })).toBeDisabled();
  await expect(panel).toContainText('Join General');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(panel).toHaveCount(0);
  expect(fixture.commands).toHaveLength(0);
});

for (const action of [
  { label: 'Play now', command: 'skipto', options: { position: 51 } },
  { label: 'Move up', command: 'move', options: { from: 51, to: 50 } },
  { label: 'Move down', command: 'move', options: { from: 51, to: 52 } },
  { label: 'Remove from queue', command: 'remove', options: { position: 51 } },
]) {
  test(`queue page two ${action.label} keeps the absolute queue position and revision`, async ({ page }) => {
    const fixture = await largeQueue(page);
    const queue = page.getByRole('region', { name: 'Shared queue', exact: true });
    await expect(queue.locator('.track-row')).toHaveCount(50);
    await expect(queue.locator('.count')).toContainText('500 songs');
    await queue.getByRole('navigation', { name: 'Queue pages pagination' }).getByRole('button', { name: /next/i }).click();
    await expect(queue.locator('.track-row').first().locator('.track-index')).toHaveText('51');
    await expect(queue.locator('ol')).toHaveAttribute('start', '51');
    await queue.getByRole('button', { name: 'Song options for Queued song 51', exact: true }).click();
    await queue.getByRole('button', { name: action.label, exact: true }).click();
    await expect.poll(() => fixture.commands.length).toBe(1);
    expect(fixture.commands[0]).toEqual({ command: action.command, options: action.options, expectedRevision: 'revision-1' });
    await expect(queue.locator('.menu-panel')).toHaveCount(0);
  });
}

test('queue page two favorite add and removal bind absolute position and original library token', async ({ page }) => {
  const fixture = await largeQueue(page);
  const selected = fixture.state.snapshot.session.queue[50];
  const queue = page.getByRole('region', { name: 'Shared queue', exact: true });
  await queue.getByRole('navigation', { name: 'Queue pages pagination' }).getByRole('button', { name: /next/i }).click();
  await queue.getByRole('button', { name: 'Save Queued song 51 to favorites', exact: true }).click();
  await expect(queue.getByRole('button', { name: 'Remove Queued song 51 from favorites', exact: true })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'add', options: { position: 51 }, expectedRevision: 'revision-1' });
  await queue.getByRole('button', { name: 'Remove Queued song 51 from favorites', exact: true }).click();
  await expect(queue.getByRole('button', { name: 'Save Queued song 51 to favorites', exact: true })).toBeEnabled();
  expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 3 }, expectedTrackId: selected.id });
});

test('a page two drag uses absolute positions and rejects a revision changed during the drag', async ({ page }) => {
  const fixture = await largeQueue(page);
  const queue = page.getByRole('region', { name: 'Shared queue', exact: true });
  await queue.getByRole('navigation', { name: 'Queue pages pagination' }).getByRole('button', { name: /next/i }).click();
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const from = queue.locator('.track-row').nth(0); const to = queue.locator('.track-row').nth(1);
  await from.locator('.drag-handle').dispatchEvent('dragstart', { dataTransfer });
  await to.dispatchEvent('drop', { dataTransfer });
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'move', options: { from: 51, to: 52 }, expectedRevision: 'revision-1' });
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await from.locator('.drag-handle').dispatchEvent('dragstart', { dataTransfer });
  fixture.state.snapshot.revision = 'another-device-revision';
  await streamAction(page, 'reconnect', fixture.state.snapshot);
  await expect(queue.locator('.track-row').first()).toHaveAttribute('data-track-id', fixture.state.snapshot.session.queue[50].id);
  await to.dispatchEvent('drop', { dataTransfer });
  await expect(page.getByRole('alert')).toContainText('The queue changed while you were moving');
  expect(fixture.commands).toHaveLength(1);
  await dataTransfer.dispose();
});

test('queue pagination clamps a shorter queue and a compact queue renders only fifteen rows', async ({ page }) => {
  const fixture = await largeQueue(page, 61);
  const queue = page.getByRole('region', { name: 'Shared queue', exact: true });
  await queue.getByRole('navigation', { name: 'Queue pages pagination' }).getByRole('button', { name: /next/i }).click();
  await expect(queue.locator('.track-row')).toHaveCount(11);
  fixture.state.snapshot.session.queue = fixture.state.snapshot.session.queue.slice(0, 40);
  fixture.state.snapshot.revision = 'shorter-queue';
  await streamAction(page, 'reconnect', fixture.state.snapshot);
  await expect(queue.locator('.track-row')).toHaveCount(40);
  await expect(queue.locator('.track-index').first()).toHaveText('1');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await expect(queue.locator('.track-row')).toHaveCount(15);
  await queue.getByRole('navigation', { name: 'Expanded queue pages pagination' }).getByRole('button', { name: /next/i }).click();
  await expect(queue.locator('.track-index').first()).toHaveText('16');
  await queue.getByRole('button', { name: 'Song options for Queued song 16', exact: true }).click();
  await queue.getByRole('button', { name: 'Save to favorites', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'add', options: { position: 16 }, expectedRevision: 'shorter-queue' });
});

test('phone queue keeps readable metadata, one forty-four pixel row menu, and favorites inside it at 390 and 320 widths', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.queue[0].title = 'A very long live performance title with guests and a bonus encore that keeps going';
  await page.goto('/');
  const row = page.locator('.queue .track-row').first();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(row.locator('> .favorite')).toBeHidden();
    const menu = await row.locator('.row-menu > button').boundingBox();
    expect(menu).not.toBeNull();
    expect(menu!.width).toBeGreaterThanOrEqual(44); expect(menu!.height).toBeGreaterThanOrEqual(44);
    await row.locator('.row-menu > button').click();
    await expect(row.locator('.menu-panel').getByRole('button', { name: /favorite/i })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await row.locator('.track-text strong').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await row.locator('.track-text > span').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('missing and failed source covers use responsive variants and fresh source artwork recovers', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.queue[0].artworkUrl = 'https://example.com/broken-cover.jpg';
  fixture.state.snapshot.session.queue[1].artworkUrl = null;
  await page.route('https://example.com/broken-cover.jpg', route => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  const rows = page.locator('.queue .track-row');
  for (const index of [0, 1]) {
    const cover = rows.nth(index).locator('picture.artwork');
    await expect(cover).toBeVisible();
    await expect(cover.locator('source')).toHaveAttribute('srcset', /fallback-cover-320.webp 320w.*fallback-cover-640.webp 640w.*fallback-cover-1024.webp 1024w/);
    await expect.poll(() => cover.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
  fixture.state.snapshot.session.queue[0].artworkUrl = fixture.state.snapshot.session.current!.artworkUrl;
  fixture.state.snapshot.revision = 'artwork-repaired';
  await streamAction(page, 'reconnect', fixture.state.snapshot);
  await expect(rows.first().locator('img.artwork')).toBeVisible();
  await expect(rows.first().locator('picture')).toHaveCount(0);
});
