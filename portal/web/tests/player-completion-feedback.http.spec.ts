import { expect, test, type Page, type Locator } from '@playwright/test';
import { gotoSession } from './fixtures';
import type { GuildSnapshot } from '../src/types';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const instanceId = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
const stamp = (snapshot: GuildSnapshot, sequence: number) => { snapshot.ordering = { instanceId, sequence }; };
const player = (page: Page) => page.getByTestId('player');
const action = (page: Page, playing: boolean) => player(page).getByRole('button', { name: playing ? 'Pause playback' : 'Resume playback', exact: true });
const confirmation = (page: Page) => player(page).locator('.player-confirmation');
const syncing = (page: Page) => confirmation(page).getByText('Syncing with Discord…', { exact: true });

async function connected(page: Page, server: Fixture, playing = true) {
  server.state.snapshot.session.status = playing ? 'playing' : 'paused';
  stamp(server.state.snapshot, 1);
  await gotoSession(page, server.origin);
  await expect(action(page, playing)).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
  stamp(server.state.snapshot, 2);
  server.state.snapshot.session.queue[0].title = 'Authorized initial stream'; server.broadcast();
  await expect(page.getByTitle('Authorized initial stream', { exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function bounds(locator: Locator, page: Page) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!; const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  return box;
}

test('a same-turn double activation predicts once and sends exactly one write', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandExecution(); server.holdCommandReplies();
    // Both activations see the same render: the second is already satisfied by the first prediction.
    await action(page, true).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(action(page, false)).toBeEnabled();
    await expect.poll(() => server.commands.length).toBe(1);
    stamp(server.state.snapshot, 3); server.broadcast();
    await expect(action(page, false)).toBeEnabled();
    server.releaseCommandExecution(); await expect.poll(() => server.heldCommands.size).toBe(1);
    stamp(server.state.snapshot, 4); server.broadcast();
    server.releaseCommandReplies();
    await expect(syncing(page)).toHaveCount(0);
    await expect(action(page, false)).toBeEnabled(); await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toEqual([{ command: 'pause' }]);
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
  } finally { await page.close(); await server.close(); }
});

for (const playing of [true, false]) {
  test(`${playing ? 'Pause' : 'Resume'} keeps the whole player usable while confirmation is pending`, async ({ page }) => {
    const server = await startHttpFixture({ orderedCommands: true });
    try {
      await connected(page, server, playing);
      await page.getByRole('button', { name: 'Open player', exact: true }).click();
      server.holdCommandReplies(); stamp(server.state.snapshot, 3);
      await action(page, playing).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
      await expect(action(page, !playing)).toBeEnabled();
      for (const label of ['Restart current song', 'Skip current song', 'Shuffle queue']) await expect(player(page).getByRole('button', { name: label, exact: true })).toBeEnabled();
      for (const label of ['Playback position', 'Volume']) await expect(player(page).getByRole('slider', { name: label, exact: true })).toBeEnabled();
      await expect(player(page).getByRole('combobox', { name: 'Audio filter' })).toBeEnabled();
      await expect(player(page).getByRole('group', { name: 'Playback controls' })).not.toHaveAttribute('aria-busy', 'true');
      server.releaseCommandReplies(); await expect(action(page, !playing)).toBeEnabled();
      await expect(confirmation(page)).toBeEmpty();
      // The change was visible at once; no success toast repeats it.
      await expect(page.locator('.toast.success')).toHaveCount(0);
      expect(server.commands).toHaveLength(1);
    } finally { await page.close(); await server.close(); }
  });
}

test('newer Discord state and permission reason win over the original command target', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    stamp(server.state.snapshot, 4); server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'New shared selection';
    server.state.snapshot.session.canControl = false; server.state.snapshot.session.reason = 'Playback controls require the DJ role.';
    server.broadcast(); await expect(player(page).getByText('New shared selection', { exact: true })).toBeVisible();
    // Permissions only ever come from verified state, even under a prediction.
    await expect(action(page, false)).toBeDisabled();
    await expect(action(page, false)).toHaveAttribute('title', 'Playback controls require the DJ role.');
    server.releaseCommandReplies(); await expect(confirmation(page)).toBeEmpty();
    await expect(action(page, true)).toBeDisabled();
    await expect(player(page).getByText('New shared selection', { exact: true })).toBeVisible();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('connection loss disables controls and a held reply cannot restore freshness or replay', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.applicationError(503);
    await expect(action(page, false)).toHaveAttribute('title', 'Reconnect for fresh state before making changes.');
    await expect(action(page, false)).toBeDisabled();
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    await expect(action(page, false)).toBeDisabled();
    stamp(server.state.snapshot, 4); server.releaseSnapshotReads();
    await expect(action(page, false)).toBeEnabled(); await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('authoritative revocation retires protected state and a delayed high-sequence reply cannot revive it', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 900);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.applicationError(403);
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    server.releaseCommandReplies(); await page.waitForTimeout(300);
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(action(page, false)).toBeDisabled();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('an uncertain failure drops the prediction, reports it may have completed and shows fresh state without replay', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.holdSnapshotReads();
    // Complete the actual held HTTP response with failure, without replacing the
    // EventSource, hook or fixture implementation.
    const [response] = server.heldCommands.keys();
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'unavailable', message: 'Confirmation is unavailable.' } }));
    await expect(page.getByRole('alert')).toContainText('this action may have completed');
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    // Until fresh state arrives the last verified state is shown read-only.
    await expect(action(page, true)).toBeDisabled();
    stamp(server.state.snapshot, 4); server.releaseSnapshotReads();
    // The bot did pause; the fresh read, not the prediction, shows that.
    await expect(action(page, false)).toBeEnabled(); await expect(confirmation(page)).toBeEmpty();
    await expect(page.locator('.toast.success')).toHaveCount(0); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('confirmation covers a pending favorite while urgent Stop retains its deliberate exception', async ({ page }) => {
  const server = await startHttpFixture({ orderedCommands: true });
  try {
    await connected(page, server);
    const favorite = player(page).getByRole('button', { name: 'Remove current song from favorites' });
    await expect(favorite).toBeEnabled(); server.holdCommandReplies();
    await favorite.click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    await expect(confirmation(page).getByText('Waiting for confirmation', { exact: true })).toBeVisible();
    await expect(action(page, true)).toBeDisabled();
    await player(page).getByRole('button', { name: 'More playback controls' }).click();
    await player(page).getByRole('button', { name: 'Stop and discard session', exact: true }).click();
    await page.getByRole('button', { name: 'Stop and discard', exact: true }).click();
    await expect.poll(() => server.commands.length).toBe(2);
    expect(server.commands.map(command => command.command)).toEqual(['favorite', 'stop']);
    stamp(server.state.snapshot, 4); server.broadcast();
    await expect(player(page).getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(confirmation(page).getByText('Waiting for confirmation', { exact: true })).toBeVisible();
    server.releaseCommandReplies(); await expect(confirmation(page)).toBeEmpty();
    expect(server.commands).toHaveLength(2);
  } finally { await page.close(); await server.close(); }
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`bounded syncing layout and screenshots ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const server = await startHttpFixture({ orderedCommands: true });
    try {
      await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: 'reduce' });
      await connected(page, server); server.holdCommandReplies();
      const initialHeight = (await player(page).boundingBox())!.height;
      server.state.snapshot.session.current!.title = 'Evening Light — a long live performance with extended artist credits';
      stamp(server.state.snapshot, 3); server.broadcast();
      await expect(player(page).getByText(server.state.snapshot.session.current!.title).first()).toBeVisible();
      await action(page, true).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
      await expect(syncing(page)).toBeVisible();
      expect((await player(page).boundingBox())!.height).toBe(initialHeight);
      for (const expanded of [false, true]) {
        if (expanded) await page.getByRole('button', { name: 'Open player', exact: true }).click();
        const feedback = await bounds(confirmation(page), page);
        const button = await bounds(action(page, false), page);
        expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
        // The compact phone deck shows passive progress; seeking lives in the expanded player.
        if (expanded || viewport.width >= 1024) {
          const seek = await bounds(player(page).getByRole('slider', { name: 'Playback position' }), page);
          expect(seek.width).toBeGreaterThanOrEqual(44); expect(seek.height).toBeGreaterThanOrEqual(44);
          expect(seek.x + seek.width).toBeLessThanOrEqual(feedback.x + 1);
        }
        expect(feedback.y + feedback.height <= button.y + 1 || button.y + button.height <= feedback.y + 1).toBe(true);
        if (viewport.width < 1024) {
          const nav = (await page.locator('.navigation').boundingBox())!;
          expect(feedback.y + feedback.height).toBeLessThanOrEqual(nav.y + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(await confirmation(page).locator('.spinner').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
        const path = testInfo.outputPath(`player-syncing-${viewport.width}x${viewport.height}-${expanded ? 'expanded' : 'collapsed'}.png`);
        await page.screenshot({ path }); await testInfo.attach(`syncing ${expanded ? 'expanded' : 'collapsed'}`, { path, contentType: 'image/png' });
      }
      server.releaseCommandReplies(); await expect(action(page, false)).toBeEnabled();
      await expect(confirmation(page)).toBeEmpty();
    } finally { await page.close(); await server.close(); }
  });
}
