// Forced channel reads write their REST answer into the discord.js cache that
// portal Gateway authority trusts (ADR-0011). An answer can be older than a
// Gateway update that arrived while it was in flight, and discord.js patches
// the cache before its caller resumes. So a channel is untrusted from the
// moment an update crosses any in-flight read of it, and stays untrusted after
// such a read lands, until a later read of it completes with no update in
// between. A deleted channel never does, so it stays untrusted.
const trackers = new WeakMap();

function tracker(client) {
  let state = trackers.get(client);
  if (state) return state;
  state = { readers: new Map(), stale: new Set() };
  const crossed = channel => {
    if (!channel?.guildId || !channel.id) return;
    for (const reader of state.readers.get(channel.guildId) || []) if (!reader.ids || reader.ids.has(channel.id)) reader.crossed.add(channel.id);
  };
  client.on?.('channelCreate', crossed);
  client.on?.('channelUpdate', (_old, channel) => crossed(channel));
  client.on?.('channelDelete', crossed);
  trackers.set(client, state);
  return state;
}

const key = (guildId, id) => `${guildId}:${id}`;

// Runs a cache-writing channel fetch for `ids` (null: the guild's whole list).
// On success, `written` names the channels the answer wrote.
export async function trackedChannelRead(client, guildId, ids, fetch, written = result => [...(ids || result?.keys?.() || [])]) {
  const state = tracker(client);
  const reader = { ids: ids && new Set(ids), crossed: new Set() };
  let readers = state.readers.get(guildId);
  if (!readers) state.readers.set(guildId, readers = new Set());
  readers.add(reader);
  try {
    const result = await fetch();
    for (const id of written(result)) {
      if (reader.crossed.has(id)) state.stale.add(key(guildId, id)); else state.stale.delete(key(guildId, id));
    }
    for (const id of reader.crossed) state.stale.add(key(guildId, id));
    return result;
  } finally {
    readers.delete(reader);
    if (!readers.size && state.readers.get(guildId) === readers) state.readers.delete(guildId);
  }
}

export function channelTrusted(client, guildId, id) {
  const state = trackers.get(client);
  if (!state) return true;
  if (state.stale.has(key(guildId, id))) return false;
  for (const reader of state.readers.get(guildId) || []) if (reader.crossed.has(id)) return false;
  return true;
}

// Installs the update listeners before the first Gateway authority decision.
export function trackChannelReads(client) { tracker(client); }
