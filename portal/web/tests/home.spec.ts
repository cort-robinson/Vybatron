import { test, expect, type Page } from './test';
import { mockPortal } from './fixtures';

const shelf = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('Home is the landing surface, with shelves in order and stats loaded after the session', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  const headings = page.locator('.home-shelf h2');
  await expect(headings).toHaveText(['Continue listening', 'On repeat in this server', 'Your mixes', 'Rediscover', 'Forgotten gems', 'Listening recap']);
  // The session snapshot is requested before stats, so Home never holds up the player.
  const order = fixture.requests.filter(path => /\/api\/guilds\/testing(\/stats)?$/.test(path));
  expect(order[0]).toBe('/api/guilds/testing');
  expect(order).toContain('/api/guilds/testing/stats');

  const continuing = shelf(page, 'Continue listening');
  await expect(continuing).toContainText('Playing now in General');
  await expect(continuing).toContainText('Evening Light');
  await expect(continuing.getByRole('listitem')).toHaveCount(1);
  await continuing.getByRole('button', { name: 'View now playing' }).click();
  await expect(page.getByRole('button', { name: 'Close player' }).first()).toBeVisible();
});

test('every shelf queues through the normal commands', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  const sent = async (action: () => Promise<void>) => { const count = fixture.commands.length; await action(); await expect.poll(() => fixture.commands.length).toBe(count + 1); return fixture.commands.at(-1); };

  expect(await sent(() => shelf(page, 'Continue listening').getByRole('button', { name: 'Add Afterglow to the queue' }).click()))
    .toEqual({ command: 'play', options: { query: 'https://example.com/music/afterglow' } });
  expect(await sent(() => shelf(page, 'On repeat in this server').getByRole('button', { name: 'Shuffle On repeat' }).click()))
    .toEqual({ command: 'top', subcommand: 'play', options: { list: 'on-repeat', shuffle: true } });
  const mixes = shelf(page, 'Your mixes');
  await expect(mixes.getByRole('heading', { level: 3 })).toHaveText(['Your mix', 'Your top tracks', 'Solara mix']);
  await expect(mixes).toContainText('New picks');
  expect(await sent(() => mixes.getByRole('button', { name: 'Play Your mix' }).click()))
    .toEqual({ command: 'mymix', subcommand: 'play', options: { playlist: 'mix', shuffle: false } });
  expect(await sent(() => mixes.getByRole('button', { name: 'Shuffle Solara mix' }).click()))
    .toEqual({ command: 'mymix', subcommand: 'play', options: { playlist: 'artist', artist: 'Solara', shuffle: true } });

  // The window switch refetches and plays the selected range.
  const statsReads = fixture.requests.filter(path => path.endsWith('/stats')).length;
  await mixes.getByLabel('Time range for Your top tracks').selectOption('7d');
  await expect.poll(() => fixture.requests.filter(path => path.endsWith('/stats')).length).toBe(statsReads + 1);
  await expect(mixes).toContainText('past week');
  expect(await sent(() => mixes.getByRole('button', { name: 'Play Your top tracks' }).click()))
    .toEqual({ command: 'mymix', subcommand: 'play', options: { playlist: 'top', shuffle: false, window: '7d' } });

  const rediscover = shelf(page, 'Rediscover');
  expect(await sent(() => rediscover.getByRole('button', { name: 'Add Night Drive to the queue' }).click()))
    .toEqual({ command: 'favorite', subcommand: 'play', options: { index: 1 }, expectedTrackId: fixture.state.stats.personal.rediscover[0].track.id });
  expect(await sent(() => rediscover.getByRole('button', { name: 'Play all of Rediscover' }).click()))
    .toEqual({ command: 'mymix', subcommand: 'play', options: { playlist: 'rediscover', shuffle: false } });
  expect(await sent(() => shelf(page, 'Forgotten gems').getByRole('button', { name: 'Play all of Forgotten gems' }).click()))
    .toEqual({ command: 'top', subcommand: 'play', options: { list: 'forgotten-gems', shuffle: false } });
  await expect(page.locator('.home-view')).not.toContainText('requested by', { ignoreCase: true });
});

