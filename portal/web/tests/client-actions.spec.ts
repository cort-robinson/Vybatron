import { test, expect, type Page } from './test';
import { gotoSession, mockPortal, streamAction } from './fixtures';

// What the listener sees between a tap and its result: nothing waits on a
// change it doesn't depend on, and the screen answers before the bot does.
const player = (page: Page) => page.getByTestId('player');
const queued = (page: Page) => page.locator('.queue:not(.queue-compact) .track-list:not(.suggested-list) .track-row strong').allTextContents();
const count = (requests: string[], suffix: string) => requests.filter(path => path.endsWith(suffix)).length;
// Leave the app and come straight back, as a phone does when switching apps.
async function leaveAndReturn(page: Page) {
  await page.evaluate(() => {
    const show = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    show(true); show(false);
  });
}
// Records whether a selector ever appeared, however briefly.
async function watchFor(page: Page, selector: string) {
  await page.evaluate(selector => {
    const seen = window as unknown as { seen: boolean };
    seen.seen = !!document.querySelector(selector);
    new MutationObserver(() => { if (document.querySelector(selector)) seen.seen = true; }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, selector);
  return () => page.evaluate(() => (window as unknown as { seen: boolean }).seen);
}

test('returning to the app with fresh state keeps every control usable and reads only quietly', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  const pause = player(page).getByRole('button', { name: 'Pause playback' });
  await expect(pause).toBeEnabled();
  await expect.poll(() => count(fixture.requests, '/library')).toBe(1);
  const snapshots = () => fixture.requests.filter(path => path === '/api/guilds/testing').length;
  const before = snapshots();
  const banner = await watchFor(page, '.connection-banner');
  fixture.delaySnapshot(1500);
  await leaveAndReturn(page);
  // The quiet check is on its way, and nothing waits for it.
  await expect.poll(snapshots).toBe(before + 1);
  await expect(pause).toBeEnabled();
  await expect(player(page).getByRole('button', { name: 'Skip current song' })).toBeEnabled();
  await pause.click();
  await expect(player(page).getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['pause']);
  await page.waitForTimeout(1800);
  expect(await banner()).toBe(false);
  // The library was read moments ago, so coming back doesn't read it again.
  expect(count(fixture.requests, '/library')).toBe(1);
});

test('the heart flips before the bot answers, and playback stays usable meanwhile', async ({ page }) => {
  const fixture = await mockPortal(page);
  const current = fixture.state.snapshot.session.current!;
  await gotoSession(page);
  const saved = player(page).getByRole('button', { name: 'Remove current song from favorites' });
  await expect(saved).toBeEnabled();
  const reads = count(fixture.requests, '/library');
  const release = fixture.holdCommands();
  await saved.click();
  const unsaved = player(page).getByRole('button', { name: 'Save current song to favorites' });
  await expect(unsaved).toHaveAttribute('aria-pressed', 'false');
  expect(fixture.commands).toEqual([{ command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: current.id }]);
  expect(count(fixture.requests, '/library')).toBe(reads);
  // A library change travels beside playback: Pause goes out while it's still waiting.
  await expect(player(page).getByText('Waiting for confirmation')).toHaveCount(0);
  await player(page).getByRole('button', { name: 'Pause playback' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['favorite', 'pause']);
  release();
  await expect(player(page).getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  // Confirmed, then the library is re-read quietly behind what's already shown.
  await expect.poll(() => count(fixture.requests, '/library')).toBeGreaterThan(reads);
  await expect(unsaved).toBeVisible();
  expect(fixture.state.library.favorites.some(track => track.id === current.id)).toBe(false);
});

test('a heart the bot refuses goes back and says why', async ({ page }) => {
  await mockPortal(page);
  let refuse!: () => void; const refused = new Promise<void>(resolve => { refuse = resolve; });
  await page.route('**/api/guilds/testing/commands', async route => {
    if (route.request().postDataJSON().command !== 'favorite') { await route.fallback(); return; }
    await refused;
    await route.fulfill({ status: 400, json: { error: { code: 'invalid_selection', message: 'Your favorites couldn’t be changed right now.' } } });
  });
  await gotoSession(page);
  await player(page).getByRole('button', { name: 'Remove current song from favorites' }).click();
  await expect(player(page).getByRole('button', { name: 'Save current song to favorites' })).toBeVisible();
  refuse();
  await expect(page.getByRole('alert')).toContainText('Your favorites couldn’t be changed right now.');
  await expect(player(page).getByRole('button', { name: 'Remove current song from favorites' })).toHaveAttribute('aria-pressed', 'true');
});

test('a rapid double tap on the heart ends where the last tap left it', async ({ page }) => {
  const fixture = await mockPortal(page);
  const current = fixture.state.snapshot.session.current!;
  await gotoSession(page);
  const release = fixture.holdCommands();
  await player(page).getByRole('button', { name: 'Remove current song from favorites' }).click();
  await player(page).getByRole('button', { name: 'Save current song to favorites' }).click();
  await expect(player(page).getByRole('button', { name: 'Remove current song from favorites' })).toHaveAttribute('aria-pressed', 'true');
  expect(fixture.commands).toHaveLength(1);
  release();
  await expect.poll(() => fixture.commands.map(command => `${command.command}:${command.subcommand}`)).toEqual(['favorite:remove', 'favorite:add']);
  await expect.poll(() => fixture.state.library.favorites.filter(track => track.id === current.id).length).toBe(1);
  await expect(player(page).getByRole('button', { name: 'Remove current song from favorites' })).toHaveAttribute('aria-pressed', 'true');
});

test('a tap behind a change the bot must confirm waits its turn instead of being dropped', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  const release = fixture.holdCommands();
  // Saving a queued song binds to the queue shown, so it goes in the session's line.
  await page.getByRole('button', { name: 'Save Slow Motion to favorites' }).click();
  await expect(page.getByRole('button', { name: 'Remove Slow Motion from favorites' })).toBeVisible();
  const skip = player(page).getByRole('button', { name: 'Skip current song' });
  await expect(skip).toBeEnabled();
  await skip.click();
  // The skip shows at once, and says it's queued behind the save.
  await expect(player(page).locator('.compact-track-title')).toHaveText('Night Drive');
  await expect(player(page).locator('.player-confirmation')).toContainText('Waiting for confirmation · 1 queued');
  expect(fixture.commands.map(command => command.command)).toEqual(['favorite']);
  expect(fixture.commands[0]).toMatchObject({ subcommand: 'add', options: { position: 2 }, expectedRevision: 'revision-1' });
  release();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['favorite', 'skip']);
  // Sent against the state the save produced, not a self-made conflict.
  expect(fixture.commands[1].expectedRevision).toBe('revision-2');
});

test('queued library additions go out in order, and a repeated tap is recognized', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  const first = page.getByRole('button', { name: 'Queue favorite Night Drive' });
  await expect(first).toBeEnabled();
  const release = fixture.holdCommands();
  await first.click();
  await expect.poll(() => fixture.commands.length).toBe(1);
  const second = page.getByRole('button', { name: 'Queue favorite Evening Light' });
  await expect(second).toBeEnabled();
  await second.click();
  await expect(page.getByRole('status').filter({ hasText: 'Queued. It’s sent once your earlier change is confirmed.' })).toBeVisible();
  await first.click();
  await expect(page.getByRole('status').filter({ hasText: 'That change is already on its way.' })).toBeVisible();
  expect(fixture.commands).toHaveLength(1);
  release();
  await expect.poll(() => fixture.commands.map(command => command.options?.index)).toEqual([1, 2]);
  expect(fixture.commands.every(command => command.command === 'favorite' && command.subcommand === 'play')).toBe(true);
});

