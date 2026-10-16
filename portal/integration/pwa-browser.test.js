// Compiled production web -> real portal static/OAuth/API server -> bot adapter.
// Only external Discord/Lavalink and synthetic artwork boundaries are faked;
// no Vite, application API, or static mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPortalServer } from '../server/src/app.js';
import { loadConfig } from '../server/src/config.js';
import { portalFixture } from '../../tests/portal-fixtures.js';
import { PlayStats } from '../../src/utils/play-stats.js';

const web = fileURLToPath(new URL('../web/', import.meta.url));
const require = createRequire(path.join(web, 'package.json'));
const { chromium } = require('@playwright/test');
const sharp = require('sharp');
const dist = path.join(web, 'dist');
const artifacts = path.join(web, '.impeccable', 'review');

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function cachedPaths(page) {
  return page.evaluate(async () => (await Promise.all((await caches.keys()).map(async name =>
    (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat().sort());
}

test('production PWA installs under real CSP, serves an offline shell, and never caches private reads or writes', { timeout: 60_000 }, async t => {
  const bot = await portalFixture(t);
  // Production runs with the play stats store; Home reads it on load.
  bot.client.stats = await new PlayStats(':memory:', { logger: { error() {} } }).open();
  t.after(() => bot.client.stats.close());
  // These synthetic Discord users have no avatar, so verification needs no CDN.
  for (const user of bot.users.values()) user.displayAvatarURL = () => null;
  // The real bot projection derives YouTube artwork from these fake track IDs.
  // Fulfill only their exact HTTPS image URLs, preserving public track identity
  // and allowing every other resource error to reach the existing assertions.
  const artworkUrls = new Set(['abcdefghijk', 'lmnopqrstuv', '01234567890']
    .map(id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`));
  const artworkPng = await sharp({ create: { width: 1, height: 1, channels: 4,
    background: { r: 0, g: 200, b: 255, alpha: 1 } } }).png().toBuffer();
  const origin = `http://127.0.0.1:${await freePort()}`;
  let app; let browser;
  const discord = http.createServer(async (req, res) => {
    if (req.url.startsWith('/authorize?')) {
      const authorize = new URL(req.url, 'http://mock-discord.test');
      assert.equal(authorize.searchParams.get('redirect_uri'), origin + '/auth/discord/callback');
      res.writeHead(302, { location: origin + '/auth/discord/callback?code=pwa-test-code&state=' + authorize.searchParams.get('state') });
      res.end(); return;
    }
    for await (const _ of req) { /* consume the real OAuth form */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/token'
      ? { access_token: 'independent-pwa-test-oauth', token_type: 'Bearer', scope: 'identify' }
      : { id: '200', username: 'listener' }));
  });
  t.after(async () => {
    try { await browser?.close(); } finally {
      try { await app?.close(); } finally {
        discord.closeAllConnections();
        if (discord.listening) await new Promise(resolve => discord.close(resolve));
      }
    }
  });
  discord.listen(0, '127.0.0.1'); await once(discord, 'listening');
  const discordOrigin = `http://127.0.0.1:${discord.address().port}`;
  const secret = 'independent-pwa-test-session-key-123456789';
  app = await createPortalServer({ ...loadConfig({ NODE_ENV: 'test', PORTAL_ORIGIN: origin,
    PORTAL_BOT_URL: bot.origin, PORTAL_BRIDGE_TOKEN: bot.token, DISCORD_CLIENT_SECRET: secret,
    DISCORD_CLIENT_ID: '123456789012345678', PORTAL_SESSION_SECRET: secret,
    PORTAL_DATA_DIR: path.join(bot.dir, 'pwa-auth'), PORTAL_WEB_DIST: dist,
    PORTAL_PORT: String(new URL(origin).port) }), discordAuthorizeUrl: discordOrigin + '/authorize' }, { discordOrigin });
  const requests = [];
  app.server.prependListener('request', req => requests.push({ method: req.method, path: new URL(req.url, origin).pathname }));
  await app.listen();
  const count = (method, resource) => requests.filter(req => req.method === method && req.path === resource).length;

  // Fetch every generated precache URL through the actual static handler, before
  // Chrome can hide a rejected extension behind a mock or an existing cache.
  const worker = await fetch(origin + '/sw.js', { signal: AbortSignal.timeout(5_000) });
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('cache-control'), 'no-store');
  assert.equal(worker.headers.get('service-worker-allowed'), '/');
  const source = await worker.text();
  const files = JSON.parse(source.match(/^const FILES = (\[.*\]);$/m)?.[1] || 'null');
  assert.ok(Array.isArray(files) && files.includes('/index.html'));
  for (const resource of files) {
    const response = await fetch(origin + resource, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, `Unservable precache URL: ${resource}`);
    await response.arrayBuffer();
  }
  const fontPaths = files.filter(resource => resource.endsWith('.woff2'));
  assert.ok(fontPaths.some(resource => resource.includes('vietnamese')), 'Small font subsets must be self-hosted too');
  const css = (await Promise.all(files.filter(resource => resource.endsWith('.css')).map(resource => readFile(path.join(dist, resource), 'utf8')))).join('\n');
  assert.doesNotMatch(css, /url\(["']?data:/i, 'CSP must not require inline font data');
  const expectedPaths = [...files].sort();
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({ channel: process.env.CI ? undefined : 'chrome' });
  t.diagnostic(`${process.env.CI ? 'Bundled Chromium' : 'Installed Chrome'} ${browser.version()}`);

  for (const [name, width, height] of [['desktop', 1488, 1056], ['phone', 393, 852]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      const artworkRequests = new Set();
      // Playwright route() enables interception for all requests, which changes
      // OAuth redirect reporting on a worker-controlled page. Exact CDP patterns
      // keep every application/static/auth request on its untouched network path.
      const artworkSession = await context.newCDPSession(page);
      artworkSession.on('Fetch.requestPaused', async event => {
        assert.ok(artworkUrls.has(event.request.url));
        assert.equal(event.request.method, 'GET');
        assert.equal(event.resourceType, 'Image');
        artworkRequests.add(event.request.url);
        // Mirrors i.ytimg.com, which serves public artwork with Access-Control-Allow-Origin: *.
        await artworkSession.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: artworkPng.toString('base64') });
      });
      await artworkSession.send('Fetch.enable', { patterns: [...artworkUrls].map(urlPattern =>
        ({ urlPattern, resourceType: 'Image', requestStage: 'Request' })) });
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(10_000);
      const errors = []; const pageErrors = []; const failures = []; const privateResponses = [];
      let online = true;
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && /^\/(api|auth)(\/|$)/.test(url.pathname)) {
          privateResponses.push({ path: url.pathname, status: response.status(), cacheControl: response.headers()['cache-control'] });
        }
      });
      page.on('console', message => {
        if (message.type() !== 'error' || !online) return;
        const resource = new URL(message.location().url || origin, origin).pathname;
        if (/\/api(?:\/|$)/.test(resource) && /status of 401\b/.test(message.text())) return;
        errors.push({ resource: (message.location().url || '').split('?')[0], message: message.text() });
      });
      page.on('requestfailed', request => {
        const resource = new URL(request.url()).pathname;
        const error = request.failure()?.errorText;
        // Chrome can report a bodyless HEAD as aborted even after its 200. The
        // explicit HEAD probe below checks that status and the server request.
        if (request.method() === 'HEAD' && resource === '/index.html' && error === 'net::ERR_ABORTED') return;
        if (online) failures.push(resource + ': ' + error);
      });
      await page.addInitScript(() => {
        window.__pwaCspViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.__pwaCspViolations.push(event.effectiveDirective));
      });
      await page.goto(origin + '/');
      await page.getByRole('link', { name: /Continue with Discord/ }).waitFor();
      const documentResponse = await context.request.get(origin + '/');
      assert.match(documentResponse.headers()['content-security-policy'], /(?:^|; )font-src 'self'(?:;|$)/);
      assert.equal(await page.evaluate(() => window.isSecureContext), true);
      // The application registers the real generated worker; the test never does.
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated', null, { timeout: 10_000 });
      const registration = await page.evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        return { count: registrations.length, script: navigator.serviceWorker.controller.scriptURL,
          scope: registrations[0].scope, active: registrations[0].active.state };
      });
      assert.deepEqual(registration, { count: 1, script: origin + '/sw.js', scope: origin + '/', active: 'activated' });
      assert.deepEqual(await cachedPaths(page), expectedPaths);

      // Exercise every subset, including the small Vietnamese file, and the Fantastic look's
      // display face, which the default look never requests on its own.
      const fonts = await page.evaluate(async () => {
        await document.fonts.load('500 16px "Archivo Variable"', 'Aa Ā ế');
        await document.fonts.load('400 16px "Michroma"', 'Aa');
        await document.fonts.ready;
        return { loaded: document.fonts.check('500 16px "Archivo Variable"', 'Aa Ā ế'),
          states: [...document.fonts].map(font => font.status) };
      });
      assert.equal(fonts.loaded, true);
      assert.ok(fonts.states.length > 0 && fonts.states.every(state => state === 'loaded'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: path.join(artifacts, 'production-pwa-' + name + '.png'), fullPage: true });

      const manifest = await page.evaluate(() => fetch(document.querySelector('link[rel="manifest"]').href).then(response => response.json()));
      assert.equal(manifest.name, 'Vybatron'); assert.equal(manifest.display, 'standalone');
      assert.equal(manifest.id, '/'); assert.equal(manifest.start_url, '/'); assert.equal(manifest.scope, '/');
      assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
      assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
      assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
      for (const icon of manifest.icons) {
        assert.equal(new URL(icon.src, origin).origin, origin);
        assert.ok(files.includes(icon.src));
        const response = await context.request.get(origin + icon.src);
        assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], icon.type);
        const metadata = await sharp(await response.body()).metadata();
        assert.equal(metadata.format, 'png'); assert.equal(`${metadata.width}x${metadata.height}`, icon.sizes);
      }

      if (name === 'desktop') {
        const authStarts = count('GET', '/auth/discord');
        await page.getByRole('link', { name: /Continue with Discord/ }).click();
        await page.getByRole('button', { name: 'Pause playback' }).waitFor();
        // Home is the landing view; the queued songs' artwork renders in Session.
        await page.getByRole('button', { name: 'Session', exact: true }).click();
        await page.locator('.queue .track-row').first().waitFor();
        await page.evaluate(() => Promise.allSettled([...document.images].map(image => image.decode())));
        assert.deepEqual([...artworkRequests].sort(), [...artworkUrls].sort());
        assert.equal(count('GET', '/auth/discord'), authStarts + 1);
        assert.ok(privateResponses.some(response => response.path === '/auth/discord/callback' &&
          response.status === 302 && response.cacheControl === 'no-store'), 'OAuth callback must remain an actual no-store redirect');
        const privateReads = ['/api/bootstrap', '/api/guilds/100', '/api/guilds/100/library'];
        const read = resource => page.evaluate(async resource => {
          const response = await fetch(resource);
          return { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() };
        }, resource);
        const bootstrap = await read('/api/bootstrap');
        const snapshot = await read('/api/guilds/100');
        const commandPath = '/api/guilds/100/commands';
        const commandCount = count('POST', commandPath);
        const saved = await page.evaluate(async ({ csrfToken, revision, resource }) => {
          const response = await fetch(resource, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ command: 'favorite', subcommand: 'add', expectedRevision: revision }) });
          return { status: response.status, cacheControl: response.headers.get('cache-control') };
        }, { csrfToken: bootstrap.body.csrfToken, revision: snapshot.body.revision, resource: commandPath });
        assert.deepEqual(saved, { status: 200, cacheControl: 'no-store' });
        assert.equal(count('POST', commandPath), commandCount + 1);
        for (const resource of privateReads) {
          const before = count('GET', resource);
          const result = await read(resource);
          assert.equal(result.status, 200); assert.equal(result.cacheControl, 'no-store');
          assert.ok(count('GET', resource) > before, `Private read must reach the API: ${resource}`);
          if (resource.endsWith('/library')) assert.equal(result.body.favorites.length, 1);
        }
        // HEAD is non-GET but succeeds on a cached static URL. It must still reach
        // the server, proving the method guard independently of /api exclusions.
        const heads = count('HEAD', '/index.html');
        assert.equal(await page.evaluate(() => fetch('/index.html', { method: 'HEAD' }).then(response => response.status)), 200);
        assert.equal(count('HEAD', '/index.html'), heads + 1);
        await page.getByRole('button', { name: 'Account options' }).click();
        await page.getByRole('button', { name: 'Sign out on this device' }).click();
        await page.getByRole('link', { name: /Continue with Discord/ }).waitFor();
        assert.equal((await read('/api/bootstrap')).status, 401);
        assert.equal((await read('/api/guilds/100/library')).status, 401);
        assert.equal(bot.player.playing, true);
        assert.deepEqual(await cachedPaths(page), expectedPaths, 'Successful favorites, commands and logout must not change the shell cache');
      }
      assert.deepEqual(errors, []); assert.deepEqual(failures, []); assert.deepEqual(pageErrors, []);
      assert.ok(privateResponses.length > 0 && privateResponses.every(response => response.cacheControl === 'no-store'),
        'All API/auth responses, including real OAuth redirects and favorites, must be no-store: ' + JSON.stringify(privateResponses));
      assert.deepEqual(await page.evaluate(() => window.__pwaCspViolations), []);

      const commandsBeforeOffline = count('POST', '/api/guilds/100/commands');
      online = false; await context.setOffline(true);
      const reload = await page.reload({ waitUntil: 'load' });
      assert.equal(reload.fromServiceWorker(), true);
      await page.getByRole('heading', { name: 'A better vibe together.' }).waitFor();
      assert.equal(await page.evaluate(() => document.fonts.ready.then(() => document.fonts.check('500 16px "Archivo Variable"'))), true);
      const uncached = await page.evaluate(async () => {
        const probes = [['/api/bootstrap', 'GET'], ['/api/guilds/100/library', 'GET'], ['/auth/discord', 'GET'], ['/health', 'GET'],
          ['/index.html', 'HEAD'], ['/api/guilds/100/commands', 'POST'], ['/auth/logout', 'POST']];
        return Promise.all(probes.map(async ([resource, method]) => {
          try { await fetch(resource, { method, signal: AbortSignal.timeout(3_000) }); return resource + ': cached'; }
          catch { return resource + ': network-required'; }
        }));
      });
      assert.ok(uncached.every(result => result.endsWith(': network-required')), JSON.stringify(uncached));
      assert.deepEqual(await cachedPaths(page), expectedPaths);
      assert.deepEqual(pageErrors, []); assert.deepEqual(await page.evaluate(() => window.__pwaCspViolations), []);
      await context.setOffline(false);
      await page.evaluate(() => fetch('/health').then(response => response.arrayBuffer()));
      assert.equal(count('POST', '/api/guilds/100/commands'), commandsBeforeOffline, 'Offline writes must not replay');
    } finally { await context.close(); }
  }
});
