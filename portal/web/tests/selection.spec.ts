import { test, expect, type Page } from './test';
import type { Command } from '../src/types';
import { mockPortal, streamAction, gotoSession } from './fixtures';

async function refreshLibrary(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/library') && response.status() === 200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await response;
}

test('every dedicated favorite action binds the displayed song, including both queue hearts', async ({ page }) => {
  const fixture = await mockPortal(page);
  const [night, slow, golden] = fixture.state.snapshot.session.queue;
  const current = fixture.state.snapshot.session.current!;
  fixture.state.library.favorites.push(slow, golden);
  await gotoSession(page);
  await page.getByRole('button', { name: 'Remove current song from favorites' }).click();
  await expect(page.getByRole('button', { name: 'Save current song to favorites' })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: current.id });
  await page.getByRole('button', { name: 'Remove Night Drive from favorites' }).click();
  await expect(page.getByRole('button', { name: 'Save Night Drive to favorites' })).toBeEnabled();
  expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: night.id });
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const sleeveQueue = page.locator('.sleeve-queue');
  await expect(sleeveQueue).toBeVisible();
  await sleeveQueue.getByRole('button', { name: 'Song options for Slow Motion' }).click();
  await page.getByRole('button', { name: 'Remove favorite', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  expect(fixture.commands[2]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: slow.id });
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('button', { name: 'Queue favorite Golden Hour' }).click();
  await expect(page.getByRole('button', { name: 'Queue favorite Golden Hour' })).toBeEnabled();
  expect(fixture.commands[3]).toEqual({ command: 'favorite', subcommand: 'play', options: { index: 1 }, expectedTrackId: golden.id });
  await page.getByRole('button', { name: 'Remove favorite Golden Hour' }).click();
  await expect(page.getByRole('heading', { name: 'A place for your repeat favorites' })).toBeVisible();
  expect(fixture.commands[4]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: golden.id });
});

// Stale favorite play is covered with filtering in library.repair.spec.ts.
for (const subcommand of ['remove']) {
  test(`stale favorite ${subcommand} rows keep their token and require a fresh deliberate retry`, async ({ page }) => {
    const fixture = await mockPortal(page);
    const current = fixture.state.snapshot.session.current!;
    fixture.state.library.favorites.push(fixture.state.snapshot.session.queue[1]);
    await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
    const action = subcommand === 'play' ? 'Queue favorite Evening Light' : 'Remove favorite Evening Light';
    await expect(page.getByRole('button', { name: action })).toBeEnabled();
    const queue = structuredClone(fixture.state.snapshot.session.queue);
    fixture.state.library.favorites.shift(); // Another device changes index 2 while the old row stays displayed.
    const reads = fixture.requests.length;
    await page.getByRole('button', { name: action }).click();
    await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
    expect(fixture.commands).toEqual([{ command: 'favorite', subcommand, options: { index: 2 }, expectedTrackId: current.id }]);
    expect(fixture.state.snapshot.session.queue).toEqual(queue);
    expect(fixture.state.library.favorites.map(track => track.title)).toEqual(['Evening Light', 'Slow Motion']);
    expect(fixture.requests.slice(reads)).toContain('/api/guilds/testing');
    expect(fixture.requests.slice(reads)).toContain('/api/guilds/testing/library');
    await page.getByRole('button', { name: action }).click();
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands[1]).toEqual({ command: 'favorite', subcommand, options: { index: 1 }, expectedTrackId: current.id });
  });
}

test('history rows preserve the selected entry when filtering shifts indexes without changing revision', async ({ page }) => {
  const fixture = await mockPortal(page);
  const original = fixture.state.library.history[0];
  fixture.state.library.history.push({ ...original, id: 'history-2', track: fixture.state.snapshot.session.queue[2] });
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeEnabled();
  const queue = structuredClone(fixture.state.snapshot.session.queue);
  fixture.state.library.history.shift();
  await page.getByRole('button', { name: 'Replay Afterglow' }).click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.commands).toEqual([{ command: 'replay', options: { index: 1 }, expectedHistoryId: original.id, expectedRevision: 'revision-1' }]);
  expect(fixture.state.snapshot.session.queue).toEqual(queue);
  await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Replay Golden Hour' }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'replay', options: { index: 1 }, expectedHistoryId: 'history-2', expectedRevision: 'revision-1' });
});

