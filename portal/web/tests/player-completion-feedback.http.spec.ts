import { expect, test, type Page, type Locator } from '@playwright/test';
import type { GuildSnapshot } from '../src/types';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const instanceId = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
const stamp = (snapshot: GuildSnapshot, sequence: number) => { snapshot.ordering = { instanceId, sequence }; };
const player = (page: Page) => page.getByTestId('player');
const action = (page: Page, playing: boolean) => player(page).getByRole('button', { name: playing ? 'Pause playback' : 'Resume playback', exact: true });
const confirmation = (page: Page) => player(page).locator('.player-confirmation');

async function connected(page: Page, server: Fixture, playing = true) {
  server.state.snapshot.session.status = playing ? 'playing' : 'paused';
  stamp(server.state.snapshot, 1);
  await page.goto(server.origin);
  await expect(action(page, playing)).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
  stamp(server.state.snapshot, 2);
  server.state.snapshot.session.queue[0].title = 'Authorized initial stream'; server.broadcast();
  await expect(page.getByTitle('Authorized initial stream', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function pendingObservation(page: Page, playing: boolean) {
  const button = action(page, playing);
  await expect(button).toBeDisabled();
  await expect(button.locator('svg')).toHaveCount(1);
  await expect(button.locator('.spinner')).toHaveCount(0);
  await expect(confirmation(page)).toContainText(playing ? 'Playing.' : 'Paused.');
  await expect(confirmation(page).getByText('Waiting for confirmation', { exact: true })).toBeVisible();
  await expect(player(page).getByRole('group', { name: 'Playback controls' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.toast.success')).toHaveCount(0);
  const id = await confirmation(page).getAttribute('id');
  expect((await button.getAttribute('aria-describedby'))?.split(' ')).toContain(id);
  expect(await confirmation(page).evaluate(element => element.closest('[aria-busy="true"]') === null)).toBe(true);
}

async function bounds(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!; const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  return box;
}

test('held execution never predicts pause, and an observed state never acknowledges the held request', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const initialIcon = await action(page, true).locator('svg').innerHTML();
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandExecution(); server.holdCommandReplies();
    // Two same-turn activations exercise the hook's synchronous pendingRef fence,
    // before a disabled render can serve as the duplicate-write protection.
    await action(page, true).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect.poll(() => server.commands.length).toBe(1);
    await pendingObservation(page, true);
    stamp(server.state.snapshot, 3); server.broadcast();
    await pendingObservation(page, true);
    server.releaseCommandExecution(); await expect.poll(() => server.heldCommands.size).toBe(1);
    expect(server.state.snapshot.session.status).toBe('paused');
    await pendingObservation(page, true); // No new accepted observation yet.
    expect(await action(page, true).locator('svg').innerHTML()).toBe(initialIcon);
    stamp(server.state.snapshot, 4); server.broadcast();
    await pendingObservation(page, false);
    server.releaseCommandReplies(); await expect(action(page, false)).toBeEnabled();
    await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toEqual([{ command: 'pause', expectedRevision: 'revision-1' }]);
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
  } finally { await page.close(); await server.close(); }
});

for (const playing of [true, false]) {
  for (const equal of [true, false]) {
    test(`${playing ? 'Pause' : 'Resume'} observation keeps confirmation pending; ${equal ? 'equal' : 'older'} reply only settles the lock`, async ({ page }) => {
      const server = await startHttpFixture();
      try {
        await connected(page, server, playing);
        await page.getByRole('button', { name: 'Open player', exact: true }).click();
        const reads = server.snapshotReads.length; const events = server.eventReads.length;
        server.holdCommandReplies(); stamp(server.state.snapshot, 3);
        const initialIcon = await action(page, playing).locator('svg').innerHTML();
        await action(page, playing).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
        await pendingObservation(page, playing);
        if (!equal) stamp(server.state.snapshot, 4);
        server.broadcast(); await pendingObservation(page, !playing);
        expect(await action(page, !playing).locator('svg').innerHTML()).not.toBe(initialIcon);
        const text = await confirmation(page).textContent();
        // Repeated equal frames and newer position-only frames leave the
        // live-region text unchanged, without changing the equal-reply case.
        stamp(server.state.snapshot, equal ? 3 : 5); server.state.snapshot.session.positionMs += 1000; server.broadcast();
        await expect(confirmation(page)).toHaveText(text!);
        for (const label of ['Restart current song', 'Skip current song', 'Shuffle queue']) await expect(player(page).getByRole('button', { name: label, exact: true })).toBeDisabled();
        for (const label of ['Playback position', 'Volume']) await expect(player(page).getByRole('slider', { name: label, exact: true })).toBeDisabled();
        await expect(player(page).getByRole('combobox', { name: 'Audio filter' })).toBeDisabled();
        await action(page, !playing).dispatchEvent('click'); await action(page, !playing).press('Enter');
        expect(server.commands).toHaveLength(1);
        server.releaseCommandReplies(); await expect(action(page, !playing)).toBeEnabled();
        await expect(confirmation(page)).toBeEmpty();
        await expect(page.locator('.toast.success')).toBeVisible();
        expect(server.commands).toHaveLength(1); expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
      } finally { await page.close(); await server.close(); }
    });
  }
}

test('newer Discord state and permission reason win over the original command target', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    stamp(server.state.snapshot, 4); server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'New shared selection';
    server.state.snapshot.session.canControl = false; server.state.snapshot.session.reason = 'Playback controls require the DJ role.';
    server.broadcast(); await expect(player(page).getByText('New shared selection', { exact: true })).toBeVisible();
    await pendingObservation(page, true);
    await expect(action(page, true)).toHaveAttribute('title', 'Playback controls require the DJ role.');
    server.releaseCommandReplies(); await expect(confirmation(page)).toBeEmpty();
    await expect(action(page, true)).toBeDisabled();
    await expect(player(page).getByText('New shared selection', { exact: true })).toBeVisible();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('connection loss labels observation as last known and a held reply cannot restore freshness or replay', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.broadcast(); await pendingObservation(page, false);
    server.applicationError(503);
    await expect(confirmation(page)).toContainText('Last known playback.');
    await expect(confirmation(page)).not.toContainText('Paused.');
    await expect(action(page, false)).toHaveAttribute('title', 'Reconnect for fresh state before making changes.');
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    await expect(action(page, false)).toBeDisabled();
    await expect(confirmation(page).getByText('Waiting for confirmation', { exact: true })).toBeVisible();
    stamp(server.state.snapshot, 4); server.releaseSnapshotReads();
    await expect(action(page, false)).toBeEnabled(); await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('authoritative revocation retires protected observation and delayed high-sequence reply cannot revive it', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 900);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.broadcast(); await pendingObservation(page, false);
    server.applicationError(403);
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(confirmation(page)).not.toContainText('Paused.');
    await expect(confirmation(page)).toContainText('Playback state unavailable.');
    server.releaseCommandReplies(); await expect(confirmation(page)).toBeEmpty();
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(action(page, false)).toBeDisabled(); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('failure after paused observation retains observed state, shows uncertainty and never rolls back or replays', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.broadcast(); await pendingObservation(page, false);
    server.holdSnapshotReads();
    // Complete the actual held HTTP response with failure, without replacing the
    // EventSource, hook or fixture implementation.
    const [response] = server.heldCommands.keys();
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'unavailable', message: 'Confirmation is unavailable.' } }));
    await expect(page.getByRole('alert')).toContainText('this action may have completed');
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    await expect(action(page, false)).toBeDisabled(); await expect(action(page, true)).toHaveCount(0);
    await expect(confirmation(page)).toContainText('Last known playback.');
    stamp(server.state.snapshot, 4); server.releaseSnapshotReads();
    await expect(action(page, false)).toBeEnabled(); await expect(confirmation(page)).toBeEmpty();
    await expect(page.locator('.toast.success')).toHaveCount(0); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('confirmation covers a pending favorite while urgent Stop retains its deliberate exception', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const favorite = player(page).getByRole('button', { name: 'Remove current song from favorites' });
    await expect(favorite).toBeEnabled(); server.holdCommandReplies();
    await favorite.click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    await pendingObservation(page, true);
    await player(page).getByRole('button', { name: 'More playback controls' }).click();
    await player(page).getByRole('button', { name: 'Stop and discard session', exact: true }).click();
    await page.getByRole('button', { name: 'Stop and discard', exact: true }).click();
    await expect.poll(() => server.commands.length).toBe(2);
    expect(server.commands.map(command => command.command)).toEqual(['favorite', 'stop']);
    stamp(server.state.snapshot, 4); server.broadcast();
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(confirmation(page)).not.toContainText('Playing.');
    await expect(confirmation(page).getByText('Waiting for confirmation', { exact: true })).toBeVisible();
    server.releaseCommandReplies(); await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toHaveLength(2);
  } finally { await page.close(); await server.close(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`bounded pending layout and screenshots ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const server = await startHttpFixture();
    try {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
      await connected(page, server); server.holdCommandReplies();
      const initialHeight = (await player(page).boundingBox())!.height;
      await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
      await pendingObservation(page, true);
      expect((await player(page).boundingBox())!.height).toBe(initialHeight);
      server.state.snapshot.session.current!.title = 'Evening Light — a long live performance with extended artist credits';
      stamp(server.state.snapshot, 3); server.broadcast(); await pendingObservation(page, false);
      for (const expanded of [false, true]) {
        if (expanded) await page.getByRole('button', { name: 'Open player', exact: true }).click();
        const feedback = await bounds(confirmation(page), page);
        const button = await bounds(action(page, false), page);
        expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
        const seek = await bounds(player(page).getByRole('slider', { name: 'Playback position' }), page);
        expect(seek.width).toBeGreaterThanOrEqual(44); expect(seek.height).toBeGreaterThanOrEqual(44);
        expect(seek.x + seek.width).toBeLessThanOrEqual(feedback.x + 1);
        expect(feedback.y + feedback.height <= button.y + 1 || button.y + button.height <= feedback.y + 1).toBe(true);
        await expect.poll(() => action(page, false).evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 184, 77)');
        if (viewport.width < 1024) {
          const nav = (await page.locator('.navigation').boundingBox())!;
          expect(feedback.y + feedback.height).toBeLessThanOrEqual(nav.y + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await confirmation(page).locator('.spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
        const path = testInfo.outputPath(`player-completion-${viewport.width}x${viewport.height}-${expanded ? 'expanded' : 'collapsed'}.png`);
        await page.screenshot({ path }); await testInfo.attach(`pending ${expanded ? 'expanded' : 'collapsed'}`, { path, contentType: 'image/png' });
      }
      server.releaseCommandReplies(); await expect(action(page, false)).toBeEnabled();
      await expect(confirmation(page)).toBeEmpty();
    } finally { await page.close(); await server.close(); }
  });
}
