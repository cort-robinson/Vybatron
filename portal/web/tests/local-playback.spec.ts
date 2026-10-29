import { test, expect, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';

// A minute of silent 8 kHz mono WAV: real, decodable audio for the media element.
function silence(seconds = 60) {
  const samples = 8000 * seconds; const wav = Buffer.alloc(44 + samples, 128);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(samples, 40);
  return wav;
}
const audioBody = silence();
const youtubeTrack = (id: string, title: string) => ({ id: id.padEnd(24, '0'), title, author: 'M83', uri: `https://www.youtube.com/watch?v=${id}`, source: 'youtube',
  durationMs: 244_000, artworkUrl: null, isStream: false, requestedBy: null });
const general = { id: 'voice', name: 'General' };

async function portal(page: Page, { inVoice, idle = false }: { inVoice: boolean; idle?: boolean }) {
  const fixture = await mockPortal(page);
  const s = fixture.state.snapshot.session;
  s.viewerVoice = inVoice ? general : null;
  if (idle) Object.assign(s, { status: 'idle', current: null, queue: [], listeners: [], voiceChannel: null, canControl: false });
  // Record what the portal asks the audio element to do.
  await page.addInitScript(() => {
    const calls: string[] = []; (window as unknown as { audioCalls: string[] }).audioCalls = calls;
    const media = HTMLMediaElement.prototype; const play = media.play; const pause = media.pause;
    media.play = function () { calls.push(`play:${this.dataset.video}@${this.src.split('#t=')[1] || 0}`); return play.call(this); };
    media.pause = function () { calls.push('pause'); return pause.call(this); };
  });
  const audio: string[] = [];
  await page.route('**/api/guilds/*/audio/*', route => {
    audio.push(new URL(route.request().url()).pathname.split('/').pop()!);
    return route.fulfill({ status: 200, contentType: 'audio/wav', body: audioBody });
  });
  await page.route('**/api/guilds/*/search?*', route => route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), youtubeTrack('Fk3RbKWbmtg', 'Wait')], notice: null } }));
  await gotoSession(page);
  return Object.assign(fixture, { audio });
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { audioCalls?: string[] }).audioCalls || []);
const title = (page: Page) => page.getByTestId('player').locator('.compact-track-title');
const openMenu = (page: Page) => page.getByTestId('player').getByRole('button', { name: 'More playback controls' }).click();
async function playOn(page: Page, choice: string | RegExp) {
  await openMenu(page);
  await page.getByRole('button', { name: choice, exact: true }).click();
}
async function addSongs(page: Page) {
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Wait to queue' }).click();
  await page.keyboard.press('Escape');
}

test('lyrics follow the song playing on this device, looked up by its YouTube video', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  const lyricsRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/lyrics')) lyricsRequests.push(new URL(request.url()).pathname); });
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  await page.getByRole('button', { name: 'Show lyrics', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Lyrics' });
  await expect(panel.getByText('Streetlights hum along the avenue')).toBeVisible();
  expect(lyricsRequests).toEqual(['/api/guilds/testing/lyrics/dX3k_QDnzHE']);
  expect(fixture.commands).toEqual([]);
});

test('outside voice the portal plays audio on this device without sending Discord commands', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  await expect(title(page)).toHaveText('Nothing playing');
  await expect(page.getByRole('heading', { name: 'Your Queue' })).toBeAttached();
  await expect(page.getByLabel('Audio filter')).toHaveCount(0);

  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(() => calls(page)).toContain('play:dX3k_QDnzHE@0');
  // Audio only: no video, no YouTube frame or script on the page.
  await expect(page.locator('iframe, video')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Skip current song' }).click();
  await expect(title(page)).toHaveText('Wait');
  await expect.poll(() => calls(page)).toEqual(expect.arrayContaining(['pause', 'play:Fk3RbKWbmtg@0']));
  await expect.poll(() => fixture.audio).toContain('Fk3RbKWbmtg');
  expect(fixture.commands).toEqual([]);

  // The queue survives a reload, waiting paused; nothing downloads until play.
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await page.reload();
  await expect(title(page)).toHaveText('Wait');
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  expect(await calls(page)).toEqual([]);
  await page.getByRole('button', { name: 'Resume playback' }).click();
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^play:Fk3RbKWbmtg@/));
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  // The Discord session already playing can be joined from here.
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Join the session in General' })).toBeEnabled();
  expect(fixture.commands).toEqual([]);
});

test('in voice the portal keeps controlling the Discord session', async ({ page }) => {
  const fixture = await portal(page, { inVoice: true });
  await expect(title(page)).toHaveText('Evening Light');
  expect(fixture.audio).toEqual([]);
});

