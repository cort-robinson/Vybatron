import { test, expect, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';

// Inside the Android app the app plays this device's songs (ADR-0014). The page talks
// to it through `window.vybatronNative`; here a stand-in follows the same contract
// (portal/android: PortalBridge, PlayerRequest, DevicePlayer) and records each request.
const youtubeTrack = (id: string, title: string) => ({ id: id.padEnd(24, '0'), title, author: 'M83', uri: `https://www.youtube.com/watch?v=${id}`, source: 'youtube',
  durationMs: 244_000, artworkUrl: null, isStream: false, requestedBy: null });

interface Request { id: number; type: string; [key: string]: unknown }
type Bridge = { requests: Request[]; endSong: (quiet?: boolean) => void; notice: (message: string) => void; broadcast: () => void };

async function app(page: Page) {
  const fixture = await mockPortal(page);
  fixture.state.snapshot.session.viewerVoice = null;
  await page.addInitScript(() => {
    type Track = { id: string; durationMs: number };
    const listeners: ((event: { data: string }) => void)[] = [];
    const requests: unknown[] = [];
    let state = { revision: 0, current: null as Track | null, queue: [] as Track[], history: [] as Track[], status: 'idle', positionMs: 0,
      at: Date.now(), waiting: false, durationMs: 0, volume: 100, repeat: 'off' };
    const send = (message: unknown) => setTimeout(() => { for (const listener of listeners) listener({ data: JSON.stringify(message) }); }, 0);
    const change = (patch: Partial<typeof state>, songs = true) => { state = { ...state, ...patch, at: Date.now(), revision: state.revision + (songs ? 1 : 0) }; };
    const advance = () => {
      const [next, ...rest] = state.queue;
      if (next) change({ current: next, queue: rest, history: [state.current!, ...state.history], status: 'playing', positionMs: 0, durationMs: next.durationMs });
      else change({ current: null, queue: [], history: [], status: 'idle', positionMs: 0, durationMs: 0 });
    };
    (window as unknown as { bridge: Bridge }).bridge = {
      requests: requests as Request[],
      // A song ending in the app, with no page involved.
      endSong: quiet => { advance(); if (!quiet) send({ event: 'player.state', state }); },
      notice: message => send({ event: 'player.notice', message, kind: 'error' }),
      // The app's state, sent to the page unasked.
      broadcast: () => send({ event: 'player.state', state }),
    };
    (window as unknown as { vybatronNative: unknown }).vybatronNative = {
      addEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.push(listener),
      postMessage(data: string) {
        const request = JSON.parse(data); requests.push(request);
        switch (request.type) {
          case 'player.load': change({ current: request.current, queue: request.queue, history: request.history,
            status: request.current ? (request.playing ? 'playing' : 'paused') : 'idle', positionMs: request.positionMs,
            durationMs: request.current?.durationMs ?? 0, volume: request.volume, repeat: request.repeat }); break;
          case 'player.setQueue':
            if (request.revision !== state.revision) { send({ id: request.id, ok: false, error: 'stale' }); return; }
            change({ queue: request.queue }); break;
          case 'player.control':
            if (request.action === 'skipTo') {
              if (request.revision !== state.revision) { send({ id: request.id, ok: false, error: 'stale' }); return; }
              const next = state.queue[request.index];
              change({ current: next, queue: state.queue.slice(request.index + 1), history: [state.current!, ...state.history], status: 'playing', positionMs: 0 });
            }
            if (request.action === 'play') change({ status: 'playing' }, false);
            if (request.action === 'pause') change({ status: 'paused' }, false);
            if (request.action === 'next') advance();
            if (request.action === 'volume') change({ volume: request.level }, false);
            break;
        }
        // Like the app: every change is broadcast before the reply; subscribing only answers.
        if (request.type !== 'player.subscribe') send({ event: 'player.state', state });
        send({ id: request.id, ok: true, result: state });
      },
    };
  });
  const audio: string[] = [];
  await page.route('**/api/guilds/*/audio/*', route => { audio.push(route.request().url()); return route.abort(); });
  await page.route('**/api/guilds/*/search?*', route => route.fulfill({ json: { tracks: [youtubeTrack('dX3k_QDnzHE', 'Midnight City'), youtubeTrack('Fk3RbKWbmtg', 'Wait')], notice: null } }));
  await gotoSession(page);
  return Object.assign(fixture, { audio });
}
const requests = (page: Page) => page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.requests);
const sent = async (page: Page, type: string) => (await requests(page)).filter(request => request.type === type).map(({ id: _id, type: _type, ...rest }) => rest);
const title = (page: Page) => page.getByTestId('player').locator('.compact-track-title');
async function addSongs(page: Page) {
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Wait to queue' }).click();
  await page.keyboard.press('Escape');
}