test('Home explains empty, partial, unavailable and no-permission states', async ({ page }) => {
  const fixture = await mockPortal(page);
  const { stats, snapshot, library } = fixture.state;
  snapshot.session.canAdd = false; snapshot.session.reason = 'Join the listening voice channel to control playback.';
  snapshot.session.current = null; snapshot.session.queue = []; snapshot.session.status = 'idle';
  Object.assign(snapshot.savedSession, { exists: true, savedAt: 1_791_147_600_000, trackCount: 12, voiceChannel: { id: 'voice', name: 'General' }, canResume: false });
  stats.serverFavorites.forgottenGems = [];
  stats.personal.rediscover = [];
  stats.personal.playlists = stats.personal.playlists.filter(list => list.kind === 'top' || list.kind === 'rediscover').map(list => ({ ...list, tracks: [] }));
  library.favorites = [];
  await page.goto('/');
  await expect(page.locator('.home-view .permission-note')).toContainText('Join the listening voice channel');
  const continuing = shelf(page, 'Continue listening');
  await expect(continuing).toContainText('Pick up where you left off');
  await expect(continuing).toContainText('12 songs in General');
  await expect(continuing).toContainText('Join General to resume');
  await expect(continuing.getByRole('button', { name: 'Resume session' })).toBeDisabled();
  await expect(shelf(page, 'On repeat in this server').getByRole('button', { name: 'Play all of On repeat' })).toBeDisabled();
  await expect(shelf(page, 'On repeat in this server').getByRole('button', { name: /Add .* to the queue/ }).first()).toBeDisabled();
  await expect(shelf(page, 'Your mixes').getByRole('heading', { level: 3 })).toHaveText(['Your top tracks'], { timeout: 7_000 });
  await expect(shelf(page, 'Your mixes')).toContainText('No requests in this range');
  await expect(shelf(page, 'Rediscover')).toContainText('Heart songs you love');
  await expect(shelf(page, 'Forgotten gems')).toContainText('No forgotten gems yet');

  await page.route('**/api/guilds/*/stats*', route => route.fulfill({ status: 503, json: { error: { code: 'stats_unavailable', message: 'Listening stats are unavailable right now. Playback is unaffected.' } } }));
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.locator('.home-unavailable')).toContainText('Playback is unaffected');
  await expect(page.locator('.home-unavailable')).toContainText('Continue listening above still works');
  await expect(shelf(page, 'Continue listening')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your mixes' })).toHaveCount(0);
});

test('a brand-new listener sees why each personal shelf is empty', async ({ page }) => {
  const fixture = await mockPortal(page);
  const { stats, library } = fixture.state;
  stats.serverFavorites = { onRepeat: [], forgottenGems: [] };
  stats.personal = { ...stats.personal, rediscover: [], playlists: [
    { id: 'your-mix', kind: 'mix', title: 'Your mix', artist: null, refreshesAt: 1_791_590_400_000, tracks: [] },
    { id: 'top-tracks', kind: 'top', title: 'Your top tracks', artist: null, refreshesAt: null, tracks: [] },
    { id: 'rediscover', kind: 'rediscover', title: 'Rediscover', artist: null, refreshesAt: null, tracks: [] }] };
  library.history = []; library.favorites = [];
  await page.goto('/');
  await expect(shelf(page, 'On repeat in this server')).toContainText('Nothing on repeat yet');
  await expect(shelf(page, 'Your mixes')).toContainText('Your mixes fill in as you request songs');
  await expect(shelf(page, 'Continue listening')).toContainText('Evening Light');
});

