import { test, expect, type Page } from './test';
import { gotoSession } from './fixtures';
import type { GuildSnapshot } from '../src/types';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const instance = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
const nextInstance = '13f462c0-6aa2-4263-aaa1-736e2e8652a2';
const stamp = (snapshot: GuildSnapshot, sequence: number, instanceId = instance) => { snapshot.ordering = { instanceId, sequence }; };
const pause = (page: Page) => page.getByRole('button', { name: 'Pause playback' });
const resume = (page: Page) => page.getByRole('button', { name: 'Resume playback' });
const playerTitle = (page: Page, title: string) => page.getByTestId('player').getByText(title, { exact: true });

async function connected(page: Page, server: Fixture, ordered = true) {
  if (ordered) stamp(server.state.snapshot, 1);
  await gotoSession(page, server.origin);
  await expect(pause(page)).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
  if (ordered) stamp(server.state.snapshot, 2);
  server.state.snapshot.session.queue[0].title = 'Authorized initial stream'; server.broadcast();
  await expect(page.getByTitle('Authorized initial stream', { exact: true })).toBeVisible();
}

async function deliverRetiredReply(page: Page, server: Fixture) {
  const reply = page.waitForResponse(response => response.url().endsWith('/commands') && response.status() === 200);
  server.releaseCommandReplies(); await (await reply).finished();
  // Let the actual hook process the response before checking that the newer
  // generation remains selected. No synthetic state injection or hook shim.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}

test('a reply captured after an overlapping live frame completes pause without another GET or SSE connection', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandExecution(); server.holdCommandReplies();
    await pause(page).click(); await expect.poll(() => server.commands.length).toBe(1);
    stamp(server.state.snapshot, 3); server.state.snapshot.session.queue[0].title = 'Frame captured before pause'; server.broadcast();
    await expect(page.getByTitle('Frame captured before pause', { exact: true })).toBeVisible();
    // The prediction stays on screen and usable over an older live frame.
    await expect(resume(page)).toBeEnabled();
    expect(server.state.snapshot.session.status).toBe('playing');
    stamp(server.state.snapshot, 4); server.releaseCommandExecution();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    const reply = [...server.heldCommands.values()][0];
    expect(reply.ordering).toEqual({ instanceId: instance, sequence: 4 });
    expect(reply.session.status).toBe('paused');
    await expect(resume(page)).toBeEnabled();
    server.releaseCommandReplies();
    await expect(resume(page)).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    expect(server.streams.size).toBe(1);
    expect(server.commands).toEqual([{ command: 'pause' }]);
  } finally { await page.close(); await server.close(); }
});

test('an older delayed reply keeps a later Discord selection and capabilities without GET or reconnect', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    expect([...server.heldCommands.values()][0].session.canControl).toBe(true);
    stamp(server.state.snapshot, 4); server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'Later Discord selection';
    server.state.snapshot.session.canControl = false; server.state.snapshot.session.reason = 'Playback controls require the DJ role.';
    server.broadcast(); await expect(playerTitle(page, 'Later Discord selection')).toBeVisible();
    await deliverRetiredReply(page, server);
    await expect(playerTitle(page, 'Later Discord selection')).toBeVisible(); await expect(pause(page)).toBeDisabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    expect(server.streams.size).toBe(1); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

for (const sequence of [1, 2]) {
  test(`late ${sequence === 1 ? 'older' : 'equal'} SSE cannot replace state or extend freshness`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await page.clock.install(); await connected(page, server);
      const reads = server.snapshotReads.length; const events = server.eventReads.length;
      server.holdSnapshotReads(); await page.clock.fastForward(20_000);
      const late = structuredClone(server.state.snapshot); stamp(late, sequence);
      late.session.current!.title = 'Obsolete frame'; late.session.status = 'paused'; server.broadcast(late);
      await expect(playerTitle(page, 'Evening Light')).toBeVisible(); await expect(pause(page)).toBeEnabled();
      expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
      await page.clock.fastForward(5_001);
      await expect(pause(page)).toBeDisabled(); await expect.poll(() => server.capturedSnapshots.size).toBe(1);
      await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(0);
      stamp(server.state.snapshot, 3); server.releaseSnapshotReads(); await expect(pause(page)).toBeEnabled();
    } finally { await page.close(); await server.close(); }
  });
}

