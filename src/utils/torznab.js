// A Torznab indexer (Prowlarr, Jackett) the operator runs. Its URL carries the
// API key, so neither is ever logged or shown.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };

function unescape(value) {
  return String(value).replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);
}

function attribute(item, name) {
  const match = item.match(new RegExp(`<torznab:attr\\s+name="${name}"\\s+value="([^"]*)"`, 'i'));
  return match ? unescape(match[1]) : null;
}

// Each result's info hash and magnet link, in the indexer's order. Results
// without a hash (a .torrent download only) can't be checked against a cache.
export function parseTorznab(xml) {
  const results = [];
  for (const [, item] of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = item.match(/<link>\s*(magnet:[^<\s]+)\s*<\/link>/)?.[1];
    const magnet = attribute(item, 'magneturl') || (link ? unescape(link) : null);
    const hash = (attribute(item, 'infohash') || magnet?.match(/urn:btih:([a-f0-9]{40})/i)?.[1] || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) continue;
    results.push({ hash, magnet: magnet?.startsWith('magnet:') ? magnet : `magnet:?xt=urn:btih:${hash}` });
  }
  return results;
}

export function createTorznab({ url, apiKey = null, fetch = globalThis.fetch, requestMs = 8000 } = {}) {
  async function search(query, signal) {
    const target = new URL(url);
    // 3000 is Torznab's Audio category; free-text search works on every indexer.
    target.searchParams.set('t', 'search');
    target.searchParams.set('q', query);
    target.searchParams.set('cat', '3000');
    if (apiKey) target.searchParams.set('apikey', apiKey);
    const response = await fetch(target, {
      signal: AbortSignal.any([AbortSignal.timeout(requestMs), ...(signal ? [signal] : [])]) });
    if (!response.ok) throw new Error(`Torznab search failed: ${response.status}`);
    return parseTorznab(await response.text());
  }
  return { search };
}