test('mix confirmation keeps its opening version across fresh SSE and library replacement', async ({ page }) => {
  const fixture = await mockPortal(page); const mix = fixture.state.library.mixes[0]; const version = mix.version;
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: 'Shared mixes' }).click();
  await page.getByRole('button', { name: 'Delete mix Night shift' }).click();
  mix.version = 'b'.repeat(32); mix.tracks = mix.tracks.slice(1);
  fixture.state.snapshot.revision = 'replacement-revision';
  await streamAction(page, 'reconnect', fixture.state.snapshot); await refreshLibrary(page);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete mix', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.commands).toEqual([{ command: 'mix', subcommand: 'delete', options: { name: mix.name }, expectedMixVersion: version }]);
  expect(fixture.state.library.mixes).toHaveLength(1);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Delete mix Night shift' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete mix', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Build a soundtrack together' })).toBeVisible();
  expect(fixture.commands[1]).toEqual({ command: 'mix', subcommand: 'delete', options: { name: mix.name }, expectedMixVersion: mix.version });
});

for (const action of ['favorite/play', 'favorite/remove', 'replay', 'mix/delete']) {
  test(`schema ${action} captures identity on input and preserves it across refresh, disconnect and confirmation`, async ({ page }) => {
    const fixture = await mockPortal(page);
    fixture.state.library.favorites.push(fixture.state.snapshot.session.queue[1]);
    fixture.state.library.history.push({ ...fixture.state.library.history[0], id: 'history-2', track: fixture.state.snapshot.session.queue[2] });
    const [command, subcommand] = action.split('/');
    const field = command === 'mix' ? 'name' : 'index'; const input = command === 'mix' ? 'Night shift' : command === 'replay' ? '1' : '2';
    const oldTokens: Partial<Command> = command === 'favorite' ? { expectedTrackId: fixture.state.library.favorites[1].id }
      : command === 'replay' ? { expectedHistoryId: 'history-1' } : { expectedMixVersion: fixture.state.library.mixes[0].version };
    await page.goto('/'); await page.getByRole('button', { name: 'Server', exact: true }).click();
    await page.getByRole('tab', { name: 'Advanced controls' }).click();
    await page.getByLabel('Command', { exact: true }).selectOption(command);
    if (subcommand) await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption(subcommand);
    await expect(page.getByRole('button', { name: 'Apply control' })).toBeDisabled();
    await page.getByLabel(field).fill(input);
    await expect(page.getByText(`Selected: ${command === 'favorite' ? 'Evening Light' : command === 'replay' ? 'Afterglow' : 'Night shift'}`, { exact: true })).toBeVisible();
    if (command === 'favorite') fixture.state.library.favorites.shift();
    else if (command === 'replay') fixture.state.library.history.shift();
    else fixture.state.library.mixes[0].version = 'b'.repeat(32);
    await refreshLibrary(page);
    await streamAction(page, 'disconnect');
    await expect(page.getByRole('button', { name: 'Apply control' })).toBeDisabled();
    await expect(page.getByLabel(field)).toHaveValue(input);
    await streamAction(page, 'reconnect');
    await expect(page.getByRole('button', { name: 'Apply control' })).toBeEnabled();
    expect(fixture.commands).toHaveLength(0);
    await page.getByRole('button', { name: 'Apply control' }).click();
    if (command === 'mix') {
      // The form's confirmation also retains its captured command across another update.
      fixture.state.library.mixes[0].version = 'c'.repeat(32); await refreshLibrary(page);
      await page.getByRole('dialog').getByRole('button', { name: 'Delete mix', exact: true }).click();
    }
    await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
    expect(fixture.commands).toEqual([{ command, ...(subcommand ? { subcommand } : {}), options: { [field]: field === 'index' ? Number(input) : input }, expectedRevision: 'revision-1', ...oldTokens }]);
    await expect(page.getByLabel(field)).toHaveValue(input);
    if (command === 'mix') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const freshTokens: Partial<Command> = command === 'favorite' ? { expectedTrackId: fixture.state.library.favorites[1].id }
      : command === 'replay' ? { expectedHistoryId: 'history-2' } : { expectedMixVersion: 'c'.repeat(32) };
    await page.getByRole('button', { name: 'Review current selection', exact: true }).click();
    expect(fixture.commands).toHaveLength(1);
    await page.getByRole('button', { name: 'Apply control' }).click();
    if (command === 'mix') await page.getByRole('dialog').getByRole('button', { name: 'Delete mix', exact: true }).click();
    await expect.poll(() => fixture.commands.length).toBe(2);
    expect(fixture.commands[1]).toEqual({ command, ...(subcommand ? { subcommand } : {}), options: { [field]: field === 'index' ? Number(input) : input }, expectedRevision: 'revision-1', ...freshTokens });
  });
}