test('an equal delayed command reply does not extend the live-frame freshness lease', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.clock.install(); await connected(page, server);
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    // The prediction shows Resume at once, so wait for the live frame itself
    // before moving the clock; its acceptance starts the freshness lease.
    server.state.snapshot.session.queue[0].title = 'Live frame before reply'; server.broadcast();
    await expect(page.getByTitle('Live frame before reply', { exact: true })).toBeVisible(); await expect(resume(page)).toBeEnabled();
    await page.clock.fastForward(20_000); server.releaseCommandReplies(); await expect(resume(page)).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    server.holdSnapshotReads(); await page.clock.fastForward(5_001);
    await expect(resume(page)).toBeDisabled(); await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('a bridge lifetime change requires GET and cannot make an earlier command reply authoritative', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    stamp(server.state.snapshot, 1, nextInstance); server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'New bridge lifetime'; server.holdSnapshotReads(); server.broadcast();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(resume(page)).toBeDisabled();
    await expect(playerTitle(page, 'New bridge lifetime')).toHaveCount(0);
    server.releaseSnapshotReads(); await expect(playerTitle(page, 'New bridge lifetime')).toBeVisible();
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 2);
    await expect(resume(page)).toBeDisabled();
    server.releaseSnapshotReads(); await expect(pause(page)).toBeEnabled();
    await expect(playerTitle(page, 'New bridge lifetime')).toBeVisible(); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('an ordered command from a different instance requires fresh GET even without overlap', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 1, nextInstance);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(resume(page)).toBeDisabled();
    server.releaseSnapshotReads(); await expect(resume(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('ordered reply after browser offline retains the authored input and waits for an online GET without replay', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'Add music', exact: true }).click();
    const input = page.getByRole('searchbox', { name: 'Music search' }); const add = page.getByRole('button', { name: 'Add to queue', exact: true });
    await input.fill('retain this actual submitted input'); server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await add.click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    const reads = server.snapshotReads.length;
    await page.evaluate(() => window.dispatchEvent(new Event('offline'))); server.releaseCommandReplies();
    await expect(page.getByRole('status').filter({ hasText: 'The action completed.' })).toBeVisible();
    await expect(input).toHaveValue('retain this actual submitted input'); await expect(add).toBeDisabled();
    expect(server.snapshotReads).toHaveLength(reads);
    server.holdSnapshotReads(); await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(add).toBeDisabled();
    server.releaseSnapshotReads(); await expect(add).toBeEnabled(); await expect(input).toHaveValue('retain this actual submitted input');
    expect(server.commands).toEqual([{ command: 'play', options: { query: 'retain this actual submitted input' } }]);
  } finally { await page.close(); await server.close(); }
});