test('clearing request stats confirms, explains what stays, and refreshes the personal shelves', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  const privacy = page.getByRole('region', { name: 'Your request stats' });
  await expect(privacy).toContainText('Server totals stay, anonymized');
  await expect(shelf(page, 'Your mixes').getByRole('heading', { name: 'Solara mix' })).toBeVisible();
  await privacy.getByRole('button', { name: 'Clear my request stats' }).click();
  const dialog = page.getByRole('dialog', { name: 'Clear your request stats?' });
  await expect(dialog).toContainText('in every server');
  await expect(dialog).toContainText('favorites, shared mixes and history stay');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(fixture.requestClears).toHaveLength(0);

  await privacy.getByRole('button', { name: 'Clear my request stats' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Clear my stats' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cleared you from 4 requests' })).toBeVisible();
  expect(fixture.requestClears).toHaveLength(1);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(shelf(page, 'Your mixes').getByRole('heading', { name: 'Solara mix' })).toHaveCount(0);
  await expect(shelf(page, 'On repeat in this server').getByRole('listitem')).toHaveCount(4);
  const recap = shelf(page, 'Listening recap');
  await expect(recap).toContainText('You haven’t requested songs here in the past month.');
  await expect(recap.getByRole('group', { name: 'This server' })).toContainText('184');
});

test('the listening recap shows your totals and the server’s, and switches range', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  const recap = shelf(page, 'Listening recap');
  await expect(recap).toContainText('not who was listening');
  const mine = recap.getByRole('group', { name: 'Your requests' });
  await expect(mine.locator('.recap-tiles > div')).toHaveText(['Requests23', 'Played time1 hr 13 min', 'Songs9']);
  await expect(mine.getByRole('list', { name: 'Your top tracks' }).getByRole('listitem').first()).toContainText('Evening Light');
  await expect(mine.getByRole('list', { name: 'Your top tracks' }).getByRole('listitem').first()).toContainText('7 plays');
  await expect(mine.getByRole('list', { name: 'Your top artists' }).getByRole('listitem').first()).toContainText('Most requested: Evening Light');
  const server = recap.getByRole('group', { name: 'This server' });
  await expect(server.locator('.recap-tiles > div')).toHaveText(['Plays184', 'Played time9 hr 12 min', 'Songs61']);
  await expect(server.getByRole('list', { name: 'Server top tracks' }).getByRole('listitem')).toHaveCount(4);
  await expect(recap).not.toContainText('requested by', { ignoreCase: true });
  expect(fixture.recapWindows).toEqual(['30d']);

  await recap.getByLabel('Recap range').selectOption('365d');
  await expect.poll(() => fixture.recapWindows).toEqual(['30d', '365d']);
  await expect(recap.getByLabel('Recap range').locator('option')).toHaveText(['Past week', 'Past month', 'Past 3 months', 'Past year']);
  // The range survives leaving Home and coming back.
  await page.getByRole('button', { name: 'My Music', exact: true }).click();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect.poll(() => fixture.recapWindows.at(-1)).toBe('365d');
  await expect(shelf(page, 'Listening recap').getByLabel('Recap range')).toHaveValue('365d');
});

test('the listening recap explains empty and unavailable states without affecting the shelves', async ({ page }) => {
  const fixture = await mockPortal(page);
  const empty = { plays: 0, playedMs: 0, songs: 0 };
  fixture.state.recap = { ...fixture.state.recap, personal: { ...empty, topTracks: [], topArtists: [] }, server: { ...empty, topTracks: [] } };
  await page.goto('/');
  const recap = shelf(page, 'Listening recap');
  await expect(recap).toContainText('Nothing played in voice channels you can see in the past month. Try a longer range.');
  await expect(recap.getByRole('group')).toHaveCount(0);

  let failures = 0;
  await page.route('**/api/guilds/*/recap*', route => { failures++; return route.fulfill({ status: 503, json: { error: { code: 'stats_unavailable', message: 'Listening stats are unavailable right now. Playback is unaffected.' } } }); });
  await recap.getByLabel('Recap range').selectOption('7d');
  const alert = recap.getByRole('alert');
  await expect(alert).toContainText('Your listening recap can’t load right now');
  await expect(alert).toContainText('Playback is unaffected');
  await expect(shelf(page, 'On repeat in this server').getByRole('listitem')).toHaveCount(4);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(() => failures).toBe(2);
});

