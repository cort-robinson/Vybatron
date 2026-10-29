import { test, expect, type Page } from './test';
import { gotoSession, mockPortal } from './fixtures';
import { SharedPlayerHub } from './shared-player';

// Inside the Android app the app plays this device's songs (ADR-0014). The page talks
// to it through `window.vybatronNative`; here a stand-in follows the same contract
// (portal/android: PortalBridge, PlayerRequest, DevicePlayer) and records each request.
const youtubeTrack = (id: string, title: string) => ({ id: id.padEnd(24, '0'), title, author: 'M83', uri: `https://www.youtube.com/watch?v=${id}`, source: 'youtube',
  durationMs: 244_000, artworkUrl: null, isStream: false, requestedBy: null });

interface Request { id: number; type: string; [key: string]: unknown }
type Bridge = { requests: Request[]; endSong: (quiet?: boolean) => void; notice: (message: string) => void; broadcast: () => void };

async function app(page: Page, shared?: SharedPlayerHub) {
  const fixture = await mockPortal(page, { shared });
  fixture.state.snapshot.session.viewerVoice = null;
  await page.addInitScript(() => {
    type Track = { id: string; durationMs: number };
    const listeners: ((event: { data: string }) => void)[] = [];
    const requests: unknown[] = [];
    let state = { revision: 0, current: null as Track | null, queue: [] as Track[], history: [] as Track[], status: 'idle', positionMs: 0,
      at: Date.now(), waiting: false, durationMs: 0, volume: 100, repeat: 'off' };
    // What the app was already doing when the page opened, if a test says.
    const seed = (window as unknown as { nativeSeed?: Partial<typeof state> }).nativeSeed;
    if (seed) state = { ...state, ...seed, at: Date.now() };
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
        const request = JSON.parse(data);
        // The app names itself (ADR-0016), so the page registers as the Android app.
        if (request.type === 'app.info') { send({ id: request.id, ok: true, result: { platform: 'android', version: '0.2.0', build: 2 } }); return; }
        requests.push(request);
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
  // The page reports for the app, which is listed as the Android app and plays the shared player.
  expect(fixture.shared.devices).toEqual([expect.objectContaining({ name: 'Android app', kind: 'android' })]);
  await expect.poll(() => fixture.shared.player.current?.track.title).toBe('Wait');
  expect(fixture.shared.player.activeDeviceId).toBe(fixture.shared.devices[0].deviceId);
  expect(fixture.shared.ops('report').map(request => request.body.advance?.to ? 'advance' : 'playhead')).toContain('advance');
});

test('a song the app moves on to by itself shows in the page, and so do its notices', async ({ page }) => {
  const fixture = await app(page);
  await addSongs(page);
  await expect(title(page)).toHaveText('Midnight City');
  await expect.poll(async () => (await sent(page, 'player.setQueue')).length).toBe(1);
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.endSong());
  await expect(title(page)).toHaveText('Wait');
  // The page reports the app's song change to the shared player for it.
  await expect.poll(() => fixture.shared.player.current?.track.title).toBe('Wait');
  expect(fixture.shared.player.history.map(entry => entry.track.title)).toEqual(['Midnight City']);
  await page.evaluate(() => (window as unknown as { bridge: Bridge }).bridge.notice('“Wait”: This song can’t be streamed right now. Skipping it.'));
  await expect(page.getByText('“Wait”: This song can’t be streamed right now. Skipping it.')).toBeVisible();
});

test('the shared player reaches the app only when it is played', async ({ page }) => {
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
  // Play makes the app the active device again and loads the player there, playing from its place.
  const types = (await requests(page)).map(request => request.type);
  expect(types).toEqual(['player.subscribe', 'player.load']);
  expect((await sent(page, 'player.load'))[0]).toMatchObject({ playing: true, current: { title: 'Midnight City' }, queue: [{ title: 'Wait' }] });
});

test('Play now jumps the shared player to the chosen song, and the app loads it', async ({ page }) => {
  const fixture = await app(page);
  await page.getByRole('button', { name: 'Add music' }).first().click();
  await page.getByRole('searchbox', { name: 'Music search' }).fill('midnight');
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.getByRole('button', { name: 'Add Wait to queue' }).click();
  await page.getByRole('button', { name: 'Add Midnight City to queue' }).click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await sent(page, 'player.setQueue')).at(-1)?.queue).toHaveLength(2);

  await page.getByRole('button', { name: 'Song options for Wait' }).click();
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(title(page)).toHaveText('Wait');
  // An edit by entry, against the revision shown; the app plays what the store made current.
  const [jump] = fixture.shared.ops('skipTo');
  expect(jump.body).toMatchObject({ entryId: expect.any(String), expectedRevision: expect.any(Number) });
  await expect.poll(async () => (await sent(page, 'player.load')).at(-1)).toMatchObject({ current: { title: 'Wait' }, queue: [{ title: 'Midnight City' }], playing: true });
});

test('Play now as the first thing after a reload plays the chosen song', async ({ page }) => {
  await app(page);
  await addSongs(page);
  await expect.poll(async () => (await sent(page, 'player.setQueue')).length).toBe(1);
  await page.getByRole('button', { name: 'Pause playback' }).click();
  await expect(page.getByRole('button', { name: 'Resume playback' })).toBeEnabled();
  await page.reload();
  await expect(title(page)).toHaveText('Midnight City');

  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Queue' }).click();
  await page.getByRole('button', { name: 'Song options for Wait' }).click();
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(title(page)).toHaveText('Wait');
  await expect(page.getByText('Your queue just changed. Try that again.')).toHaveCount(0);
  expect((await requests(page)).map(request => request.type)).toEqual(['player.subscribe', 'player.load']);
  expect((await sent(page, 'player.load'))[0]).toMatchObject({ playing: true, current: { title: 'Wait' } });
});

