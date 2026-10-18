import { test, expect, type Page } from './test';
import { createHash } from 'node:crypto';
import type { Track } from '../src/types';
import { fixtureState, mockPortal, streamAction } from './fixtures';

function songs(count: number): Track[] {
  const source = fixtureState().library.favorites[0];
  return Array.from({ length: count }, (_, index) => ({ ...source,
    id: createHash('sha256').update(`library-song-${index}`).digest('hex').slice(0, 24),
    title: `Song ${String(index + 1).padStart(4, '0')}`,
    author: index % 2 ? 'Selected artist' : 'Other artist',
  }));
}
async function openLibrary(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await expect(page.getByLabel('Search favorites', { exact: true })).toBeVisible();
}
async function refreshLibrary(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/library') && response.status() === 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response;
}

test('1,000 favorites mount at most 50 rows and filtering plus paging retains source positions', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.library.favorites = songs(1000);
  await openLibrary(page);
  const rows = page.locator('.library-track-list > li');
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole('navigation', { name: 'favorites pagination' })).toContainText('1–50 of 1,000');
  expect(await page.locator('.library-view *').count()).toBeLessThan(1400);
  await page.getByLabel('Search favorites', { exact: true }).fill('selected artist');
  await expect(rows).toHaveCount(50);
  await expect(page.getByRole('navigation', { name: 'favorites pagination' })).toContainText('1–50 of 500');
  await page.getByRole('button', { name: 'Next page of favorites' }).click();
  await expect(rows.first()).toContainText('Song 0102');
  await page.getByRole('button', { name: 'Queue favorite Song 0102', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'play', options: { index: 102 }, expectedTrackId: fixture.state.library.favorites[101].id });
  await expect(page.getByRole('button', { name: 'Remove favorite Song 0102', exact: true })).toBeEnabled();
  const selected = fixture.state.library.favorites[101].id;
  await page.getByRole('button', { name: 'Remove favorite Song 0102', exact: true }).click();
  await expect(rows.first()).toContainText('Song 0104');
  expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 102 }, expectedTrackId: selected });
  await page.getByLabel('Search favorites', { exact: true }).fill('Song 0999');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Song 0999');
});

test('legacy favorite overflow remains searchable and removable by its original position', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.library.favorites = songs(1003);
  const track = fixture.state.library.favorites[1002];
  await openLibrary(page); await page.getByLabel('Search favorites', { exact: true }).fill(track.title);
  await expect(page.locator('.library-track-list > li')).toHaveCount(1);
  await page.getByRole('button', { name: `Remove favorite ${track.title}`, exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1003 }, expectedTrackId: track.id });
  await expect(page.getByRole('heading', { name: 'No matching favorites' })).toBeVisible();
});

test('history pages and channel search keep entry identity, source index and fresh session revision', async ({ page }) => {
  const fixture = await mockPortal(page); const tracks = songs(100);
  fixture.state.library.history = tracks.map((track, index) => ({ id: `history-${index + 1}`, track, playedAt: Date.now() - index * 60_000,
    voiceChannel: { id: 'voice', name: index > 9 ? 'Chill Lounge' : 'General' } }));
  await openLibrary(page); await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.locator('.history-list > li')).toHaveCount(50);
  await page.getByLabel('Search listening history').fill('Chill Lounge');
  await page.getByRole('button', { name: 'Next page of listening history' }).click();
  await expect(page.locator('.history-list > li').first()).toContainText('Song 0061');
  await page.getByRole('button', { name: 'Replay Song 0061', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  expect(fixture.commands[0]).toEqual({ command: 'replay', options: { index: 61 }, expectedHistoryId: 'history-61', expectedRevision: 'revision-1' });
});

test('filtered stale favorite rows require a deliberate retry with refreshed source identity', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.library.favorites = songs(100);
  const selected = fixture.state.library.favorites[75];
  await openLibrary(page); await page.getByLabel('Search favorites', { exact: true }).fill(selected.title);
  fixture.state.library.favorites.shift();
  await page.getByRole('button', { name: `Queue favorite ${selected.title}` }).click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.commands).toEqual([{ command: 'favorite', subcommand: 'play', options: { index: 76 }, expectedTrackId: selected.id }]);
  await page.getByRole('button', { name: `Queue favorite ${selected.title}` }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand: 'play', options: { index: 75 }, expectedTrackId: selected.id });
});

