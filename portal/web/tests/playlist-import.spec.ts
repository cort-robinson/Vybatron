import { test, expect, type Page } from '@playwright/test';
import { mockPortal } from './fixtures';

const LINK = 'https://music.youtube.com/playlist?list=PLroadtrip';

async function openMusic(page: Page, skin?: string) {
  if (skin) await page.addInitScript(value => localStorage.setItem('vybertron.skin', value), skin);
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await expect(page.getByLabel('Search favorites', { exact: true })).toBeVisible();
}

test('a playlist link previews counts and saves to favorites only after confirming', async ({ page }) => {
  const fixture = await mockPortal(page);
  await openMusic(page);
  const preview = page.getByRole('button', { name: 'Preview import' });
  await expect(preview).toBeDisabled();
  await page.getByLabel('Import a playlist').fill('https://example.com/list');
  await expect(preview).toBeDisabled();
  await page.getByLabel('Import a playlist').fill(LINK);
  await preview.click();
  const dialog = page.getByRole('dialog', { name: 'Import Road trip' });
  await expect(dialog).toContainText('4 songs found. 2 songs will be added to your favorites.');
  for (const [label, value] of [['Will be added', '2'], ['Already saved', '1'], ['Not matched', '1'], ['Over the 1,000-song limit', '0']]) {
    await expect(dialog.locator('.import-counts > div', { hasText: label }).locator('dd')).toHaveText(value);
  }
  await expect(dialog.getByRole('list', { name: 'Songs to add' }).getByRole('listitem')).toHaveText([/Open Road/, /Mile Marker/]);
  expect(fixture.commands.at(-1)).toEqual({ command: 'favorite', subcommand: 'import', options: { link: LINK } });
  expect(fixture.state.library.favorites).toHaveLength(2);

  await dialog.getByRole('button', { name: 'Add 2 songs' }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.commands.at(-1)).toEqual({ command: 'favorite', subcommand: 'import', options: { link: LINK }, expectedImportId: 'b'.repeat(32) });
  await expect(page.getByText(/Added 2 tracks\. 1 track is already saved\. 1 track couldn’t be matched/)).toBeVisible();
  await expect(page.locator('.library-track-list > li')).toHaveCount(4);
  await expect(page.getByLabel('Import a playlist')).toHaveValue('');
});

test('cancelling a preview saves nothing', async ({ page }) => {
  const fixture = await mockPortal(page);
  await openMusic(page);
  await page.getByLabel('Import a playlist').fill(LINK);
  await page.getByRole('button', { name: 'Preview import' }).click();
  await page.getByRole('dialog', { name: 'Import Road trip' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(fixture.commands.filter(command => command.expectedImportId)).toHaveLength(0);
  expect(fixture.state.library.favorites).toHaveLength(2);
});

test('a playlist imports into a new shared mix, and another listener’s mix is locked', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.library.mixes.push({ id: 'theirs', name: 'Their mix', ownerId: 'sam', version: 'd'.repeat(32), canEdit: false, tracks: [] });
  await openMusic(page);
  await page.getByRole('tab', { name: /Shared mixes/ }).click();
  await page.getByLabel('Mix name').fill('their mix');
  await page.getByLabel('Playlist link').fill(LINK);
  await expect(page.getByRole('button', { name: 'Preview import' })).toBeDisabled();
  await expect(page.getByText('That mix belongs to another listener.', { exact: false })).toBeVisible();
  await page.getByLabel('Mix name').fill('Road trip');
  await expect(page.getByText('Creates a shared mix from a public playlist, up to 100 songs.')).toBeVisible();
  await page.getByRole('button', { name: 'Preview import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import Road trip' });
  await expect(dialog).toContainText('3 songs will be added to “Road trip”.');
  await expect(dialog.locator('.import-counts > div', { hasText: 'Over the 100-song limit' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Add 3 songs' }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.commands.at(-1)).toEqual({ command: 'mix', subcommand: 'import', options: { link: LINK, name: 'Road trip' }, expectedImportId: 'b'.repeat(32) });
  await expect(page.getByRole('button', { name: 'View mix Road trip' })).toBeVisible();
});

for (const skin of ['overdrive', 'fantastic', 'classic']) {
  test(`the import form and preview fit the ${skin} look`, async ({ page }, info) => {
    await mockPortal(page);
    await openMusic(page, skin);
    await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
    await page.getByLabel('Import a playlist').fill(LINK);
    await page.getByRole('button', { name: 'Preview import' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import Road trip' });
    await expect(dialog.getByRole('button', { name: 'Add 2 songs' })).toBeVisible();
    // Counts stay inside the dialog at phone width too.
    await page.setViewportSize({ width: 390, height: 844 });
    const box = await dialog.boundingBox(); const counts = await dialog.locator('.import-counts').boundingBox();
    expect(box && counts && counts.x >= box.x && counts.x + counts.width <= box.x + box.width + 1).toBe(true);
    if (process.env.IMPORT_SCREENSHOTS) await page.screenshot({ path: info.outputPath(`import-${skin}.png`) });
  });
}
