import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockPortal } from './fixtures';

const outside = (id: string, title: string, author: string) => ({
  id, title, author, uri: `https://example.com/music/${id}`, source: 'SoundCloud', durationMs: 201_000, artworkUrl: null, isStream: false, requestedBy: null,
});

test('an empty search suggests the listener’s music and explores artists without a catalog request', async ({ page }) => {
  const fixture = await mockPortal(page);
  const neon = outside('neon-tide', 'Neon Tide', 'Harbor Lights'); const rain = outside('rain-check', 'Rain Check', 'Solara');
  fixture.state.library.history.push(
    { id: 'history-2', playedAt: 1_791_147_000_000, voiceChannel: null, track: neon },
    { id: 'history-3', playedAt: 1_791_146_000_000, voiceChannel: null, track: neon },
    { id: 'history-4', playedAt: 1_791_145_000_000, voiceChannel: null, track: rain },
  );
  const searches: string[] = [];
  await page.route('**/api/guilds/testing/search?*', async route => {
    searches.push(new URL(route.request().url()).searchParams.get('query')!);
    // Answer slower than the typing pause, so the chip's search is still in flight when it ends.
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ json: { tracks: [outside('glass-city', 'Glass City', 'Glass Avenue')], notice: null } }).catch(() => {});
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  const dialog = page.getByRole('dialog');

  // Queued and playing music is never suggested back; repeat plays rank first.
  const picks = dialog.getByRole('region', { name: 'Picked for you' }).getByRole('listitem');
  await expect(picks).toHaveCount(2);
  await expect(picks.first()).toContainText('Neon Tide');
  await expect(picks.first()).toContainText('Played 2 times');
  await expect(dialog.getByText('Afterglow', { exact: true })).toHaveCount(0);
  const chips = dialog.getByRole('region', { name: 'Explore' }).getByRole('button');
  await expect(chips.first()).toHaveText('Glass Avenue');
  expect(searches).toEqual([]);
  expect((await new AxeBuilder({ page }).include('.search-dialog').analyze()).violations).toEqual([]);

  await dialog.getByRole('button', { name: 'Add Neon Tide to queue' }).click();
  await expect.poll(() => fixture.commands.at(-1)).toMatchObject({ command: 'play', options: { query: neon.uri } });

  await chips.first().click();
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('Glass Avenue');
  await expect(page.getByRole('searchbox', { name: 'Music search' })).toBeFocused();
  await expect(dialog.getByText('Glass City', { exact: true })).toBeVisible();
  expect(searches).toEqual(['Glass Avenue']);
});

test('typing searches after a pause, reuses answers, and leaves links to an explicit choice', async ({ page }) => {
  const fixture = await mockPortal(page);
  const searches: string[] = [];
  await page.route('**/api/guilds/testing/search?*', route => {
    const query = new URL(route.request().url()).searchParams.get('query')!; searches.push(query);
    return route.fulfill({ json: { tracks: [outside(`result-${searches.length}`, `${query} (Live Result)`, 'Catalog')], notice: null } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  const input = page.getByRole('searchbox', { name: 'Music search' }); const dialog = page.getByRole('dialog');

  await input.pressSequentially('solara', { delay: 40 });
  await expect(dialog.getByText('solara (Live Result)', { exact: true })).toBeVisible();
  expect(searches).toEqual(['solara']);
  // The listener's own matches appear alongside the catalog.
  const mine = dialog.getByRole('region', { name: 'From your library' });
  await expect(mine.getByText('Night Drive', { exact: true })).toBeVisible();

  await input.fill('x');
  await expect(dialog.getByText('solara (Live Result)', { exact: true })).toBeVisible();
  await input.fill('solara');
  await expect(dialog.getByText('solara (Live Result)', { exact: true })).toBeVisible();
  await page.waitForTimeout(500);
  expect(searches).toEqual(['solara']);

  await input.fill('https://example.com/public-playlist');
  await page.waitForTimeout(500);
  expect(searches).toEqual(['solara']);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect.poll(() => searches).toEqual(['solara', 'https://example.com/public-playlist']);

  await input.fill('');
  await expect(dialog.getByRole('region', { name: 'Explore' })).toBeVisible();
  await expect(dialog.getByText('Search results')).toHaveCount(0);
  expect(fixture.commands).toEqual([]);
});
