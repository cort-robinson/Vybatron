import { test, expect, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';

const result = (id: string, title: string) => ({
  id, title, author: 'Harbor Lights', uri: `https://www.youtube.com/watch?v=${id}`, source: 'youtube', durationMs: 201_000, artworkUrl: null, isStream: false, requestedBy: null,
});
const neon = result('neon-tide-1', 'Neon Tide'); const rain = result('rain-check1', 'Rain Check');
// The full queue keeps rendering behind the dialog.
const queued = (page: Page) => page.locator('.queue:not(.queue-compact) .track-row strong').allTextContents();

async function searchFor(page: Page) {
  await page.route('**/api/guilds/testing/search?*', route => route.fulfill({ json: { tracks: [neon, rain], notice: null } }));
  await gotoSession(page);
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('harbor lights');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Neon Tide to queue' })).toBeEnabled();
}

test('a chosen result joins the queue at once and further additions stay open while the bot confirms', async ({ page }) => {
  const fixture = await mockPortal(page);
  await searchFor(page);
  const release = fixture.holdCommands();
  await page.getByRole('button', { name: 'Add Neon Tide to queue' }).click();
  await expect.poll(() => queued(page)).toContain('Neon Tide');
  await expect(page.getByRole('status').filter({ hasText: 'Adding “Neon Tide”…' })).toBeVisible();
  // The next result can be added before the first is confirmed; it waits its turn.
  await expect(page.getByRole('button', { name: 'Add Rain Check to queue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Add Rain Check to queue' }).click();
  await expect.poll(() => queued(page)).toEqual(['Night Drive', 'Slow Motion', 'Golden Hour', 'Afterglow', 'Neon Tide', 'Rain Check']);
  expect(fixture.commands.map(command => command.options?.query)).toEqual([neon.uri]);
  release();
  await expect.poll(() => fixture.commands.map(command => command.options?.query)).toEqual([neon.uri, rain.uri]);
  expect(fixture.commands.every(command => command.command === 'play' && command.expectedRevision === undefined)).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Your listening space is updated.' })).toBeVisible();
});

test('a rejected addition leaves the queue as the bot reports it', async ({ page }) => {
  const fixture = await mockPortal(page);
  await searchFor(page);
  const release = fixture.holdCommands();
  fixture.conflictNext();
  await page.getByRole('button', { name: 'Add Neon Tide to queue' }).click();
  await expect.poll(() => queued(page)).toContain('Neon Tide');
  release();
  await expect(page.getByRole('alert').first()).toContainText('The session or library changed');
  await expect.poll(() => queued(page)).not.toContain('Neon Tide');
});

test('a fair queue adds without predicting where the song lands', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.fairQueue = true;
  await searchFor(page);
  const release = fixture.holdCommands();
  await page.getByRole('button', { name: 'Add Neon Tide to queue' }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(await queued(page)).not.toContain('Neon Tide');
  await expect(page.getByRole('button', { name: 'Add Rain Check to queue' })).toBeEnabled();
  release();
});
