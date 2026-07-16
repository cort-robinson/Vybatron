import { isUrl, plainText, safeUrl } from './presentation.js';

const CACHE_TTL_MS = 15_000;
const CACHE_LIMIT = 100;
const RESULT_LIMIT = 8;
const searchCache = new Map();

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    searchCache.delete(key);
    return null;
  }
  searchCache.delete(key);
  searchCache.set(key, entry);
  return entry.choices;
}

function cacheChoices(key, choices) {
  if (searchCache.has(key)) searchCache.delete(key);
  while (searchCache.size >= CACHE_LIMIT) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { choices, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Autocomplete search timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function choiceFromTrack(track) {
  const info = track?.info || {};
  const title = plainText(info.title, { fallback: 'Unknown track', maxLength: 72 });
  const author = plainText(info.author, { fallback: 'Unknown artist', maxLength: 26 });
  const label = plainText(`${title} — ${author}`, { maxLength: 100 });
  const uri = safeUrl(info.uri);
  const value = uri && uri.length <= 100
    ? uri
    : plainText(`${info.title || title} ${info.author || author}`, { maxLength: 100 });
  return { name: label, value };
}

export async function getTrackChoices(interaction, { timeoutMs = 2_500 } = {}) {
  const query = plainText(interaction.options.getFocused(), { fallback: '', maxLength: 200 });
  if (Array.from(query).length < 2 || isUrl(query)) return [];

  const cacheKey = query.toLocaleLowerCase();
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const node = interaction.client.lavalink?.nodeManager?.leastUsedNodes?.()[0];
  if (!node?.search) return [];

  try {
    const result = await withTimeout(
      node.search({ query, source: 'ytsearch' }, interaction.user),
      timeoutMs
    );
    const choices = [];
    const seenValues = new Set();
    for (const track of result?.tracks || []) {
      const choice = choiceFromTrack(track);
      if (!choice.value || seenValues.has(choice.value)) continue;
      seenValues.add(choice.value);
      choices.push(choice);
      if (choices.length >= RESULT_LIMIT) break;
    }
    cacheChoices(cacheKey, choices);
    return choices;
  } catch {
    return [];
  }
}

export async function autocompleteTracks(interaction) {
  return interaction.respond(await getTrackChoices(interaction));
}

export function resetAutocompleteCache() {
  searchCache.clear();
}