test('moving to voice casts this device’s queue and place into the listener’s channel', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false, idle: true });
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Discord · join a voice channel first' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Joining voice offers the move but never cuts off music already playing here.
  fixture.state.snapshot.session.viewerVoice = general;
  fixture.state.snapshot.revision = 'revision-voice';
  await page.evaluate(snapshot => (window as unknown as { portalTest: { emit: (data: unknown) => void } }).portalTest.emit(snapshot), fixture.state.snapshot);
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Move to General' })).toBeEnabled();
  expect(await calls(page)).not.toContain('pause');
  await page.getByRole('button', { name: 'Move to General' }).click();
  await expect(title(page)).toHaveText('Moved In');
  const moved = fixture.commands.at(-1)!;
  expect(moved).toMatchObject({ command: 'transfer', tracks: ['https://www.youtube.com/watch?v=dX3k_QDnzHE', 'https://www.youtube.com/watch?v=Fk3RbKWbmtg'],
    options: { paused: false, volume: 100, repeat: 'off' } });
  expect(moved.options!.position).toBeGreaterThanOrEqual(0);
  // This device went quiet before Discord took over.
  await expect.poll(() => calls(page)).toContain('pause');
});

test('moving here can leave Discord playing or stop it', async ({ page }) => {
  const fixture = await portal(page, { inVoice: true });
  await playOn(page, /^This device/);
  const dialog = page.getByRole('dialog', { name: 'Move playback to this device?' });
  await expect(dialog).toContainText('2 other people are listening in General.');
  await dialog.getByRole('button', { name: 'Listen here too' }).click();
  // Songs from other catalogs play here through their YouTube match, from the same spot.
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^play:dX3k_QDnzHE@1\d\d$/));
  await expect(page.locator('.track-row')).toHaveCount(4);
  expect(fixture.commands).toEqual([]);

  await playOn(page, 'Join the session in General');
  await expect(title(page)).toHaveText('Evening Light');
  await expect.poll(() => calls(page)).toContain('pause');
  await playOn(page, /^This device/);
  await page.getByRole('dialog').getByRole('button', { name: 'Move here' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['stop']);
  await expect(page.getByRole('heading', { name: 'Your Queue' })).toBeAttached();
});

test('home lists queue on this device from the tracks the portal already shows', async ({ page }) => {
  await portal(page, { inVoice: false });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Play all of On repeat' }).click();
  await expect(title(page)).toHaveText('Midnight City');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.locator('.track-row')).toHaveCount(3);
  // A song on this device can be saved too; it goes through a one-song import.
  await expect(page.getByTestId('player').getByRole('button', { name: 'Save current song to favorites' })).toBeEnabled();
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });
  test('songs on this device change with a sideways swipe on the compact deck', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await portal(page, { inVoice: false });
    await addSongs(page);
    await expect(title(page)).toHaveText('Midnight City');
    const swipe = async (dx: number) => {
      const box = (await title(page).boundingBox())!; const x = box.x + box.width / 2; const y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 8; i++) { await page.waitForTimeout(20); await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / 8, y }] }); }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
    await swipe(-200);
    await expect(title(page)).toHaveText('Wait');
    await swipe(200);
    await expect(title(page)).toHaveText('Midnight City');
    await expect(page.getByTestId('player')).toHaveClass(/collapsed/);
    expect(fixture.commands).toEqual([]);
  });
});

// The bot's one-song import, as the server answers it: a preview, then the commit that saves it.
async function favoriteImports(page: Page, fixture: Awaited<ReturnType<typeof portal>>, preview: (link: string) => object | null, hold?: Promise<void>) {
  await page.route('**/api/guilds/*/commands', async route => {
    const body = route.request().postDataJSON();
    if (body.command !== 'favorite' || body.subcommand !== 'import') return route.fallback();
    fixture.commands.push(body);
    if (hold) await hold;
    const reply = { ok: true, snapshot: fixture.state.snapshot };
    if (!body.expectedImportId) return route.fulfill({ json: { ...reply, message: 'Preview ready.', preview: preview(body.options.link) } });
    fixture.state.library.favorites.push(youtubeTrack('dX3k_QDnzHE', 'Midnight City'));
    return route.fulfill({ json: { ...reply, message: 'Added 1 track.' } });
  });
}
const onePreview = (overrides = {}) => ({ id: 'c'.repeat(32), target: 'favorites', name: null, title: 'Midnight City', found: 1, toAdd: 1, duplicates: 0, unmatched: 0, overLimit: 0, limit: 1000, notes: [], tracks: [{ title: 'Midnight City', author: 'M83' }], ...overrides });