test('ordered reply after a 503 stream loss cannot restore controls before a new GET', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.applicationError(503); await expect(resume(page)).toBeDisabled();
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(resume(page)).toBeDisabled();
    stamp(server.state.snapshot, 4); server.releaseSnapshotReads(); await expect(resume(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('an ordered live frame after loss requires a fresh read rather than reopening controls', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.applicationError(503); await expect(pause(page)).toBeDisabled();
    server.holdSnapshotReads(); stamp(server.state.snapshot, 3); server.state.snapshot.session.status = 'paused'; server.broadcast();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(pause(page)).toBeDisabled();
    server.releaseSnapshotReads(); await expect(resume(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('visibility refresh during an ordered command retires the captured GET and starts a post-reply read', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandExecution(); server.holdSnapshotReads();
    await pause(page).click(); await expect.poll(() => server.commands.length).toBe(1);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    expect([...server.capturedSnapshots.values()][0].session.status).toBe('playing');
    stamp(server.state.snapshot, 3); server.releaseCommandExecution();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 2);
    await expect.poll(() => [...server.capturedSnapshots.values()].every(snapshot => snapshot.session.status === 'paused')).toBe(true);
    await expect(resume(page)).toBeDisabled(); server.releaseSnapshotReads(true); await expect(resume(page)).toBeEnabled();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('a completed visibility read cannot erase the loss fence of an outstanding ordered command', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    stamp(server.state.snapshot, 4); server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'State verified by visibility GET';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(playerTitle(page, 'State verified by visibility GET')).toBeVisible();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1); await expect(resume(page)).toBeDisabled();
    server.releaseSnapshotReads(); await expect(pause(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 2); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('guild change retires the old ordered command reply even when its sequence is higher', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    const other = structuredClone(server.state.snapshot);
    other.guild = { ...other.guild, id: 'other', name: 'Other listening space' };
    other.session.current!.title = 'Other guild selection'; stamp(other, 1);
    server.addGuild(other, { ...server.state.configuration, guildId: 'other' });
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 100);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    await page.getByRole('combobox', { name: 'Server', exact: true }).selectOption('other');
    await expect(playerTitle(page, 'Other guild selection')).toBeVisible(); await expect(pause(page)).toBeEnabled();
    const reads = server.snapshotReads.length; await deliverRetiredReply(page, server);
    // A successful native response is delivered after switching; its guild does
    // not become selected again and does not authorize another mutation.
    await expect(playerTitle(page, 'Other guild selection')).toBeVisible(); await expect(pause(page)).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.commands).toHaveLength(1);
    await expect.poll(() => server.streams.size).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test('authoritative 403 clears protected library/player and rejects a delayed high-sequence reply', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'My Music', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toBeEnabled();
    server.holdCommandReplies(); stamp(server.state.snapshot, 100);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    server.applicationError(403);
    await expect(playerTitle(page, 'Evening Light')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toHaveCount(0);
    const reads = server.snapshotReads.length; server.releaseCommandReplies();
    await expect(page.getByRole('status').filter({ hasText: 'The action completed.' })).toBeVisible();
    await expect(playerTitle(page, 'Evening Light')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toHaveCount(0);
    expect(server.snapshotReads).toHaveLength(reads); expect(server.commands).toHaveLength(1);
    await expect.poll(() => server.streams.size).toBe(0);
  } finally { await page.close(); await server.close(); }
});

test('sign-out clears protected state and rejects a delayed ordered command response', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); server.holdCommandReplies(); stamp(server.state.snapshot, 100);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    await page.getByRole('button', { name: 'Account options' }).click();
    await page.getByRole('button', { name: 'Sign out on this device' }).click();
    await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
    await deliverRetiredReply(page, server); await expect(page.getByTestId('player')).toHaveCount(0);
    expect(server.commands).toHaveLength(1); await expect.poll(() => server.streams.size).toBe(0);
  } finally { await page.close(); await server.close(); }
});

test('native history Refresh preserves a healthy ordered stream and playback controls', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'My Music', exact: true }).click(); await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeEnabled();
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    const libraryReads = server.requests.filter(path => path.endsWith('/library')).length;
    server.holdLibraryReads(); await page.getByRole('button', { name: 'Refresh listening history' }).click();
    await expect.poll(() => server.requests.filter(path => path.endsWith('/library')).length).toBe(libraryReads + 1);
    await expect(pause(page)).toBeEnabled();
    server.state.library.history[0].track.title = 'Fresh authorized history'; server.releaseLibraryReads();
    await expect(page.getByRole('button', { name: 'Replay Fresh authorized history' })).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    expect(server.commands).toHaveLength(0); expect(server.streams.size).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test('native autoplay toggle keeps its lifecycle and pending reply while ordered SSE overlaps', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.holdCommandExecution(); server.holdCommandReplies();
    await page.getByRole('button', { name: 'More playback controls' }).click();
    await page.getByRole('button', { name: 'Turn autoplay on', exact: true }).click();
    await expect.poll(() => server.commands.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Turn autoplay on', exact: true })).toHaveCount(0);
    // This HTTP fixture does not implement radio. Supply the native execution
    // outcome before it captures the real, gated command response.
    server.state.snapshot.session.radio = true; stamp(server.state.snapshot, 3); server.releaseCommandExecution();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    expect([...server.heldCommands.values()][0].session.radio).toBe(true);
    stamp(server.state.snapshot, 4); server.broadcast(); await page.getByRole('button', { name: 'More playback controls' }).click();
    const off = page.getByRole('button', { name: 'Turn autoplay off', exact: true });
    await expect(off).toBeEnabled(); server.releaseCommandReplies(); await expect(off).toBeEnabled();
    await page.keyboard.press('Escape'); await expect(off).toHaveCount(0);
    expect(server.commands).toEqual([{ command: 'radio', subcommand: 'on' }]);
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events); expect(server.streams.size).toBe(1);
  } finally { await page.close(); await server.close(); }
});

