import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url);
const NAVIGATION_WAIT_MS = 2500;
const files = [];
// Match the real portal static server's supported extensions. Public provenance
// and other metadata are copied by Vite, but a 404 would abort the entire install.
const staticExtensions = new Set(['.html', '.js', '.css', '.json', '.webmanifest',
  '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.ico', '.woff', '.woff2']);
async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.name !== 'sw.js' && staticExtensions.has(extname(path).toLowerCase())) files.push(path);
  }
}
const { fileURLToPath } = await import('node:url');
const directory = fileURLToPath(root);
await collect(directory);
const hash = createHash('sha256');
for (const path of files.sort()) hash.update(await readFile(path));
const urls = files.map(path => '/' + relative(directory, path).replaceAll('\\', '/'));
const version = hash.digest('hex').slice(0, 16);
// Installed up front: what the first screen needs. The rest (the MilkDrop visualizer, the large
// fallback covers, the legacy font format and fonts for other scripts) is still served by this
// worker, from the browser's own cache of these never-changing files, when a page asks for it.
const onDemand = [/\/milkdrop-[\w-]+\.js$/, /\/fallback-cover-(?:640|1024)[\w.-]*\.webp$/, /\.woff$/, /-(?:latin-ext|cyrillic|cyrillic-ext|greek|greek-ext|vietnamese)-[^/]*\.woff2$/];
const precached = urls.filter(url => !onDemand.some(pattern => pattern.test(url)));
await writeFile(join(directory, 'sw.js'), `// Generated static-shell cache. Private API/auth/artwork responses are never cached.
const CACHE = 'vybertron-shell-${version}';
const FILES = ${JSON.stringify(urls)};
const STATIC = new Set(FILES);
const PRECACHED = ${JSON.stringify(precached)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHED))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('vybertron-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => { if (event.data?.type === 'ACTIVATE') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || /^\\/(api|auth)(\\/|$)/.test(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    // A shared link stays on this device: the share target opens the shell without sending its query.
    if (url.pathname === '/share') {
      event.respondWith(caches.open(CACHE).then(cache => cache.match('/index.html')).then(cached => cached || fetch('/index.html')));
      return;
    }
    // The server's page when it answers promptly; on a slow or lost connection, the installed
    // shell after ${NAVIGATION_WAIT_MS} ms instead of a blank screen until the network gives up.
    const shell = () => caches.open(CACHE).then(cache => cache.match('/index.html'));
    const page = fetch(event.request);
    event.respondWith(Promise.race([page, new Promise(resolve => setTimeout(resolve, ${NAVIGATION_WAIT_MS}))])
      .then(response => response || shell().then(cached => cached || page), () => shell()));
    return;
  }
  if (!STATIC.has(url.pathname) || url.search) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname).then(cached => cached || fetch(event.request))));
});
`);
console.log(`Static shell ${version}: ${urls.length} files, ${precached.length} installed up front; API/auth excluded.`);