test('a song on this device saves to favorites through a one-song import', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  await favoriteImports(page, fixture, () => onePreview());
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  const player = page.getByTestId('player');
  await player.getByRole('button', { name: 'Save current song to favorites' }).filter({ visible: true }).click();
  await expect.poll(() => fixture.commands.filter(c => c.command === 'favorite').map(c => [c.subcommand, c.options?.link, !!c.expectedImportId]))
    .toEqual([['import', 'https://www.youtube.com/watch?v=dX3k_QDnzHE', false], ['import', 'https://www.youtube.com/watch?v=dX3k_QDnzHE', true]]);
  // The saved song is the one playing, so its heart fills.
  await expect(player.getByRole('button', { name: 'Remove current song from favorites' }).filter({ visible: true })).toBeVisible();
  expect(fixture.commands.some(c => c.command === 'favorite' && c.subcommand === 'add')).toBe(false);
});

test('a save from this device that the bot declines says why', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  await favoriteImports(page, fixture, () => onePreview({ id: null, toAdd: 0, overLimit: 1 }));
  await addSongs(page);
  await page.getByTestId('player').getByRole('button', { name: 'Save current song to favorites' }).filter({ visible: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your favorites hold at most 1,000 songs.' })).toBeVisible();
  expect(fixture.commands.filter(c => c.command === 'favorite').map(c => !!c.expectedImportId)).toEqual([false]);
});

test('a second tap while a save is loading sends nothing more', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  let release = () => {}; const hold = new Promise<void>(resolve => { release = resolve; });
  await favoriteImports(page, fixture, () => onePreview(), hold);
  await addSongs(page);
  const heart = page.getByTestId('player').getByRole('button', { name: 'Save current song to favorites' }).filter({ visible: true });
  await heart.click();
  // The heart fills at once and waits, like every other heart, while the save loads.
  await expect(page.getByTestId('player').getByRole('button', { name: 'Remove current song from favorites' }).filter({ visible: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save Wait to favorites' })).toBeDisabled();
  release();
  await expect.poll(() => fixture.commands.filter(c => c.command === 'favorite').length).toBe(2);
});

test('a song from a source the import can\'t read explains instead of failing', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  // A queued song keeps its own catalog link until it plays through its YouTube match.
  await page.route('**/api/guilds/*/search?*', route => route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), { ...youtubeTrack('bandcamp01', 'Bandcamp Song'), uri: 'https://artist.bandcamp.com/track/song', source: 'bandcamp' }], notice: null } }));
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('song');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Bandcamp Song to queue' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await page.getByRole('button', { name: 'Save Bandcamp Song to favorites' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'can’t be saved to favorites from this device' })).toBeVisible();
  expect(fixture.commands.some(c => c.command === 'favorite')).toBe(false);
});

test('an addition on this device made while another is still looking up its song waits its turn', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  // The typed addition's lookup is held, so it's still finding its song when the next tap lands.
  let held: Promise<void> | undefined; let release = () => {};
  await page.route('**/api/guilds/*/search?*', async route => {
    if (held) await held;
    await route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), youtubeTrack('Fk3RbKWbmtg', 'Wait')], notice: null } });
  });
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  const wait = page.getByRole('button', { name: 'Add Wait to queue' });
  await expect(wait).toBeEnabled();
  held = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
  await wait.click();
  release(); held = undefined;
  await page.keyboard.press('Escape');
  await expect(title(page)).toHaveText('Midnight City');
  await expect(page.locator('.queue:not(.queue-compact) .track-row strong')).toHaveText(['Wait']);
  expect(fixture.commands).toEqual([]);
});

test('the seek bar on this device waits for a song’s audio to begin', async ({ page }) => {
  await portal(page, { inVoice: false });
  // The next song takes a while to come back from the bot.
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/guilds/*/audio/Fk3RbKWbmtg', async route => { await held; await route.fulfill({ status: 200, contentType: 'audio/wav', body: audioBody }); });
  await addSongs(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const seek = page.getByRole('slider', { name: 'Playback position' });
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Skip current song' }).click();
  await expect(seek).toHaveAttribute('aria-valuetext', '0:00 of 4:04');
  await page.waitForTimeout(2500);
  await expect(seek).toHaveValue('0');
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();

  release();
  await expect.poll(async () => Number(await seek.inputValue()), { timeout: 5000 }).toBeGreaterThan(0);
});

test('in Discord the seek bar holds while the bot says a song is still starting', async ({ page }) => {
  const fixture = await mockPortal(page);
  Object.assign(fixture.state.snapshot.session, { positionMs: 0, starting: true });
  await gotoSession(page);
  await page.getByRole('button', { name: 'Open player', exact: true }).click();
  const seek = page.getByRole('slider', { name: 'Playback position' });
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  await page.waitForTimeout(2500);
  await expect(seek).toHaveValue('0');
});
