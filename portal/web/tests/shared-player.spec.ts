import { test, expect, cssScene, type Page } from './test';
import type { Browser } from '@playwright/test';
import { gotoSession, mockPortal } from './fixtures';
import { SharedPlayerHub } from './shared-player';

// The listener's player follows them across devices (ADR-0018): each page here is
// one device, in its own browser context, sharing one stand-in portal and store.
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

async function device(page: Page, hub: SharedPlayerHub, { queue = true } = {}) {
  const fixture = await mockPortal(page, { shared: hub });
  fixture.state.snapshot.session.viewerVoice = null;
  await page.addInitScript(() => {
    const calls: string[] = []; (window as unknown as { audioCalls: string[] }).audioCalls = calls;
    const media = HTMLMediaElement.prototype; const play = media.play; const pause = media.pause;
    media.play = function () { calls.push(`play:${this.dataset.video}@${this.src.split('#t=')[1] || 0}`); return play.call(this); };
    media.pause = function () { calls.push('pause'); return pause.call(this); };
  });
  await page.route('**/api/guilds/*/audio/*', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audioBody }));
  await page.route('**/api/guilds/*/search?*', route => route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), youtubeTrack('Fk3RbKWbmtg', 'Wait')], notice: null } }));
  if (queue) await gotoSession(page); else await page.goto('/');
  return fixture;
}
// Another device: a browser of its own, with its own storage and so its own device ID.
async function second(browser: Browser, hub: SharedPlayerHub) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, serviceWorkers: 'block' });
  await context.addInitScript(cssScene);
  const page = await context.newPage();
  const fixture = await device(page, hub);
  return Object.assign(fixture, { page, close: () => context.close() });
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { audioCalls?: string[] }).audioCalls || []);
const title = (page: Page) => page.getByTestId('player').locator('.compact-track-title');
const openMenu = (page: Page) => page.getByTestId('player').getByRole('button', { name: 'More playback controls' }).click();
async function addSongs(page: Page) {
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Wait to queue' }).click();
  await page.keyboard.press('Escape');
}
// Device A starts the player and plays for a moment.
async function playing(page: Page, hub: SharedPlayerHub) {
  const fixture = await device(page, hub);
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(() => hub.player.playhead.playing).toBe(true);
  return fixture;
}