test('in the Android app, songs on this device play in the app, not in the page', async ({ page }) => {
  const fixture = await app(page);
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  const [load] = await sent(page, 'player.load');
  expect(load).toMatchObject({ guildId: 'testing', current: { title: 'Midnight City', requestedBy: null }, queue: [], playing: true, positionMs: 0 });
  // The second song joined the app's queue, against the revision the page last saw.
  await expect.poll(async () => (await sent(page, 'player.setQueue')).map(request => (request.queue as { title: string }[]).map(track => track.title)))
    .toEqual([['Wait']]);

  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await page.getByRole('button', { name: 'Skip current song' }).click();
  await expect(title(page)).toHaveText('Wait');
  expect(await sent(page, 'player.control')).toEqual([{ action: 'pause' }, { action: 'next' }]);

  // No audio element and no audio download in the page: the app does both.
  await expect(page.locator('audio, video, iframe')).toHaveCount(0);
  expect(fixture.audio).toEqual([]);
  expect(fixture.commands).toEqual([]);
});

test('a song the app moves on to by itself shows in the page, and so do its notices', async ({ page }) => {
  await app(page);
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(async () => (await sent(page, 'player.setQueue')).length).toBe(1);
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.endSong());
  await expect(title(page)).toHaveText('Wait');
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.notice('“Wait”: This song can’t be streamed right now. Skipping it.'));
  await expect(page.getByText('“Wait”: This song can’t be streamed right now. Skipping it.')).toBeVisible();
});

test('a queue saved by the page reaches the app only when it is played', async ({ page }) => {
  await app(page);
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();

  // A new page with an app that has nothing loaded, as after the app was closed. The app's
  // empty state, even sent unasked, leaves the page's saved queue alone.
  await page.reload();
  await expect(title(page)).toHaveText('Midnight City');
  expect((await requests(page)).map(request => request.type)).toEqual(['player.subscribe']);
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.broadcast());
  await page.waitForTimeout(100);
  await expect(title(page)).toHaveText('Midnight City');
  await page.getByRole('button', { name: 'Resume playback' }).click();
  await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
  const types = (await requests(page)).map(request => request.type);
  expect(types).toEqual(['player.subscribe', 'player.load', 'player.control']);
  expect((await sent(page, 'player.load'))[0]).toMatchObject({ playing: false, current: { title: 'Midnight City' }, queue: [{ title: 'Wait' }] });
  expect(await sent(page, 'player.control')).toEqual([{ action: 'play' }]);
});

test('Play now names the queue it was chosen from, and the app refuses it once a song moved on', async ({ page }) => {
  await app(page);
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Wait to queue' }).click();
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await sent(page, 'player.setQueue')).length).toBe(2);

  await page.getByRole('button', { name: 'Song options for Wait' }).click();
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(title(page)).toHaveText('Wait');
  const [jump] = (await sent(page, 'player.control')).filter(request => request.action === 'skipTo');
  expect(jump).toMatchObject({ action: 'skipTo', index: 0, revision: expect.any(Number) });

  // A song ends in the app unseen by the page (no event), then Play now picks from the old list.
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.endSong(true));
  await page.getByRole('button', { name: 'Song options for Midnight City' }).last().click();
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page.getByText('Your queue just changed. Try that again.')).toBeVisible();
});