test('the listening recap never shows one range’s numbers under another', async ({ page }) => {
  const fixture = await mockPortal(page);
  const empty = { plays: 0, playedMs: 0, songs: 0 };
  fixture.state.recap = { ...fixture.state.recap, personal: { ...empty, topTracks: [], topArtists: [] }, server: { ...empty, topTracks: [] } };
  await page.goto('/');
  const recap = shelf(page, 'Listening recap');
  await expect(recap).toContainText('in the past month');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/guilds/*/recap*', async route => { await held; await route.fulfill({ status: 429, json: { error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' } } }); });
  await recap.getByLabel('Recap range').selectOption('365d');
  await expect(recap).toContainText('Loading your listening recap');
  await expect(recap).not.toContainText('Nothing played');
  release();
  await expect(recap.getByRole('alert')).toContainText('Too many requests');
  await expect(recap).not.toContainText('Nothing played');
  await page.unroute('**/api/guilds/*/recap*');
  await recap.getByRole('button', { name: 'Try again' }).click();
  await expect(recap).toContainText('Nothing played in voice channels you can see in the past year');
});

test('Stop offers to save the session as a mix first', async ({ page }) => {
  const fixture = await mockPortal(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'More playback controls' }).click();
  await page.getByRole('button', { name: 'Stop and discard session' }).click();
  const stop = page.getByRole('dialog', { name: 'Stop this listening session?' });
  await expect(stop).toContainText('Keep this session');
  await expect(stop.getByRole('button', { name: 'Save mix, then stop' })).toBeDisabled();
  await stop.getByLabel('Mix name').fill('Night shift');
  await expect(stop).toContainText('“Night shift” already exists');
  await expect(stop.getByRole('button', { name: 'Save mix, then stop' })).toBeDisabled();
  await stop.getByLabel('Mix name').fill('Friday night');
  await stop.getByRole('button', { name: 'Save mix, then stop' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['mix', 'stop']);
  expect(fixture.commands[0]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'Friday night', session: true }, expectedRevision: 'revision-1' });
  await expect(stop).toHaveCount(0);
});

test('the queue saves the session as a mix on its own', async ({ page }) => {
  const second = await mockPortal(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.getByRole('button', { name: 'Save session as mix' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save this session as a mix' });
  await expect(dialog.getByLabel('Mix name')).toBeFocused();
  await expect(dialog).toContainText('up to 100 songs');
  await dialog.getByLabel('Mix name').fill('Late set');
  await dialog.getByRole('button', { name: 'Save mix' }).click();
  await expect.poll(() => second.commands.length).toBe(1);
  expect(second.commands[0]).toEqual({ command: 'mix', subcommand: 'save', options: { name: 'Late set', session: true }, expectedRevision: 'revision-1' });
  await expect(dialog).toHaveCount(0);
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }], ['small phone', { width: 360, height: 740 }]] as const) {
  test(`Home layout holds on ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockPortal(page);
    await page.goto('/');
    await expect(shelf(page, 'Your mixes').getByRole('heading', { level: 3 })).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Every shelf action stays reachable at a touch-friendly size.
    for (const button of await page.locator('.home-view button:visible').all()) {
      const box = await button.boundingBox();
      if (box) expect(box.height, await button.innerText()).toBeGreaterThanOrEqual(40);
    }
    await page.screenshot({ path: `test-results/home-${name.replace(' ', '-')}.png`, fullPage: true });
  });
}

test('on a phone the playing card opens from a caret and a saved session keeps a full-width Resume', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const fixture = await mockPortal(page);
  await page.goto('/');
  const open = shelf(page, 'Continue listening').getByRole('button', { name: 'View now playing' });
  await expect(open).toBeVisible();
  expect((await open.boundingBox())!.width).toBeLessThanOrEqual(48);

  const { snapshot } = fixture.state;
  snapshot.session.current = null; snapshot.session.queue = []; snapshot.session.status = 'idle';
  Object.assign(snapshot.savedSession, { exists: true, savedAt: 1_791_147_600_000, trackCount: 12, voiceChannel: { id: 'voice', name: 'General' }, canResume: true });
  await page.reload();
  const card = shelf(page, 'Continue listening').locator('.continue-feature');
  const resume = card.getByRole('button', { name: 'Resume session' });
  await expect(resume).toBeVisible();
  const [cardBox, resumeBox] = [(await card.boundingBox())!, (await resume.boundingBox())!];
  expect(resumeBox.width).toBeGreaterThan(cardBox.width * .75);
  expect(resumeBox.x + resumeBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
});