test('mix search finds songs and artists, bounds expanded tracks, and preserves original numbering', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.library.mixes[0].tracks = songs(100);
  await openLibrary(page); await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await page.getByLabel('Search shared mixes').fill('Selected artist');
  await page.getByRole('button', { name: 'View mix Night shift', exact: true }).click();
  const tracks = page.locator('.mix-track-list > li');
  await expect(tracks).toHaveCount(50);
  await page.getByRole('button', { name: 'Next page of mix songs' }).click();
  await expect(tracks.first()).toHaveAttribute('value', '51');
  await expect(tracks.first()).toContainText('Song 0051');
  await page.getByLabel('Search songs in this mix').fill('Song 0076');
  await expect(tracks).toHaveCount(1); await expect(tracks.first()).toHaveAttribute('value', '76');
});

test('filtered mix deletion keeps the version from confirmation even after a fresh library', async ({ page }) => {
  const fixture = await mockPortal(page); const mix = fixture.state.library.mixes[0]; const version = mix.version;
  await openLibrary(page); await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await page.getByLabel('Search shared mixes').fill('Night shift');
  await page.getByRole('button', { name: 'Delete mix Night shift' }).click();
  mix.version = 'b'.repeat(32); await refreshLibrary(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete mix', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.commands).toEqual([{ command: 'mix', subcommand: 'delete', options: { name: mix.name }, expectedMixVersion: version }]);
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('native replace and save retain confirmation, editing projection, and queue revision', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.library.mixes.push({ ...fixture.state.library.mixes[0], id: 'other', name: 'Another person’s mix', ownerId: 'sam', canEdit: false });
  await openLibrary(page); await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await expect(page.getByRole('button', { name: 'Replace mix Another person’s mix with this session' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete mix Another person’s mix' })).toHaveCount(0);
  const name = page.getByLabel('Save this session as a mix');
  await name.fill('Another person’s mix'); await expect(page.getByRole('button', { name: 'Replace mix', exact: true })).toBeDisabled();
  await name.fill('New shared mix'); await page.getByRole('button', { name: 'Save mix', exact: true }).click();
  await expect(name).toHaveValue('');
  expect(fixture.commands[0]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'New shared mix', replace: false }, expectedRevision: 'revision-1' });
  await page.getByRole('button', { name: 'Replace mix Night shift with this session', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Replace the songs in this shared mix');
  expect(fixture.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(fixture.commands).toHaveLength(1);
  await page.getByRole('button', { name: 'Replace mix Night shift with this session', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Replace mix', exact: true }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'Night shift', replace: true }, expectedRevision: 'revision-2' });
});

test('no-results feedback supports keyboard clearing and offline state blocks mutations', async ({ page }) => {
  const fixture = await mockPortal(page); await openLibrary(page);
  await page.getByLabel('Search favorites', { exact: true }).fill('not a song');
  await expect(page.getByRole('heading', { name: 'No matching favorites' })).toBeVisible();
  await page.locator('.empty-state').getByRole('button', { name: 'Clear search' }).click();
  await expect(page.getByLabel('Search favorites', { exact: true })).toBeFocused();
  await streamAction(page, 'disconnect');
  await expect(page.getByRole('button', { name: 'Queue favorite Night Drive', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove favorite Night Drive', exact: true })).toBeDisabled();
  expect(fixture.commands).toHaveLength(0);
});

test('outside voice keeps private library edits and creator mix saves while blocking music additions', async ({ page }) => {
  const fixture = await mockPortal(page, { outsideVoice: true });
  await openLibrary(page);
  await expect(page.getByRole('button', { name: 'Queue favorite Night Drive', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove favorite Night Drive', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Clear favorites', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('across all servers');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'Replay Afterglow', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await expect(page.getByRole('button', { name: 'Queue mix', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Replace mix Night shift with this session', exact: true })).toBeEnabled();
  await page.getByLabel('Save this session as a mix').fill('Outside voice draft');
  await expect(page.getByRole('button', { name: 'Save mix', exact: true })).toBeEnabled();
  expect(fixture.commands).toHaveLength(0);
});

test('long RTL and CJK metadata stays inside separate 44px targets at desktop and 320px', async ({ page }) => {
  const fixture = await mockPortal(page);
  const rtl = `${'ليلة جميلة '.repeat(20)} — 夜の音楽`;
  const cjk = '夜の音楽世界'.repeat(40);
  fixture.state.library.favorites = [{ ...songs(1)[0], title: rtl, author: cjk }];
  await openLibrary(page);
  const row = page.locator('.library-track-list > li').first();
  await expect(row.locator('strong')).toHaveAttribute('dir', 'auto');
  for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    await row.scrollIntoViewIfNeeded();
    const bounds = await row.evaluate(element => {
      const text = element.querySelector('.track-text')!.getBoundingClientRect();
      const buttons = Array.from(element.querySelectorAll('button')).map(button => button.getBoundingClientRect());
      return { noOverflow: document.documentElement.scrollWidth <= innerWidth, textEnd: text.right,
        buttons: buttons.map(button => ({ x: button.x, right: button.right, width: button.width, height: button.height })) };
    });
    expect(bounds.noOverflow).toBe(true);
    expect(bounds.textEnd).toBeLessThanOrEqual(bounds.buttons[0].x);
    expect(bounds.buttons[0].right).toBeLessThanOrEqual(bounds.buttons[1].x);
    for (const button of bounds.buttons) { expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: test.info().outputPath(`library-${viewport.width}.png`) });
  }
  await page.getByLabel('Search favorites', { exact: true }).fill('夜の音楽');
  await expect(page.locator('.library-track-list > li')).toHaveCount(1);
  await page.getByLabel('Search favorites', { exact: true }).fill('ليلة');
  await expect(page.locator('.library-track-list > li')).toHaveCount(1);
});

test('paused library cache removes its heavy subtree and retains the mix draft and filter on return', async ({ page }) => {
  const fixture = await mockPortal(page); fixture.state.library.favorites = songs(1000);
  await openLibrary(page);
  await expect(page.locator('.library-track-list > li')).toHaveCount(50);
  await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await page.getByLabel('Save this session as a mix').fill('Draft to keep');
  await page.getByLabel('Search shared mixes').fill('Night');
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await expect(page.locator('.library-view *')).toHaveCount(0);
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await expect(page.getByLabel('Save this session as a mix')).toHaveValue('Draft to keep');
  await expect(page.getByLabel('Search shared mixes')).toHaveValue('Night');
});

test('a new song in the same room keeps the library on screen while it refreshes', async ({ page }) => {
  const fixture = await mockPortal(page);
  await openLibrary(page);
  const favorites = page.locator('.library-track-list > li');
  await expect(favorites).toHaveCount(2);
  const reads = () => fixture.requests.filter(path => path.endsWith('/library')).length;
  const before = reads();
  fixture.delayLibrary(1500);
  const next = structuredClone(fixture.state.snapshot); const session = next.session;
  session.queue.push(session.current!); session.current = session.queue.shift()!; next.revision = 'revision-next-song';
  await streamAction(page, 'reconnect', next);
  // History gains the song that just ended, so the library is read again, but favorites stay listed
  // while that read is in flight instead of blanking to a loading state.
  await expect.poll(reads).toBe(before + 1);
  // Sample once, well inside the delayed read; a retrying assertion would wait the blank state out.
  await page.waitForTimeout(250);
  expect(await page.getByText('Loading your music…').count()).toBe(0);
  expect(await favorites.count()).toBe(2);
});