test('Play next, suggestion edits and a repeat-queue skip show at once', async ({ page }) => {
  const fixture = await mockPortal(page, { suggested: true });
  const neon = { id: 'neon-tide-1', title: 'Neon Tide', author: 'Harbor Lights', uri: 'https://www.youtube.com/watch?v=neon-tide-1', source: 'youtube', durationMs: 201_000, artworkUrl: null, isStream: false, requestedBy: null };
  await page.route('**/api/guilds/testing/search?*', route => route.fulfill({ json: { tracks: [neon], notice: null } }));
  await gotoSession(page);
  let release = fixture.holdCommands();
  // A suggestion leaves the list at once.
  await page.getByRole('button', { name: 'Suggestion options for City Lights' }).click();
  await page.getByRole('button', { name: 'Remove suggestion' }).click();
  await expect(page.locator('.queue:not(.queue-compact) .suggested-row', { hasText: 'City Lights' })).toHaveCount(0);
  release();
  await expect.poll(() => fixture.commands.map(command => command.subcommand)).toEqual(['remove']);

  // A chosen result played next appears at the front at once.
  release = fixture.holdCommands();
  await page.getByRole('button', { name: 'Add music', exact: true }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('harbor lights');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: 'Play Neon Tide next' }).click();
  await expect.poll(() => queued(page)).toEqual(['Neon Tide', 'Night Drive']);
  expect(fixture.commands.at(-1)).toMatchObject({ command: 'playnext', options: { query: neon.uri }, expectedRevision: 'revision-2' });
  release();
  await page.keyboard.press('Escape');

  // Repeating the queue: Skip moves the song that was playing to its end.
  const repeating = structuredClone(fixture.state.snapshot);
  repeating.revision = 'revision-repeat'; repeating.session.repeat = 'queue';
  fixture.state.snapshot = repeating;
  await streamAction(page, 'reconnect', repeating);
  await expect(player(page).getByRole('button', { name: /Repeat: queue/ })).toBeVisible();
  const order = await queued(page);
  release = fixture.holdCommands();
  await player(page).getByRole('button', { name: 'Skip current song' }).click();
  await expect(player(page).locator('.compact-track-title')).toHaveText(order[0]);
  await expect.poll(() => queued(page)).toEqual([...order.slice(1), 'Evening Light']);
  release();
});