test('music the app played on through while its page was gone is reported from its own history', async ({ page }) => {
  const hub = new SharedPlayerHub();
  const songs = ['dX3k_QDnzHE', 'Fk3RbKWbmtg', 'aaaaaaaaaaa', 'bbbbbbbbbbb'].map((id, index) => ({ ...youtubeTrack(id, ['A', 'B', 'C', 'D'][index]), requestedBy: undefined }));
  const [a, b, c, d] = songs.map(({ requestedBy: _requestedBy, ...track }, index) => ({ entryId: `entry${index}`.padEnd(12, 'x'), track }));
  // The player stopped hearing from the app at A, and another device has since moved D up;
  // the app, given A then B, C, D, played B and reached C.
  Object.assign(hub.player, { current: a, queue: [d, b, c], history: [], revision: 3, updatedAt: 1 });
  const handed = (entry: typeof a) => ({ ...entry.track, requestedBy: null, entryId: entry.entryId });
  await page.addInitScript(([played, now, next]) => { (window as unknown as { nativeSeed: unknown }).nativeSeed = { current: now, queue: [next], history: played, status: 'playing', positionMs: 5000, durationMs: 244_000, revision: 7 }; },
    [[handed(b), handed(a)], handed(c), handed(d)] as const);
  await app(page, hub);
  await expect.poll(() => hub.player.current?.track.title).toBe('C');
  expect(hub.ops('report').flatMap(request => request.body.advance ? [[request.body.advance.from, request.body.advance.to]] : [])).toEqual([[a.entryId, b.entryId], [b.entryId, c.entryId]]);
  // D, never played, stays queued; the songs the app played are history.
  expect(hub.player.queue.map(entry => entry.track.title)).toEqual(['D']);
  expect(hub.player.history.map(entry => entry.track.title)).toEqual(['B', 'A']);
});

test('the app\'s catch-up also follows songs it holds without their entry', async ({ page }) => {
  const hub = new SharedPlayerHub();
  const songs = ['dX3k_QDnzHE', 'Fk3RbKWbmtg', 'aaaaaaaaaaa', 'bbbbbbbbbbb'].map((id, index) => ({ ...youtubeTrack(id, ['A', 'B', 'C', 'D'][index]), requestedBy: null }));
  const [a, b, c, d] = songs.map(({ requestedBy: _requestedBy, ...track }, index) => ({ entryId: `entry${index}`.padEnd(12, 'x'), track }));
  Object.assign(hub.player, { current: a, queue: [b, c, d], history: [], revision: 3, updatedAt: 1 });
  // An app that was handed these songs before they carried entries.
  await page.addInitScript(([played, now, next]) => { (window as unknown as { nativeSeed: unknown }).nativeSeed = { current: now, queue: [next], history: played, status: 'playing', positionMs: 5000, durationMs: 244_000, revision: 7 }; },
    [[songs[1], songs[0]], songs[2], songs[3]] as const);
  await app(page, hub);
  await expect.poll(() => hub.player.current?.track.title).toBe('C');
  expect(hub.ops('report').flatMap(request => request.body.advance ? [[request.body.advance.from, request.body.advance.to]] : [])).toEqual([[a.entryId, b.entryId], [b.entryId, c.entryId]]);
  expect(hub.player.queue.map(entry => entry.track.title)).toEqual(['D']);
  expect(hub.player.history.map(entry => entry.track.title)).toEqual(['B', 'A']);
});

test('the app\'s catch-up starts from the exact entry, not an older play of the same song', async ({ page }) => {
  const hub = new SharedPlayerHub();
  const songs = ['dX3k_QDnzHE', 'Fk3RbKWbmtg', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'].map((id, index) => ({ ...youtubeTrack(id, ['A', 'B', 'C', 'D', 'X'][index]), requestedBy: null }));
  const [a, b, c, d] = songs.slice(0, 4).map(({ requestedBy: _requestedBy, ...track }, index) => ({ entryId: `entry${index}`.padEnd(12, 'x'), track }));
  Object.assign(hub.player, { current: a, queue: [b, c, d], history: [], revision: 3, updatedAt: 1 });
  // Newest first: B and A with their entries, then an older X and A played before entries existed.
  const tagged = (index: number, entry: { entryId: string }) => ({ ...songs[index], entryId: entry.entryId });
  await page.addInitScript(([played, now, next]) => { (window as unknown as { nativeSeed: unknown }).nativeSeed = { current: now, queue: [next], history: played, status: 'playing', positionMs: 5000, durationMs: 244_000, revision: 7 }; },
    [[tagged(1, b), tagged(0, a), songs[4], songs[0]], tagged(2, c), tagged(3, d)] as const);
  await app(page, hub);
  await expect.poll(() => hub.player.current?.track.title).toBe('C');
  expect(hub.ops('report').flatMap(request => request.body.advance ? [[request.body.advance.from, request.body.advance.to]] : [])).toEqual([[a.entryId, b.entryId], [b.entryId, c.entryId]]);
  expect(hub.player.queue.map(entry => entry.track.title)).toEqual(['D']);
  expect(hub.player.history.map(entry => entry.track.title)).toEqual(['B', 'A']);
});
