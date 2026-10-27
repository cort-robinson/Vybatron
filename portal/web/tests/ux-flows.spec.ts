import { test, expect, cssScene, type Locator, type Page } from './test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mockPortal } from './fixtures';

// Task-flow cost for the UX hill climb. On demand only: `UX_LABEL=<name> npx playwright test ux-flows`.
// Each task is driven through the real UI from Home; every step records what the user had to do.
test.skip(!process.env.UX_LABEL, 'UX flow measurement runs on demand.');

type Step = { kind: 'tap' | 'type' | 'menu' | 'nav'; label: string; scrolled: boolean; reach: 'easy' | 'stretch'; x: number; y: number };
type Ctx = { page: Page; phone: boolean; steps: Step[] };
const viewports = [{ name: 'desktop', width: 1488, height: 1056, phone: false }, { name: 'phone', width: 393, height: 852, phone: true }];

async function act(ctx: Ctx, target: Locator, kind: Step['kind'] = 'tap', text?: string) {
  const el = target.first();
  await expect(el).toBeAttached();
  const before = await el.boundingBox();
  const viewport = ctx.page.viewportSize()!;
  const scrolled = !before || before.y < 0 || before.y + before.height > viewport.height;
  if (scrolled) await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  // Phone reach: the top third is a stretch one-handed (Hoober's thumb-zone research).
  // A field that already has the cursor is typed into without reaching for it.
  const focused = kind === 'type' && await el.evaluate(node => node === document.activeElement);
  const reach = ctx.phone && !focused && box.y + box.height / 2 < viewport.height / 3 ? 'stretch' : 'easy';
  const label = (await el.getAttribute('aria-label')) || (await el.innerText().catch(() => '')).trim().split('\n')[0] || kind;
  ctx.steps.push({ kind, label: label.slice(0, 40), scrolled, reach, x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
  if (kind === 'type') await el.fill(text!); else await el.click();
  await ctx.page.waitForTimeout(250);
}
const role = (page: Page, name: string | RegExp, kind: Parameters<Page['getByRole']>[0] = 'button') => page.getByRole(kind, { name, exact: typeof name === 'string' }).filter({ visible: true });
const openPlayer = async (ctx: Ctx) => act(ctx, await role(ctx.page, 'Open player').count() ? role(ctx.page, 'Open player') : role(ctx.page, /^Open player for/));
const nav = (ctx: Ctx, name: string) => act(ctx, role(ctx.page, name), 'nav');
const more = async (ctx: Ctx) => { if (!(await role(ctx.page, 'More playback controls').count())) await openPlayer(ctx); await act(ctx, role(ctx.page, 'More playback controls'), 'menu'); };
const openSearch = async (ctx: Ctx) => { if (!ctx.phone) return act(ctx, role(ctx.page, 'Search music')); if (await role(ctx.page, 'Search').count()) return nav(ctx, 'Search'); return act(ctx, role(ctx.page, 'Add music')); };
// The shortest route the UI offers: a control on the row, else the row's menu.
const direct = async (ctx: Ctx, name: RegExp, menu: RegExp, item: string) => { const quick = role(ctx.page, name); if (await quick.count()) return act(ctx, quick); await act(ctx, role(ctx.page, menu), 'menu'); await act(ctx, role(ctx.page, item)); };
const queuePage = async (ctx: Ctx) => nav(ctx, await role(ctx.page, 'Queue').count() ? 'Queue' : 'Session');
const account = async (ctx: Ctx, item: string) => { await act(ctx, role(ctx.page, 'Account options'), 'menu'); await act(ctx, role(ctx.page, item)); };

export const tasks: Record<string, (ctx: Ctx) => Promise<void>> = {
  'Add a searched song': async ctx => { await openSearch(ctx); await act(ctx, ctx.page.getByRole('searchbox', { name: 'Music search' }), 'type', 'Midnight City'); await act(ctx, role(ctx.page, /^Add Midnight City/)); },
  'Search a song and play it next': async ctx => {
    await openSearch(ctx); await act(ctx, ctx.page.getByRole('searchbox', { name: 'Music search' }), 'type', 'Midnight City');
    await expect(role(ctx.page, /^Add Midnight City/).first()).toBeVisible();
    const inline = role(ctx.page, /^Play Midnight City next/);
    if (await inline.count()) { await act(ctx, inline); return; }
    await act(ctx, role(ctx.page, /^Add Midnight City/)); await act(ctx, role(ctx.page, 'Close dialog'));
    await queuePage(ctx); await direct(ctx, /^Play Midnight City next/, /^Song options for Midnight City/, 'Play next');
  },
  'Favorite the current song': async ctx => {
    const heart = role(ctx.page, /current song (to|from) favorites/);
    if (!(await heart.count())) await openPlayer(ctx);
    await act(ctx, role(ctx.page, /current song (to|from) favorites/));
  },
  'Queue a favorite': async ctx => { await nav(ctx, 'My Music'); await act(ctx, role(ctx.page, /^Queue favorite Night Drive/)); },
  'Play a queued song next': async ctx => { await queuePage(ctx); await direct(ctx, /^Play Afterglow next/, /^Song options for Afterglow/, 'Play next'); },
  'Remove a queued song': async ctx => { await queuePage(ctx); await direct(ctx, /^Remove Afterglow from queue/, /^Song options for Afterglow/, 'Remove from queue'); },
  'See what plays next': async ctx => { if (ctx.phone) { await openPlayer(ctx); await act(ctx, ctx.page.locator('.up-next-handle')); } else await queuePage(ctx); },
  'Show lyrics': async ctx => { await openPlayer(ctx); await act(ctx, role(ctx.page, 'Show lyrics')); },
  'Queue a shared mix': async ctx => { await nav(ctx, 'My Music'); await act(ctx, ctx.page.getByRole('tab', { name: /Shared mixes/ })); await act(ctx, role(ctx.page, 'Queue mix')); },
  'Save the session as a mix': async ctx => {
    await queuePage(ctx); await act(ctx, role(ctx.page, /Save session as mix/));
    await act(ctx, ctx.page.getByRole('dialog').getByRole('textbox').first(), 'type', 'Friday'); await act(ctx, ctx.page.getByRole('dialog').getByRole('button', { name: /^Save/ }));
  },
  'Set a sleep timer': async ctx => { await more(ctx); await act(ctx, role(ctx.page, /^Sleep timer/)); await act(ctx, role(ctx.page, 'When this song ends')); },
  'Play on this device': async ctx => { await more(ctx); await act(ctx, ctx.page.getByRole('button', { name: /This device/ }).filter({ visible: true })); await act(ctx, role(ctx.page, 'Listen here too')); },
  'Change the portal look': async ctx => {
    if (await role(ctx.page, 'Open settings').count()) await act(ctx, role(ctx.page, 'Open settings'));
    else if (await ctx.page.getByLabel('Portal look').count() === 0 && await role(ctx.page, 'Server').count()) await nav(ctx, 'Server');
    else await account(ctx, 'Settings');
    await act(ctx, ctx.page.getByLabel('Portal look'));
  },
  'Switch server': async ctx => { await act(ctx, ctx.page.getByRole('combobox', { name: 'Server' }).filter({ visible: true })); },
  'Sign out': async ctx => {
    if (await role(ctx.page, 'Account options').count()) return account(ctx, 'Sign out on this device');
    await nav(ctx, 'Server'); await act(ctx, role(ctx.page, 'Sign out'));
  },
};

// Cost: every action is 1; opening a menu, changing page, scrolling to find a control and a
// one-handed stretch each add a half, because they are where people get lost or slow down.
const cost = (steps: Step[]) => steps.length + steps.filter(s => s.kind === 'menu' || s.kind === 'nav').length * .5 + steps.filter(s => s.scrolled).length * .5 + steps.filter(s => s.reach === 'stretch').length * .5;

for (const v of viewports) {
  test(`flows ${v.name}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const results: Record<string, { cost: number; steps: Step[] } | { error: string }> = {};
    for (const [name, run] of Object.entries(tasks)) {
      const context = await browser.newContext({ viewport: { width: v.width, height: v.height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addInitScript(cssScene);
      const page = await context.newPage(); await mockPortal(page); await page.goto(String(test.info().project.use.baseURL));
      await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
      const ctx: Ctx = { page, phone: v.phone, steps: [] };
      try { await run(ctx); results[name] = { cost: cost(ctx.steps), steps: ctx.steps }; } catch (error) { results[name] = { error: String(error).split('\n')[0].slice(0, 200) }; }
      await context.close();
    }
    const directory = fileURLToPath(new URL(`../.impeccable/score/${process.env.UX_LABEL}/`, import.meta.url)); await mkdir(directory, { recursive: true });
    const costs = Object.values(results).map(r => 'cost' in r ? r.cost : 0);
    await writeFile(`${directory}flows-${v.name}.json`, JSON.stringify({ viewport: v.name, total: costs.reduce((a, b) => a + b, 0), results }, null, 2));
  });
}