test('a refused suggestion edit comes back with the reason', async ({ page }) => {
  await mockPortal(page, { suggested: true });
  await page.route('**/api/guilds/testing/commands', async route => {
    if (route.request().postDataJSON().command !== 'radio') { await route.fallback(); return; }
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.fulfill({ status: 400, json: { error: { code: 'invalid_options', message: 'That suggestion couldn’t be removed.' } } });
  });
  await gotoSession(page);
  const row = page.locator('.queue:not(.queue-compact) .suggested-row', { hasText: 'Low Tide' });
  await page.getByRole('button', { name: 'Suggestion options for Low Tide' }).click();
  await page.getByRole('button', { name: 'Remove suggestion' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('That suggestion couldn’t be removed.');
  await expect(row).toHaveCount(1);
});

test('Home and Server favorites share one stats read, and Home comes back without a spinner', async ({ page }) => {
  const fixture = await mockPortal(page);
  // Stats and the recap start with the server, not after the first snapshot.
  fixture.delaySnapshot(2500);
  await page.goto('/');
  await expect.poll(() => count(fixture.requests, '/stats') + fixture.recapWindows.length, { timeout: 2000 }).toBe(2);
  expect(fixture.requests.filter(path => path === '/api/guilds/testing')).toHaveLength(1);
  await expect(page.getByRole('heading', { name: 'On repeat in this server' })).toBeVisible();
  await expect(page.locator('.recap-grid')).toBeVisible();
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('tab', { name: 'Server favorites' }).click();
  await expect(page.getByRole('region', { name: 'On repeat' }).getByRole('listitem')).toHaveCount(4);
  const spinner = await watchFor(page, '.home-view .loading-state');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.recap-grid')).toBeVisible();
  await expect(page.getByText('Loading your listening recap…')).toHaveCount(0);
  expect(await spinner()).toBe(false);
  expect(count(fixture.requests, '/stats')).toBe(1);
  expect(fixture.recapWindows).toEqual(['30d']);
});

test('rapid song changes read history once they settle', async ({ page }) => {
  const fixture = await mockPortal(page);
  await gotoSession(page);
  await expect.poll(() => count(fixture.requests, '/library')).toBe(1);
  const tracks = fixture.state.snapshot.session.queue;
  // Three songs in quick succession, as rapid skips arrive from Discord.
  const frames = tracks.slice(0, 3).map((track, index) => {
    const next = structuredClone(fixture.state.snapshot);
    next.revision = `revision-song-${index}`; next.session.current = track; next.session.queue = tracks.slice(index + 1);
    return next;
  });
  await page.evaluate(frames => frames.forEach(frame => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(frame)), frames);
  await expect(player(page).locator('.compact-track-title')).toHaveText(tracks[2].title);
  // One quiet read once they settle, not one per song.
  await expect.poll(() => count(fixture.requests, '/library')).toBe(2);
  await page.waitForTimeout(1600);
  expect(count(fixture.requests, '/library')).toBe(2);
});

test('a queued save is not moved onto a song an earlier change brought in', async ({ page }) => {
  const fixture = await mockPortal(page);
  const current = fixture.state.snapshot.session.current!;
  fixture.state.library.favorites = fixture.state.library.favorites.filter(track => track.id !== current.id);
  Object.assign(fixture.state.snapshot.session, { hasPrevious: true, positionMs: 1000, status: 'paused' });
  // Back brings in another song; the fixture models that before replying. Like the
  // bot, it refuses a save bound to a session that has since changed.
  await page.route('**/api/guilds/testing/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.command === 'back') {
      const s = fixture.state.snapshot.session; s.queue.unshift(s.current!); s.current = fixture.state.library.history[0].track;
    }
    if (body.command === 'favorite' && body.subcommand === 'add' && body.expectedRevision !== fixture.state.snapshot.revision) {
      fixture.commands.push(body);
      await route.fulfill({ status: 409, json: { error: { code: 'stale_revision', message: 'The session changed.' } } }); return;
    }
    await route.fallback();
  });
  await gotoSession(page);
  const release = fixture.holdCommands();
  await player(page).getByRole('button', { name: 'Previous song' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['back']);
  // The heart still shows the song that was playing when it was tapped.
  await player(page).getByRole('button', { name: 'Save current song to favorites' }).click();
  release();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['back', 'favorite']);
  // Bound to the session the listener saw, so the bot refuses it rather than saving the new song.
  expect(fixture.commands[0].expectedRevision).toBe('revision-1');
  expect(fixture.commands[1].expectedRevision).toBe('revision-1');
  await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
  expect(fixture.state.library.favorites.map(track => track.id)).not.toContain(fixture.state.library.history[0].track.id);
  expect(fixture.state.library.favorites.map(track => track.id)).not.toContain(current.id);
  await expect(player(page).getByRole('button', { name: 'Save current song to favorites' })).toHaveAttribute('aria-pressed', 'false');
});