// Every malformed stamp shape is covered by ordering-stamp.spec.ts; one proves the fallback end to end.
test('a malformed command stamp uses a new GET instead of ordered acceptance', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    server.holdCommandReplies(); stamp(server.state.snapshot, 3);
    await pause(page).click(); await expect.poll(() => server.heldCommands.size).toBe(1);
    const reply = [...server.heldCommands.values()][0];
    Object.assign(reply, { ordering: { instanceId: 'unknown-bridge', sequence: 3 } }); reply.session.current!.title = 'Unverified command response';
    server.holdSnapshotReads(); server.releaseCommandReplies();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    await expect(playerTitle(page, 'Unverified command response')).toHaveCount(0); await expect(resume(page)).toBeDisabled();
    server.releaseSnapshotReads(); await expect(resume(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('a malformed SSE stamp disables writes and independently refreshes instead of renewing freshness', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server); const reads = server.snapshotReads.length;
    const malformed = structuredClone(server.state.snapshot); stamp(malformed, -1); malformed.session.current!.title = 'Malformed frame';
    server.holdSnapshotReads(); server.broadcast(malformed);
    await expect(pause(page)).toBeDisabled(); await expect(playerTitle(page, 'Malformed frame')).toHaveCount(0);
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    stamp(server.state.snapshot, 3); server.releaseSnapshotReads(); await expect(pause(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('legacy snapshots without ordering keep the conservative overlap fallback', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server, false); const reads = server.snapshotReads.length;
    server.holdCommandExecution(); await pause(page).click(); await expect.poll(() => server.commands.length).toBe(1);
    server.state.snapshot.session.queue[0].title = 'Legacy overlapping frame'; server.broadcast();
    await expect(page.getByTitle('Legacy overlapping frame', { exact: true })).toBeVisible();
    server.releaseCommandExecution(); await expect(resume(page)).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1); expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

for (const status of [403, 409, 503]) {
  test(`HTTP ${status} with ordered snapshots still refreshes without replaying the command`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await connected(page, server); const reads = server.snapshotReads.length;
      const bodies: unknown[] = [];
      await page.route('**/api/guilds/testing/commands', async route => {
        bodies.push(route.request().postDataJSON());
        await route.fulfill({ status, json: { error: { code: status === 409 ? 'stale_revision' : status === 403 ? 'forbidden' : 'unavailable', message: 'Verify current state before another action.' } } });
      });
      server.holdSnapshotReads(); await pause(page).click(); await expect.poll(() => server.capturedSnapshots.size).toBe(1);
      await expect(pause(page)).toBeDisabled(); server.releaseSnapshotReads(); await expect(pause(page)).toBeEnabled();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
      expect(bodies).toEqual([{ command: 'pause' }]);
    } finally { await page.close(); await server.close(); }
  });
}
