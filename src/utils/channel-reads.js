// Forced channel reads write their REST answer into the discord.js cache that
// portal Gateway authority trusts (ADR-0011). An answer can be older than a
// Gateway change that arrived while it was in flight, and discord.js patches
// the cache before its caller resumes. So a channel is untrusted from the
// moment a change crosses any in-flight read of it, and stays untrusted after
// such a read lands, until a later read of it completes with nothing crossing.
// Changes are channel create/update/delete, and anything that re-patches a
// guild's channels without per-channel events: the guild becoming unavailable
// or available again (a new Gateway session marks every guild unavailable
// until its GUILD_CREATE), joining or leaving it, and shard lifecycle events.
//
// Wrap only the call that writes the cache: a wrapper around an already
// tracked read could finish after an older crossed read and clear its mark.
const trackers = new WeakMap();

function tracker(client) {
  let state = trackers.get(client);
  if (state) return state;
  state = { readers: new Map(), stale: new Set() };
  const cross = (guildId, id = null) => {
    for (const [readerGuild, readers] of state.readers) {
      if (guildId && readerGuild !== guildId) continue;
      for (const reader of readers) {
        if (id === null) reader.all = true;
        else if (!reader.ids || reader.ids.has(id)) reader.crossed.add(id);
      }
    }
  };
  const channel = value => { if (value?.guildId && value.id) cross(value.guildId, value.id); };
  const guild = value => {
    if (!value?.id) return;
    cross(value.id);
    // A guild the bot left has no cache to protect; drop its marks.
    if (!client.guilds?.cache?.has?.(value.id)) for (const entry of state.stale) if (entry.startsWith(`${value.id}:`)) state.stale.delete(entry);
  };
  const everything = () => cross(null);
  for (const [event, listener] of [['channelCreate', channel], ['channelUpdate', (_old, value) => channel(value)], ['channelDelete', channel],
    ['guildCreate', guild], ['guildDelete', guild], ['guildAvailable', guild], ['guildUnavailable', guild],
    ['shardReady', everything], ['shardResume', everything], ['shardReconnecting', everything], ['shardDisconnect', everything], ['invalidated', everything]]) {
    client.on?.(event, listener);
  }
  trackers.set(client, state);
  return state;
}

const key = (guildId, id) => `${guildId}:${id}`;
const covers = (reader, id) => !reader.ids || reader.ids.has(id);

// Runs a cache-writing channel fetch for `ids` (null: the guild's whole list).
// On success, `written` names the channels the answer wrote.
export async function trackedChannelRead(client, guildId, ids, fetch, written = result => [...(ids || result?.keys?.() || [])]) {
  const state = tracker(client);
  const reader = { ids: ids && new Set(ids), crossed: new Set(), all: false };
  let readers = state.readers.get(guildId);
  if (!readers) state.readers.set(guildId, readers = new Set());
  readers.add(reader);
  try {
    const result = await fetch();
    for (const id of written(result)) {
      if (reader.all || reader.crossed.has(id)) state.stale.add(key(guildId, id)); else state.stale.delete(key(guildId, id));
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
  for (const reader of state.readers.get(guildId) || []) if (covers(reader, id) && (reader.all || reader.crossed.has(id))) return false;
  if (!state.stale.has(key(guildId, id))) return true;
  // A channel gone from the cache with no read in flight can't hold an old
  // answer; Gateway authority treats it as absent, as REST would.
  if (!client.guilds?.cache?.get?.(guildId)?.channels?.cache?.has?.(id) && ![...(state.readers.get(guildId) || [])].some(reader => covers(reader, id))) {
    state.stale.delete(key(guildId, id));
    return true;
  }
  return false;
}

// Installs the change listeners before the first Gateway authority decision.
export function trackChannelReads(client) { tracker(client); }
