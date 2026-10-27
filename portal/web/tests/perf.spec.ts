import { expect, test, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';

type Row = { metric: string; count: number; p50: number; p95: number; max: number };
const rows = (page: Page) => page.evaluate(() => (window as unknown as { __vybPerf?: () => Row[] }).__vybPerf?.() ?? null);

test('latency measurement is off by default and leaves no global, marks or measures', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  await page.getByTestId('player').getByRole('button', { name: 'Pause playback', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('pause');
  expect(await rows(page)).toBeNull();
  expect(await page.evaluate(() => performance.getEntriesByType('measure').filter(entry => entry.name.startsWith('vyb:')).length)).toBe(0);
});

test('?perf records boot, tap and per-request timings without identifiers', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page, '/?perf');
  await expect.poll(async () => (await rows(page))?.some(row => row.metric === 'vyb:boot→interactive')).toBe(true);
  await page.getByTestId('player').getByRole('button', { name: 'Pause playback', exact: true }).click();
  await expect.poll(() => fixture.commands.at(-1)?.command).toBe('pause');
  await expect.poll(async () => (await rows(page))?.map(row => row.metric) ?? []).toEqual(expect.arrayContaining([
    'vyb:tap→paint pause', 'vyb:tap→confirmed pause', 'api bootstrap', 'api guilds/:id', 'api guilds/:id/commands',
  ]));
  const summary = (await rows(page))!;
  for (const row of summary) {
    expect(row.count).toBeGreaterThan(0);
    expect(row.p50).toBeLessThanOrEqual(row.p95);
    expect(row.metric).not.toMatch(/\d{5,}/);
  }
  // DevTools sees the same measures on the performance timeline.
  expect(await page.evaluate(() => performance.getEntriesByName('vyb:tap→paint').length)).toBe(1);
});
