import { test, expect, type Page } from '@playwright/test';
import { gotoSession, mockPortal } from './fixtures';

// A stand-in for YouTube's embed API at the network boundary: it records what the
// portal asks the player to do and answers with the player's own state events.
const fakeApi = `
window.ytCalls = [];
window.YT = { Player: class {
  constructor(frame, { events }) { this.events = events; this.state = -1; this.time = 0; this.id = ''; setTimeout(() => events.onReady({ target: this }), 0); }
  emit(state) { this.state = state; this.events.onStateChange({ data: state, target: this }); }
  loadVideoById({ videoId, startSeconds }) { ytCalls.push('load:' + videoId + '@' + (startSeconds || 0)); this.id = videoId; this.time = startSeconds || 0; setTimeout(() => this.emit(1), 0); }
  cueVideoById({ videoId, startSeconds }) { ytCalls.push('cue:' + videoId); this.id = videoId; this.time = startSeconds || 0; setTimeout(() => this.emit(5), 0); }
  playVideo() { ytCalls.push('play'); this.emit(1); }
  pauseVideo() { ytCalls.push('pause'); this.emit(2); }
  stopVideo() { ytCalls.push('stop'); this.state = -1; }
  seekTo(seconds) { ytCalls.push('seek:' + seconds); this.time = seconds; }
  setVolume(volume) { ytCalls.push('volume:' + volume); }
  getCurrentTime() { return this.time; } getDuration() { return 244; } getPlayerState() { return this.state; }
  getVideoData() { return { video_id: this.id }; }
  destroy() {}
} };
window.onYouTubeIframeAPIReady?.();
`;
const youtubeTrack = (id: string, title: string) => ({ id: id.padEnd(24, '0'), title, author: 'M83', uri: `https://www.youtube.com/watch?v=${id}`, source: 'youtube',
  durationMs: 244_000, artworkUrl: null, isStream: false, requestedBy: null });
const general = { id: 'voice', name: 'General' };

async function portal(page: Page, { inVoice, idle = false }: { inVoice: boolean; idle?: boolean }) {
  const fixture = await mockPortal(page);
  const s = fixture.state.snapshot.session;
  s.viewerVoice = inVoice ? general : null;
  if (idle) Object.assign(s, { status: 'idle', current: null, queue: [], listeners: [], voiceChannel: null, canControl: false });
  await page.route('**/api/guilds/*/search?*', route => route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), youtubeTrack('Fk3RbKWbmtg', 'Wait')], notice: null } }));
  await page.route('https://www.youtube.com/iframe_api', route => route.fulfill({ contentType: 'text/javascript', body: fakeApi }));
  await page.route('https://www.youtube-nocookie.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>player</title>' }));
  await gotoSession(page);
  return fixture;
}
const calls = (page: Page) => page.evaluate(() => (window as unknown as { ytCalls?: string[] }).ytCalls || []);
const title = (page: Page) => page.getByTestId('player').locator('.compact-track-title');
const openMenu = (page: Page) => page.getByTestId('player').getByRole('button', { name: 'More playback controls' }).click();
async function playOn(page: Page, choice: string) {
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

test('outside voice the portal plays on this device without sending Discord commands', async ({ page }) => {
  const fixture = await portal(page, { inVoice: false });
  await expect(title(page)).toHaveText('Nothing playing');
  await expect(page.getByRole('heading', { name: 'Your Queue' })).toBeAttached();
  await expect(page.getByLabel('Audio filter')).toHaveCount(0);

  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await expect(page.locator('.local-video iframe')).toBeVisible();
  await expect.poll(() => calls(page)).toContain('load:dX3k_QDnzHE@0');
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Skip current song' }).click();
  await expect(title(page)).toHaveText('Wait');
  await expect.poll(() => calls(page)).toEqual(expect.arrayContaining(['pause', 'load:Fk3RbKWbmtg@0']));
  expect(fixture.commands).toEqual([]);

  // The queue survives a reload, waiting paused for the listener.
  await page.reload();
  await expect(title(page)).toHaveText('Wait');
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await expect.poll(() => calls(page)).toContain('cue:Fk3RbKWbmtg');
  // The Discord session already playing can be joined from here.
  await openMenu(page);
  await expect(page.getByRole('button', { name: 'Join the session in General' })).toBeEnabled();
  expect(fixture.commands).toEqual([]);
});

test('in voice the portal keeps controlling the Discord session', async ({ page }) => {
  await portal(page, { inVoice: true });
  await expect(title(page)).toHaveText('Evening Light');
  await expect(page.locator('.local-video')).toHaveCount(0);
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
  await expect(page.locator('.local-video')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move to General' }).click();
  await expect(title(page)).toHaveText('Moved In');
  const moved = fixture.commands.at(-1)!;
  expect(moved).toMatchObject({ command: 'transfer', tracks: ['https://www.youtube.com/watch?v=dX3k_QDnzHE', 'https://www.youtube.com/watch?v=Fk3RbKWbmtg'],
    options: { paused: false, volume: 100, repeat: 'off' } });
  expect(moved.options!.position).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.local-video')).toHaveCount(0);
  // This device went quiet before Discord took over.
  await expect.poll(() => calls(page)).toContain('pause');
});

test('moving here can leave Discord playing or stop it', async ({ page }) => {
  const fixture = await portal(page, { inVoice: true });
  await playOn(page, 'This device');
  const dialog = page.getByRole('dialog', { name: 'Move playback to this device?' });
  await expect(dialog).toContainText('2 other people are listening in General.');
  await dialog.getByRole('button', { name: 'Listen here too' }).click();
  // Songs from other catalogs play here through their YouTube match, from the same spot.
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(() => calls(page)).toContainEqual(expect.stringMatching(/^load:dX3k_QDnzHE@1\d\d$/));
  await expect(page.locator('.track-row')).toHaveCount(4);
  expect(fixture.commands).toEqual([]);

  await playOn(page, 'Join the session in General');
  await expect(title(page)).toHaveText('Evening Light');
  await playOn(page, 'This device');
  await page.getByRole('dialog').getByRole('button', { name: 'Move here' }).click();
  await expect.poll(() => fixture.commands.map(command => command.command)).toEqual(['stop']);
  await expect(page.locator('.local-video')).toHaveCount(1);
});

test('home lists queue on this device from the tracks the portal already shows', async ({ page }) => {
  await portal(page, { inVoice: false });
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'Play all of On repeat' }).click();
  await expect(title(page)).toHaveText('Midnight City');
  await page.getByRole('button', { name: 'Session', exact: true }).click();
  await expect(page.locator('.track-row')).toHaveCount(3);
  // Saving a song that isn't a favorite needs the Discord session.
  await expect(page.getByTestId('player').getByRole('button', { name: 'Save current song to favorites' })).toBeDisabled();
});
