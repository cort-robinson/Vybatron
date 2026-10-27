import { test, expect, type Page } from './test';
import { gotoSession } from './fixtures';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const snapshotPath = '/api/guilds/testing';

test('an exact command result already verified by SSE avoids another snapshot GET', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    server.holdCommandReplies();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    server.broadcast();
    // The prediction is on screen and usable while the reply is held.
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    server.releaseCommandReplies();
    await expect(page.getByTestId('player').getByText('Syncing with Discord…')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads);
    expect(server.commands).toHaveLength(1);
    await expect.poll(() => server.streams.size).toBe(1);
  } finally { await page.close(); await server.close(); }
});

test('same revision with changed permissions cannot use the exact-result shortcut', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    server.holdCommandReplies();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    server.state.snapshot.session.canControl = false;
    server.state.snapshot.session.reason = 'Playback controls require the DJ role.';
    server.broadcast();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
    server.releaseCommandReplies();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    await expect.poll(() => server.streams.size).toBe(1);
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

async function connected(page: Page, server: Fixture) {
  await gotoSession(page, server.origin);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
  server.state.snapshot.session.queue[0].title = 'Stream-confirmed Night Drive';
  server.broadcast();
  await expect(page.getByTitle('Stream-confirmed Night Drive', { exact: true })).toBeVisible();
}

test('startup snapshot 503 recovers with bounded reads instead of remaining Connecting', async ({ page }) => {
  const server = await startHttpFixture({ initialSnapshotFailures: 2 });
  try {
    await gotoSession(page, server.origin);
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
    await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect.poll(() => server.streams.size).toBe(1);
    expect(server.snapshotReads).toHaveLength(3);
    expect(server.snapshotReads[1] - server.snapshotReads[0]).toBeGreaterThanOrEqual(900);
    expect(server.snapshotReads[2] - server.snapshotReads[1]).toBeGreaterThanOrEqual(1900);
    expect(server.eventReads).toHaveLength(1);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('identify/bootstrap 503 also recovers without changing or replaying music', async ({ page }) => {
  const server = await startHttpFixture({ initialBootstrapFailures: 1 });
  try {
    await page.goto(server.origin);
    await expect(page.getByText('Discord verification is temporarily unavailable.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    expect(server.requests.filter(path => path === '/api/bootstrap')).toHaveLength(2);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('429 read recovery respects Retry-After without creating extra streams', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    // A wide Retry-After keeps the paused state on screen long enough to act on, however slowly the runner renders.
    server.failNextSnapshotReads(1, 429, '6');
    await gotoSession(page, server.origin);
    await expect(page.getByText('Live updates paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect.poll(() => server.streams.size).toBe(1);
    expect(server.snapshotReads).toHaveLength(2);
    expect(server.snapshotReads[1] - server.snapshotReads[0]).toBeGreaterThanOrEqual(5900);
    expect(server.eventReads).toHaveLength(1);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('a pre-mutation SSE frame cannot discard a slow pause command result', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length; const revision = server.state.snapshot.revision;
    server.holdCommandExecution();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect.poll(() => server.commands.length).toBe(1);
    server.state.snapshot.session.queue[0].title = 'Frame produced before pause'; server.broadcast();
    await expect(page.getByTitle('Frame produced before pause', { exact: true })).toBeVisible();
    server.releaseCommandExecution();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    expect(server.commands).toEqual([{ command: 'pause' }]);
    expect(server.state.snapshot.session.status).toBe('paused');
    expect(server.state.snapshot.revision).not.toBe(revision);
  } finally { await page.close(); await server.close(); }
});

test('a delayed command snapshot cannot replace a later Discord state', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    server.holdCommandReplies();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    server.state.snapshot.revision = 'later-discord-revision';
    server.state.snapshot.session.status = 'playing';
    server.state.snapshot.session.current!.title = 'Later Discord selection'; server.broadcast();
    await expect(page.getByTestId('player').getByText('Later Discord selection', { exact: true })).toBeVisible();
    server.releaseCommandReplies();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(page.getByTestId('player').getByText('Later Discord selection', { exact: true })).toBeVisible();
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('a slow quiet check started during a command is discarded once the command lands', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    server.holdCommandExecution(); server.holdSnapshotReads();
    await page.getByRole('button', { name: 'Pause playback' }).click();
    await expect.poll(() => server.commands.length).toBe(1);
    const reads = server.snapshotReads.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    expect([...server.capturedSnapshots.values()][0].session.status).toBe('playing');
    // Returning to a fresh session doesn't lock anything while it checks.
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    server.releaseCommandExecution();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    // The check began before the pause landed, so its older answer can't undo it.
    server.releaseSnapshotReads(true);
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads + 1);
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

test('manual reconnect retains the player and typed input until a genuinely fresh read', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    server.disconnectAndHold();
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toBeVisible();
    await expect(page.getByTitle('Stream-confirmed Night Drive', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add music', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Music search' }).fill('a retained public playlist input');
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    server.releaseFreshSnapshot();
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
    await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('a retained public playlist input');
    await expect.poll(() => server.streams.size).toBe(1);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('an application 503 on an open native stream respects server recovery without probes or reconnects', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length; const events = server.eventReads.length;
    server.applicationError(503);
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toBeVisible();
    await page.waitForTimeout(1100);
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    expect(server.streams.size).toBe(1);
    server.state.snapshot.session.status = 'paused'; server.state.snapshot.revision = 'fresh-after-open-stream-503'; server.broadcast();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    expect(server.snapshotReads).toHaveLength(reads); expect(server.eventReads).toHaveLength(events);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

// 403 and 404 share one access-loss branch; 401 additionally signs out.
for (const status of [401, 403]) {
  test(`an application ${status} frame clears protected data without waiting for a network close`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await connected(page, server);
      await page.getByRole('button', { name: 'My Music', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toBeEnabled();
      const reads = server.snapshotReads.length;
      server.applicationError(status);
      if (status === 401) await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
      await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toHaveCount(0);
      expect(server.snapshotReads).toHaveLength(reads);
      expect(server.commands).toHaveLength(0);
      await expect.poll(() => server.streams.size).toBe(0);
    } finally { await page.close(); await server.close(); }
  });
}

test('browser offline/online invalidates a captured GET and never replays a write', async ({ page, context }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'Add music', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Music search' }).fill('phone input survives real offline');
    server.holdSnapshotReads();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    await context.setOffline(true);
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
    server.releaseSnapshotReads(true);
    await page.waitForTimeout(1100);
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
    server.state.snapshot.session.status = 'paused'; server.state.snapshot.revision = 'after-browser-offline';
    const reads = server.snapshotReads.length;
    await context.setOffline(false);
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('phone input survives real offline');
    expect(server.snapshotReads.length).toBeGreaterThan(reads);
    await expect.poll(() => server.streams.size).toBe(1);
    expect(server.commands).toHaveLength(0);
  } finally { await context.setOffline(false); await page.close(); await server.close(); }
});

test('a confirmed command reply after disconnect keeps its form draft until state is verified', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'Add music', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Music search' }).fill('confirmed input during transport loss');
    server.holdCommandReplies();
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect.poll(() => server.heldCommands.size).toBe(1);
    // Deliver the real HTTP reply while simulating the browser's offline event;
    // the write completed, but its pre-disconnect snapshot is not fresh state.
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    server.releaseCommandReplies();
    await expect(page.getByRole('status').filter({ hasText: 'The action completed.' })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('confirmed input during transport loss');
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
    await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('confirmed input during transport loss');
    expect(server.commands).toHaveLength(1);
  } finally { await page.close(); await server.close(); }
});

for (const status of [401, 403]) {
  test(`HTTP ${status} after disconnect clears protected data and rejects a delayed command snapshot`, async ({ page }) => {
    const server = await startHttpFixture();
    try {
      await connected(page, server);
      server.holdCommandReplies();
      await page.getByRole('button', { name: 'Pause playback' }).click();
      await expect.poll(() => server.heldCommands.size).toBe(1);
      await page.getByRole('button', { name: 'My Music', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toBeVisible();
      server.denyAccess(status);
      if (status === 401) await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible();
      else await expect(page.getByText('You no longer have access to this listening space.', { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toHaveCount(0);
      server.releaseCommandReplies();
      await page.waitForTimeout(1100);
      await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove favorite Evening Light' })).toHaveCount(0);
      expect(server.commands).toHaveLength(1);
      expect(server.streams.size).toBe(0);
    } finally { await page.close(); await server.close(); }
  });
}

test('an unchanged-revision hidden-channel projection clears the older player and history', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    await page.getByRole('button', { name: 'My Music', exact: true }).click();
    await page.getByRole('tab', { name: /History/ }).click();
    await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toBeEnabled();
    const session = server.state.snapshot.session;
    Object.assign(session, { status: 'idle', current: null, queue: [], listeners: [], voiceChannel: null, textChannel: null, canAdd: false, canControl: false, canVote: false, reason: 'The music channel is no longer visible.' });
    server.state.library.history = []; server.holdLibraryReads(); server.broadcast();
    await expect(page.getByTestId('player').getByText('Evening Light', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Replay Afterglow' })).toHaveCount(0);
    server.releaseLibraryReads();
    await expect(page.getByRole('heading', { name: /Your server.*story starts here/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeDisabled();
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('authenticated native SSE stays synchronized past the old policy interval without duplicate GETs', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.clock.install(); await connected(page, server);
    const reads = server.snapshotReads.length;
    // Each live frame renews the 25 s freshness lease, so 40 s of frames needs no GET.
    for (const [status, name] of [['paused', 'Resume playback'], ['playing', 'Pause playback']] as const) {
      await page.clock.fastForward(20_000);
      server.state.snapshot.session.status = status; server.state.snapshot.revision = `discord-${status}-after-policy-interval`;
      server.broadcast();
      await expect(page.getByRole('button', { name })).toBeEnabled();
    }
    await page.clock.fastForward(20_000);
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect(page.getByText('Live updates paused', { exact: true })).toHaveCount(0);
    expect(server.snapshotReads).toHaveLength(reads);
    expect(server.eventReads).toHaveLength(1);
    expect(server.streams.size).toBe(1);
    expect(server.requests.filter(path => path === snapshotPath)).toHaveLength(1);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});

test('a silent stream expires freshness and accepts recovery GET state without an onopen refresh', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.clock.install(); await connected(page, server);
    const reads = server.snapshotReads.length;
    server.holdSnapshotReads();
    await page.clock.fastForward(25_001);
    await expect(page.getByRole('button', { name: 'Pause playback' })).toBeDisabled();
    await expect.poll(() => server.capturedSnapshots.size).toBe(1);
    server.state.snapshot.session.status = 'paused'; server.state.snapshot.revision = 'after-silent-stream';
    server.releaseSnapshotReads();
    await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
    await expect.poll(() => server.streams.size).toBe(1);
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    expect(server.commands).toHaveLength(0);
  } finally { await page.close(); await server.close(); }
});