test('another device picks up the player paused where the first one left off', async ({ page, browser }) => {
  const hub = new SharedPlayerHub();
  await playing(page, hub);
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect.poll(() => hub.player.playhead.playing).toBe(false);
  const saved = hub.player.playhead.positionMs;
  expect(saved).toBeGreaterThanOrEqual(1000);
  // The first device goes away without a word (its tab closed).
  const first = hub.deviceOf(page);
  await page.close();

  const other = await second(browser, hub);
  // The same song and queue, paused at the saved place, and nothing downloads until Play.
  await expect(title(other.page)).toHaveText('Midnight City');
  await expect(other.page.locator('.queue:not(.queue-compact) .track-row strong')).toHaveText(['Wait']);
  await expect(other.page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  expect(await calls(other.page)).toEqual([]);

  await other.page.getByRole('button', { name: 'Resume playback' }).click();
  await expect.poll(() => calls(other.page)).toContain(`play:dX3k_QDnzHE@${Math.floor(saved / 1000)}`);
  await expect.poll(() => hub.player.activeDeviceId).toBe(hub.deviceOf(other.page));
  await expect.poll(() => hub.player.playhead.playing).toBe(true);
  expect(hub.player.generation).toBe(2);
  expect(hub.ops('activate').map(request => request.body.deviceId)).toEqual([first, hub.deviceOf(other.page)]);
  await other.close();
});

test('a page that goes away lets go of playback, and comes back to it paused', async ({ page }) => {
  const hub = new SharedPlayerHub();
  await playing(page, hub);
  // Leaving the page sends a last deactivate. (A request from a page that is unloading never
  // reaches the test's routes, so the event is dispatched here without leaving.)
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect.poll(() => hub.player.activeDeviceId).toBeNull();
  await expect.poll(() => calls(page)).toContain('pause');
  expect(hub.ops('deactivate').map(request => request.body.generation)).toEqual([1]);

  // A page reloaded while it played (that last request lost) finds itself the active device with
  // nothing playing in any of its tabs, and lets go too.
  await page.getByRole('button', { name: 'Resume playback' }).click();
  await expect.poll(() => hub.player.playhead.playing).toBe(true);
  await page.reload();
  await expect.poll(() => hub.player.activeDeviceId).toBeNull();
  expect(hub.ops('deactivate').map(request => request.body.generation)).toEqual([1, 2]);
  expect(hub.player.playhead.playing).toBe(false);
  await expect(title(page)).toHaveText('Midnight City');
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  expect(await calls(page)).toEqual([]);
});

test('controls on another device are carried out by the one that plays, which reports back', async ({ page, browser }) => {
  const hub = new SharedPlayerHub();
  await playing(page, hub);
  const remote = await second(browser, hub);
  await expect(title(remote.page)).toHaveText('Midnight City');
  await expect(remote.page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  // The remote's position moves with the device that plays.
  await remote.page.getByRole('button', { name: 'Open player', exact: true }).click();
  const seek = remote.page.getByRole('slider', { name: 'Playback position' });
  await expect.poll(async () => Number(await seek.inputValue())).toBeGreaterThan(0);
  await remote.page.getByRole('button', { name: 'Close player', exact: true }).last().click();

  await remote.page.getByRole('button', { name: 'Pause playback' }).click();
  expect(hub.ops('control').at(-1)).toMatchObject({ deviceId: hub.deviceOf(remote.page), body: { action: 'pause' } });
  await expect.poll(() => calls(page)).toContain('pause');
  await expect.poll(() => hub.ops('report').filter(report => report.body.playhead?.playing === false).length).toBeGreaterThan(0);
  await expect(remote.page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();

  await remote.page.getByRole('button', { name: 'Skip current song' }).click();
  await expect(title(page)).toHaveText('Wait');
  await expect(title(remote.page)).toHaveText('Wait');
  await expect.poll(() => calls(page)).toContain('play:Fk3RbKWbmtg@0');
  // Only the device that plays downloads audio; the remote never touched its own.
  expect(await calls(remote.page)).toEqual([]);
  expect(hub.ops('report').every(report => report.deviceId === hub.deviceOf(page))).toBe(true);
  await remote.close();
});

test('choosing another device moves playback there and stops the first at once', async ({ page, browser }) => {
  const hub = new SharedPlayerHub();
  await playing(page, hub);
  const other = await second(browser, hub);
  await expect(title(other.page)).toHaveText('Midnight City');

  // The second device takes a name of its own, which the first one lists.
  await openMenu(other.page);
  await other.page.getByRole('button', { name: 'Rename this device' }).click();
  await other.page.getByRole('dialog', { name: 'Rename this device' }).getByLabel('Device name').fill('Kitchen');
  await other.page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => hub.devices.find(item => item.deviceId === hub.deviceOf(other.page))?.name).toBe('Kitchen');
  await openMenu(page);
  await expect(page.getByRole('button', { name: /^Kitchen/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^This device/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  // From the second device, This device takes over: a new generation, and the first stops.
  await openMenu(other.page);
  await other.page.getByRole('button', { name: /^This device/ }).click();
  await expect.poll(() => hub.player.activeDeviceId).toBe(hub.deviceOf(other.page));
  await expect.poll(() => calls(other.page)).toContainEqual(expect.stringMatching(/^play:dX3k_QDnzHE@/));
  await expect.poll(() => calls(page)).toContain('pause');
  await expect(page.getByText('Playing on Kitchen now.')).toBeVisible();
  // The first device is a remote now: Pause goes to Kitchen.
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect.poll(() => calls(other.page)).toContain('pause');
  await other.close();
});

test('a queue edit refused as stale is retried once on the newer player', async ({ page }) => {
  const hub = new SharedPlayerHub();
  await playing(page, hub);
  await expect(page.locator('.queue:not(.queue-compact) .track-row strong')).toHaveText(['Wait']);
  hub.staleNext();
  await page.getByRole('button', { name: 'Song options for Wait' }).click();
  await page.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(page.locator('.queue:not(.queue-compact) .track-row')).toHaveCount(0);
  const removes = hub.ops('remove');
  expect(removes.map(request => request.status)).toEqual([409, 200]);
  expect(removes[1].body.expectedRevision).toBe(removes[0].body.expectedRevision + 1);
  expect(removes[1].body.entryId).toBe(removes[0].body.entryId);
  await expect(page.getByText('Your queue changed')).toHaveCount(0);

  // Refused twice, it gives up and says so.
  await addSongs(page);
  await expect(page.locator('.queue:not(.queue-compact) .track-row')).toHaveCount(2);
  hub.staleNext(2);
  await page.getByRole('button', { name: 'Song options for Wait' }).click();
  await page.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your queue changed. Try again.' })).toBeVisible();
  await expect(page.locator('.queue:not(.queue-compact) .track-row')).toHaveCount(2);
});

const legacyDeck = { current: youtubeTrack('dX3k_QDnzHE', 'Midnight City'), queue: [youtubeTrack('Fk3RbKWbmtg', 'Wait')], history: [], positionMs: 42_000, volume: 60, repeat: 'queue' };
async function withLegacyDeck(page: Page) {
  // Once: a reload must not bring it back.
  await page.addInitScript(deck => {
    try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('vybertron.local', JSON.stringify(deck)); sessionStorage.setItem('seeded', '1'); } } catch { /* A frame without storage. */ }
  }, legacyDeck);
}
const legacyKey = (page: Page) => page.evaluate(() => localStorage.getItem('vybertron.local'));

test('an old deck on this browser is added to the player only when the listener says so', async ({ page }) => {
  const hub = new SharedPlayerHub();
  await withLegacyDeck(page);
  await device(page, hub, { queue: false });
  const dialog = page.getByRole('dialog', { name: 'Add this device’s songs to your player?' });
  await expect(dialog).toContainText('This device kept 2 songs');
  // Nothing went up while the question waits.
  expect(hub.ops('adopt')).toEqual([]);
  await dialog.getByRole('button', { name: 'Add to my player' }).click();
  await expect(title(page)).toHaveText('Midnight City');
  expect(hub.ops('adopt').map(request => request.body)).toEqual([expect.objectContaining({ current: expect.objectContaining({ title: 'Midnight City' }),
    tracks: [expect.objectContaining({ title: 'Wait' })], positionMs: 42_000, volume: 60, repeat: 'queue' })]);
  expect(hub.player.playhead).toMatchObject({ positionMs: 42_000, playing: false });
  expect(await legacyKey(page)).toBeNull();
  await page.reload();
  await expect(title(page)).toHaveText('Midnight City');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('an old deck the listener leaves out is deleted without being sent', async ({ page }) => {
  const hub = new SharedPlayerHub();
  await withLegacyDeck(page);
  await device(page, hub, { queue: false });
  const dialog = page.getByRole('dialog', { name: 'Add this device’s songs to your player?' });
  await dialog.getByRole('button', { name: 'Leave out' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await legacyKey(page)).toBeNull();
  await expect(title(page)).toHaveText('Nothing playing');
  await page.reload();
  await expect(title(page)).toHaveText('Nothing playing');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(hub.ops('adopt')).toEqual([]);
});

test('before its stream connects, a page shows only the same listener their last copy of the player', async ({ page }) => {
  const hub = new SharedPlayerHub();
  const fixture = await playing(page, hub);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('vybertron.player.alex') || 'null')?.player.current?.track.title)).toBe('Midnight City');

  hub.holdStreams();
  await page.reload();
  await expect(title(page)).toHaveText('Midnight City');
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();

  // Someone else signed in on this browser sees nothing of it.
  Object.assign(fixture.state.bootstrap.viewer, { id: 'sam', username: 'sam', displayName: 'Sam' });
  await page.reload();
  await expect(page.getByTestId('player')).toBeVisible();
  await expect(title(page)).toHaveText('Nothing playing');
  await hub.releaseStreams();
});