test('schema selection clears across actions and rejects unknown library indexes', async ({ page }) => {
  const fixture = await mockPortal(page); await gotoSession(page);
  await page.getByRole('button', { name: 'Server', exact: true }).click(); await page.getByRole('tab', { name: 'Advanced controls' }).click();
  await page.getByLabel('Command', { exact: true }).selectOption('favorite');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('play');
  await page.getByLabel('index').fill('999');
  await expect(page.getByRole('button', { name: 'Apply control' })).toBeDisabled();
  await page.getByLabel('index').fill('1');
  await expect(page.getByRole('button', { name: 'Apply control' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('remove');
  await expect(page.getByRole('button', { name: 'Apply control' })).toBeDisabled();
  await page.getByLabel('index').fill('1');
  await page.getByRole('button', { name: 'Apply control' }).click();
  await expect(page.getByRole('button', { name: 'Apply control' })).toBeEnabled();
  expect(fixture.commands[0]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: fixture.state.snapshot.session.queue[0].id, expectedRevision: 'revision-1' });
  await page.getByLabel('Command', { exact: true }).selectOption('play');
  await page.getByLabel('query').fill('Night Drive');
  await page.getByRole('button', { name: 'Apply control' }).click();
  await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1]).toEqual({ command: 'play', options: { query: 'Night Drive' }, expectedRevision: 'revision-2' });
});

test('phone schema selection remains visible and removable outside voice without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const fixture = await mockPortal(page, { outsideVoice: true }); const selected = fixture.state.library.favorites[0].id;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.getByRole('button', { name: 'Server', exact: true }).click();
  await page.getByRole('tab', { name: 'Advanced controls' }).click(); await page.getByLabel('Command', { exact: true }).selectOption('favorite');
  await page.getByRole('combobox', { name: 'Action', exact: true }).selectOption('remove'); await page.getByLabel('index').fill('1');
  await expect(page.getByText('Selected: Night Drive', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply control' }).click({ trial: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('selection-phone.png') });
  await page.getByRole('button', { name: 'Apply control' }).click();
  await expect(page.getByRole('button', { name: 'Apply control' })).toBeEnabled();
  expect(fixture.commands).toEqual([{ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: selected, expectedRevision: 'revision-1' }]);
  expect(errors).toEqual([]);
});

test('a library read started before 409 cannot overwrite the fresh conflict read', async ({ page }) => {
  const fixture = await mockPortal(page);
  fixture.state.library.favorites.push(fixture.state.snapshot.session.queue[1]);
  await page.goto('/'); await page.getByRole('button', { name: 'My Music', exact: true }).click();
  const button = page.getByRole('button', { name: 'Remove favorite Evening Light' });
  await expect(button).toBeEnabled();
  const reads = fixture.requests.filter(path => path.endsWith('/library')).length;
  fixture.delayLibrary(700);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => fixture.requests.filter(path => path.endsWith('/library')).length).toBeGreaterThan(reads);
  fixture.state.library.favorites.shift(); fixture.delayLibrary(0);
  await button.click();
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  await expect(page.getByRole('button', { name: 'Remove favorite Night Drive' })).toHaveCount(0);
  // Let the older fixture response finish; its aborted read must stay discarded.
  await page.waitForTimeout(800);
  await expect(page.getByRole('button', { name: 'Remove favorite Night Drive' })).toHaveCount(0);
  expect(fixture.commands).toHaveLength(1);
  await button.click(); await expect.poll(() => fixture.commands.length).toBe(2);
  expect(fixture.commands[1].options).toEqual({ index: 1 });
});
