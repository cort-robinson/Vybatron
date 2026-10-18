import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('../dist/', import.meta.url);
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
await writeFile(join(directory, 'sw.js'), `// Generated static-shell cache. Private API/auth/artwork responses are never cached.
const CACHE = 'vybertron-shell-${version}';
const FILES = ${JSON.stringify(urls)};
const STATIC = new Set(FILES);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
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
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then(cache => cache.match('/index.html'))));
    return;
  }
  if (!STATIC.has(url.pathname) || url.search) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(url.pathname).then(cached => cached || fetch(event.request))));
});
`);
console.log(`Static shell ${version}: ${urls.length} files; API/auth excluded.`);
