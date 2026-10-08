import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { gotoSession, mockPortal, suggestedTracks } from './fixtures';

test('autoplay suggestions sit after the queue as their own group and can be promoted, disliked, or removed', async ({ page }) => {
  const fixture = await mockPortal(page, { suggested: true });
  const [city, tide] = suggestedTracks();
  await gotoSession(page);
  const queue = page.getByRole('region', { name: 'Shared queue' });
  const group = queue.getByRole('region', { name: 'Suggested' });
  await expect(group).toBeVisible();
  await expect(group).toContainText('Autoplay · after your queue');
  // Queued songs come first in document order; suggestions are not numbered queue positions.
  const queued = queue.locator('ol.track-list > li');
  await expect(queued).toHaveCount(1);
  expect(await queued.first().evaluate((row, other) => !!(row.compareDocumentPosition(document.querySelector(other)!) & Node.DOCUMENT_POSITION_FOLLOWING), '.suggested')).toBe(true);
  await expect(group.getByRole('listitem')).toHaveCount(2);
  await expect(group.getByRole('listitem').first()).toContainText('Autoplay pick');
  expect((await new AxeBuilder({ page }).include('.suggested').analyze()).violations).toEqual([]);

  await group.getByRole('button', { name: `Add ${city.title} to the queue` }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'promote', options: { position: 1 }, expectedTrackId: city.id });
  await expect(queued).toHaveCount(2);
  await expect(queued.last()).toContainText(city.title);
  // Promoted picks stay autoplay-requested (play statistics depend on it).
  await expect(queued.last()).toContainText('Autoplay pick');
  await expect(group.getByRole('listitem')).toHaveCount(1);

  await group.getByRole('button', { name: `Suggestion options for ${tide.title}` }).click();
  await group.getByRole('button', { name: 'Less like this' }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'less', options: { position: 1 }, expectedTrackId: tide.id });
  await expect(group).toHaveCount(0);
});

test('a stale suggestion is rejected instead of editing a different pick', async ({ page }) => {
  const fixture = await mockPortal(page, { suggested: true });
  await gotoSession(page);
  const group = page.getByRole('region', { name: 'Suggested' });
  await expect(group.getByRole('listitem')).toHaveCount(2);
  // Another listener removed the first pick; this browser has not refreshed yet.
  fixture.state.snapshot.session.suggestions.shift();
  await group.getByRole('button', { name: 'Suggestion options for City Lights' }).click();
  await group.getByRole('button', { name: 'Remove suggestion' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.subcommand).toBe('remove');
  expect(fixture.state.snapshot.session.suggestions.map(track => track.title)).toEqual(['Low Tide']);
});

test('start radio from a queued song, a favorite, a history entry, or a search result', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  const firstQueued = fixture.state.snapshot.session.queue[0];
  await page.getByRole('button', { name: `Song options for ${firstQueued.title}` }).click();
  await page.getByRole('button', { name: 'Start radio from this song' }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'on', options: { track: firstQueued.uri } });

  await page.getByRole('link', { name: 'My Music' }).or(page.getByRole('button', { name: 'My Music' })).first().click();
  const favorite = fixture.state.library.favorites[0];
  await page.getByRole('button', { name: `Start radio from ${favorite.title}` }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'on', options: { track: favorite.uri } });

  await page.getByRole('tab', { name: /History/ }).click();
  const played = fixture.state.library.history[0].track;
  await page.getByRole('button', { name: `Start radio from ${played.title}` }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'on', options: { track: played.uri } });

  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('searchbox', { name: 'Music search' }).fill('Midnight');
  await dialog.getByRole('button', { name: 'Start radio from Midnight City' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.options).toMatchObject({ track: expect.stringContaining('midnight-city') });
});

test('the current autoplay pick is labeled and offers Less like this; listeners without control see it disabled', async ({ page }) => {
  const fixture = await mockPortal(page, { suggested: true });
  const session = fixture.state.snapshot.session;
  session.current = { ...session.suggestions[0] };
  session.suggestions = session.suggestions.slice(1);
  await page.goto('/');
  const player = page.getByTestId('player');
  await expect(player).toContainText('Autoplay pick');
  await player.getByRole('button', { name: 'More playback controls' }).click();
  await expect(player.getByRole('button', { name: 'Turn autoplay off' })).toBeVisible();
  await player.getByRole('button', { name: 'Less like this' }).click();
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'radio', subcommand: 'less', expectedTrackId: session.current!.id });
});

test('server managers choose an autoplay mode with copy that explains the selected mode', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  await page.getByRole('link', { name: 'Server' }).or(page.getByRole('button', { name: 'Server', exact: true })).first().click();
  const select = page.getByLabel('Autoplay', { exact: true });
  await expect(select).toHaveValue('off');
  await expect(page.locator('#autoplay-help')).toContainText('The session ends when the queue runs out');
  await select.selectOption('listening');
  await expect.poll(() => fixture.commands.at(-1)).toEqual({ command: 'settings', subcommand: 'autoplay', options: { mode: 'listening' } });
  await expect(page.locator('#autoplay-help')).toContainText('isn’t deafened');
});

test('phone suggestions keep one action column and put Add to queue in the row menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockPortal(page, { suggested: true });
  await gotoSession(page);
  const group = page.getByRole('region', { name: 'Suggested' });
  await expect(group.getByRole('listitem')).toHaveCount(2);
  await expect(group.locator('.suggested-add').first()).toBeHidden();
  const row = group.getByRole('listitem').first();
  const box = await row.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await group.getByRole('button', { name: 'Suggestion options for City Lights' }).click();
  await group.getByRole('button', { name: 'Add to queue' }).click();
  await expect.poll(() => fixture.commands.at(-1)?.subcommand).toBe('promote');
});
