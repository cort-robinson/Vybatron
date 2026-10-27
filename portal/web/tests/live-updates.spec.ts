import { test, expect, type Page } from './test';
import { gotoSession } from './fixtures';
import type { GuildSnapshot } from '../src/types';
import { startHttpFixture } from './http-fixture';

type Fixture = Awaited<ReturnType<typeof startHttpFixture>>;
const instanceId = '748c50dc-f3f0-4bb5-8b57-692912648dc6';
const stamp = (snapshot: GuildSnapshot, sequence: number) => { snapshot.ordering = { instanceId, sequence }; };
const pause = (page: Page) => page.getByRole('button', { name: 'Pause playback' });

async function connected(page: Page, server: Fixture) {
  await page.clock.install();
  stamp(server.state.snapshot, 1);
  await gotoSession(page, server.origin);
  await expect(pause(page)).toBeEnabled();
  await expect.poll(() => server.streams.size).toBe(1);
}

test('unchanged events keep controls live past the freshness lease without a read or a new stream', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    for (const sequence of [2, 3]) {
      await page.clock.fastForward(20_000);
      server.emitEvent('unchanged', { revision: server.state.snapshot.revision, ordering: { instanceId, sequence } });
      await expect(pause(page)).toBeEnabled();
    }
    await page.clock.fastForward(20_000);
    await expect(pause(page)).toBeEnabled();
    await expect(page.getByText('Live updates paused', { exact: true })).toHaveCount(0);
    expect(server.snapshotReads).toHaveLength(reads);
    expect(server.eventReads).toHaveLength(1);
    // Without renewals the lease ends.
    await page.clock.fastForward(25_001);
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
  } finally { await page.close(); await server.close(); }
});

test('an unchanged event that does not match the state on screen gets a fresh read', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    server.emitEvent('unchanged', { revision: 'some-other-revision', ordering: { instanceId, sequence: 2 } });
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    await expect(pause(page)).toBeEnabled();
    // An older or equal stamp renews nothing and needs no read.
    const after = server.snapshotReads.length;
    server.emitEvent('unchanged', { revision: server.state.snapshot.revision, ordering: { instanceId, sequence: 1 } });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(server.snapshotReads).toHaveLength(after);
  } finally { await page.close(); await server.close(); }
});

test('a rotated stream reconnects at once with controls live and no extra read', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    stamp(server.state.snapshot, 2); server.state.snapshot.session.queue[0].title = 'Delivered by the next stream';
    server.emitEvent('rotate', {});
    await expect(pause(page)).toBeEnabled();
    await expect(page.getByTitle('Delivered by the next stream', { exact: true })).toBeVisible();
    expect(server.eventReads).toHaveLength(2);
    await expect.poll(() => server.streams.size).toBe(1);
    await page.clock.fastForward(6000);
    expect(server.snapshotReads).toHaveLength(reads);
    await expect(page.getByText('Live updates paused', { exact: true })).toHaveCount(0);
  } finally { await page.close(); await server.close(); }
});

test('a rotated stream that stays silent falls back to a fresh read', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await connected(page, server);
    const reads = server.snapshotReads.length;
    server.holdSnapshotReads();
    server.emitEvent('rotate', {});
    await expect.poll(() => server.eventReads.length).toBe(2);
    await expect(pause(page)).toBeEnabled();
    await page.clock.fastForward(5001);
    await expect.poll(() => server.snapshotReads.length).toBe(reads + 1);
    stamp(server.state.snapshot, 3); server.releaseSnapshotReads();
    await expect(pause(page)).toBeEnabled();
  } finally { await page.close(); await server.close(); }
});