test('lost access to a server shows its reason on every held read, each with its own retry', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  await expect(page.locator('.recap-grid')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'On repeat in this server' })).toBeVisible();
  // The past-week recap finds access gone; the stats on screen go with it.
  await page.route('**/api/guilds/testing/recap*', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'You no longer have access to this listening space.' } } }));
  await page.getByLabel('Recap range').selectOption('7d');
  await expect(page.locator('.home-recap [role="alert"]')).toContainText('no longer have access');
  await expect(page.locator('.home-unavailable').first()).toContainText('no longer have access');
  await expect(page.getByRole('heading', { name: 'On repeat in this server' })).toHaveCount(0);
  const stats = count(fixture.requests, '/stats');
  await page.waitForTimeout(500);
  expect(count(fixture.requests, '/stats')).toBe(stats);
  // Access is back: each retry reads its own part again.
  await page.unroute('**/api/guilds/testing/recap*');
  await page.locator('.home-recap').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.recap-grid')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByRole('heading', { name: 'On repeat in this server' })).toBeVisible();
});

test('lost access to one stats range drops every range held for that server', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.route('**/api/guilds/testing/stats?window=7d', route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'You no longer have access to this listening space.' } } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'On repeat in this server' })).toBeVisible();
  expect(count(fixture.requests, '/stats')).toBe(1);
  const range = page.getByLabel('Time range for Your top tracks');
  await range.selectOption('7d');
  await expect(page.locator('.home-unavailable').first()).toContainText('no longer have access');
  await page.unroute('**/api/guilds/testing/stats?window=7d');
  // The recap held for that server shows the same reason with its own retry.
  await expect(page.locator('.home-recap [role="alert"]')).toContainText('no longer have access');
  await page.getByRole('button', { name: 'Try again' }).first().click();
  // The past-month read held from before was dropped with it, so it's read again.
  await expect(range).toBeVisible();
  const before = count(fixture.requests, '/stats');
  await range.selectOption('30d');
  await expect.poll(() => count(fixture.requests, '/stats')).toBe(before + 1);
});
