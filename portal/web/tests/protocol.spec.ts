import { test, expect } from '@playwright/test';
import { startHttpFixture } from './http-fixture';

test('HTTP 409 reads both snapshot and library before a deliberate selected-item retry', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.goto(server.origin); await page.getByRole('button', { name: 'My Music', exact: true }).click();
    const button = page.getByRole('button', { name: 'Remove favorite Evening Light' });
    await expect(button).toBeEnabled();
    const selected = server.state.library.favorites[1].id;
    server.state.library.favorites.shift(); server.holdLibraryReads();
    const reads = server.requests.length;
    await button.click();
    await expect.poll(() => server.requests.slice(reads).includes('/api/guilds/testing')).toBe(true);
    await expect.poll(() => server.requests.slice(reads).includes('/api/guilds/testing/library')).toBe(true);
    await expect(button).toBeDisabled();
    expect(server.commands).toEqual([{ command: 'favorite', subcommand: 'remove', options: { index: 2 }, expectedTrackId: selected }]);
    expect(server.state.library.favorites).toHaveLength(1);
    server.releaseLibraryReads();
    await expect(page.getByRole('alert')).toContainText('Review the refreshed state');
    await expect(button).toBeEnabled();
    expect(server.commands).toHaveLength(1);
    await button.click();
    await expect(page.getByRole('heading', { name: 'A place for your repeat favorites' })).toBeVisible();
    expect(server.commands[1]).toEqual({ command: 'favorite', subcommand: 'remove', options: { index: 1 }, expectedTrackId: selected });
    expect(server.commands).toHaveLength(2);
  } finally { await page.close(); await server.close(); }
});

test('real HTTP EventSource disconnect reacquires a snapshot and never replays a mutation', async ({ page }) => {
  const server = await startHttpFixture();
  try {
    await page.goto(server.origin); await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect.poll(() => server.streams.size).toBe(1);
    await page.getByRole('button', { name: 'Add music', exact: true }).click(); await page.getByRole('searchbox', { name: 'Music search' }).fill('native SSE input stays here');
    server.disconnectAndHold();
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeDisabled();
    await expect.poll(() => server.requests.filter(path => path === '/api/guilds/testing').length).toBeGreaterThan(1);
    expect(server.commands).toHaveLength(0);
    server.releaseFreshSnapshot();
    await expect(page.getByRole('button', { name: 'Add to queue', exact: true })).toBeEnabled();
    await expect.poll(() => server.requests.filter(path => path.endsWith('/events')).length).toBeGreaterThan(1);
    await expect(page.getByRole('searchbox', { name: 'Music search' })).toHaveValue('native SSE input stays here');
    expect(server.commands).toHaveLength(0);
    await page.getByRole('button', { name: 'Add to queue', exact: true }).click();
    await expect.poll(() => server.commands.length).toBe(1);
    expect(server.commands[0]).toEqual({ command: 'play', options: { query: 'native SSE input stays here' } });
    await page.getByRole('button', { name: 'Close dialog' }).click(); await expect(page.getByText('Fresh Night Drive', { exact: true })).toBeVisible();
  } finally { await page.close(); await server.close(); }
});

test('production PWA caches only static files, leaves API/auth on the network, and signs out cleanly', async ({ browser }) => {
  const server = await startHttpFixture(); const context = await browser.newContext({ serviceWorkers: 'allow' }); const page = await context.newPage();
  try {
    await page.goto(server.origin); await expect(page.getByRole('button', { name: 'Pause playback' })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const cached = await page.evaluate(async () => { const keys = await caches.keys(); return (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(request => new URL(request.url).pathname)))).flat(); });
    expect(cached).toContain('/index.html'); expect(cached.some(path => /^\/(api|auth|test-art)(\/|$)/.test(path))).toBe(false);
    const before = server.requests.filter(path => path === '/api/bootstrap').length;
    await page.evaluate(() => fetch('/api/bootstrap', { cache: 'no-store' }).then(response => response.json()));
    expect(server.requests.filter(path => path === '/api/bootstrap').length).toBe(before + 1);
    await page.getByRole('button', { name: 'Account options' }).click(); await page.getByRole('button', { name: 'Sign out on this device' }).click();
    await expect(page.getByRole('link', { name: /Continue with Discord/ })).toBeVisible(); await expect(page.getByTestId('player')).toHaveCount(0);
    expect(server.logouts).toEqual([{ method: 'POST', body: '', contentType: undefined, csrfToken: 'local-test-csrf' }]);
    expect(await page.evaluate(() => fetch('/api/bootstrap').then(response => response.status))).toBe(401);
    expect(server.state.snapshot.session.status).toBe('playing'); expect(server.commands).toHaveLength(0);
    await context.setOffline(true);
    const privateFetch = await page.evaluate(() => fetch('/api/bootstrap').then(() => 'cached-private-data').catch(() => 'network-required'));
    expect(privateFetch).toBe('network-required');
    const authFetch = await page.evaluate(() => fetch('/auth/discord').then(() => 'cached-auth').catch(() => 'network-required'));
    expect(authFetch).toBe('network-required');
  } finally { await context.close(); await server.close(); }
});
