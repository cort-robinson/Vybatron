import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { startPortalBridge } from '../src/portal/index.js';
import { attachSessionSnapshots } from '../src/utils/sessions.js';
import { track } from './fixtures.js';
import { openLibrary, closeLibraries } from './library-fixture.js';

export function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
export async function portalFixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vybertron-portal-'));
  const library = await openLibrary(path.join(dir, 'library.json'));
  const client = new EventEmitter(); const manager = new EventEmitter();
  client.library = library; client.lavalink = manager; client.isReady = () => true;
  const users = new Map(['200', '201', '202', '900', '901'].map(id => [id, { id, username: `User ${id}`, bot: false, displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/abcd.png?size=128` }]));
  const members = new Map(); const channels = new Map(); const guild = { id: '100', name: 'Test server', ownerId: '202', iconURL: () => null };
  const me = { id: '999', user: { id: '999', bot: true }, permissions: new PermissionsBitField([P.Administrator]) };
  let memberFetches = 0;
  for (const id of ['200', '201', '202']) members.set(id, { id, user: users.get(id), permissions: new PermissionsBitField(id === '201' ? [P.ManageGuild] : []), displayName: `Member ${id}`, roles: { cache: new Map() }, voice: { channel: null } });
  const channel = (id, type, name) => ({ id, guildId: guild.id, type, name, hidden: new Set(), joinable: true, speakable: true, botWritable: true,
    _clone() { return cloneChannel(this); },
    permissionsFor(member) { return new PermissionsBitField(this.hidden.has(member?.id) ? [] : member?.id === me.id ? this.botWritable ? [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.Connect, P.Speak] : [P.ViewChannel] : [P.ViewChannel]); },
    get members() { return new Map([...members].filter(([, member]) => member.voice.channel?.id === id)); },
  });
  channels.set('300', channel('300', ChannelType.GuildVoice, 'General'));
  channels.set('301', channel('301', ChannelType.GuildVoice, 'Private voice'));
  channels.set('400', channel('400', ChannelType.GuildText, 'music'));
  channels.set('401', channel('401', ChannelType.GuildText, 'alternate music'));
  const roles = new Map([['500', { id: '500', name: 'DJ' }]]);
  const channelReads = [];
  const channelCache = new Map(channels);
  const cloneChannel = channel => channel && { ...channel, hidden: new Set(channel.hidden) };
  guild.channels = { cache: channelCache, async fetch(id, fetchOptions = {}) {
    channelReads.push({ id, ...fetchOptions });
    if (options.channelFetch) await options.channelFetch(id, fetchOptions);
    if (id && !fetchOptions.force && channelCache.has(id)) return channelCache.get(id);
    if (id) {
      const value = cloneChannel(channels.get(id));
      if (!value) throw Object.assign(new Error('Unknown channel'), { code: 10003 });
      if (fetchOptions.cache !== false) channelCache.set(id, value);
      return value;
    }
    return new Map([...channels].map(([key, channel]) => {
      const value = cloneChannel(channel); if (fetchOptions.cache !== false) channelCache.set(key, value); return [key, value];
    }));
  } };
  guild.roles = { cache: new Map(roles), async fetch() { for (const [id, role] of roles) this.cache.set(id, role); return new Map(roles); } };
  guild.members = { get cache() { return members; }, async fetch({ user }) { memberFetches++; if (options.memberFetch) await options.memberFetch(user); const member = members.get(user); if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 }); return member; }, async fetchMe() { return me; } };
  client.guilds = { cache: new Map([['100', guild]]), async fetch() { return guild; } };
  // Faithful raw GET Guild seam: the role inventory is an independent server
  // response, not the Guild/RoleManager cache returned by an SDK fetch.
  client.rest = { async get(route) {
    const server = client.guilds.cache.get(route.split('/').at(-1));
    if (!server) throw Object.assign(new Error('Unknown guild'), { code: 10004 });
    const inventory = new Map(roles); inventory.set(server.id, { id: server.id, name: '@everyone' });
    return { id: server.id, owner_id: server.ownerId, name: server.name, icon: null,
      roles: [...inventory].map(([id, role]) => ({ id, name: role.name, permissions: String(role.permissions?.bitfield ?? role.permissions ?? 0n), position: role.rawPosition ?? 0 })) };
  } };
  client.channels = { cache: channelCache };
  client.users = { async fetch(id) { return users.get(id); } };
  client.application = { id: '123456789012345678', async fetch() { return { owner: options.owner || users.get('900') }; } };
  client.runtimeState = { draining: false, startedAt: Date.now() };
  manager.players = new Map(); manager.getPlayer = id => manager.players.get(id);
  const node = { connected: true, async search({ query }) { if (options.search) return options.search(query); return { loadType: 'track', tracks: [track(query.startsWith('https:') ? new URL(query).searchParams.get('v') || 'abcdefghijk' : 'abcdefghijk')] }; } };
  manager.nodeManager = { nodes: new Map([['main', node]]), leastUsedNodes: () => [node] };
  const calls = [];
  manager.createPlayer = settings => {
    const data = new Map();
    const player = { guildId: '100', voiceChannelId: '300', textChannelId: '400', connected: true, playing: false, paused: false, volume: 100, repeatMode: 'off', position: 8000, lastPosition: 8000, node,
      queue: { current: null, tracks: [], previous: [], utils: { save: async () => {} },
        async add(incoming, index) { calls.push('add'); const tracks = Array.isArray(incoming) ? incoming : [incoming]; if (index === undefined) this.tracks.push(...tracks); else this.tracks.splice(index, 0, ...tracks); },
        async splice(index, count, incoming) { calls.push('splice'); const tracks = incoming ? Array.isArray(incoming) ? incoming : [incoming] : []; return this.tracks.splice(index, count, ...tracks)[0]; },
        async shuffle() { calls.push('shuffle'); this.tracks.reverse(); },
      },
      getData: key => data.get(key), setData: (key, value) => data.set(key, value),
      search: (...args) => node.search(...args), async connect() { calls.push('connect'); this.connected = true; },
      async play(value = {}) { calls.push(['play', value]); this.queue.current = value.clientTrack || this.queue.tracks.shift(); this.position = value.position || 0; this.lastPosition = this.position; this.paused = Boolean(value.paused); this.playing = !this.paused; manager.emit('trackStart', this, this.queue.current); },
      async pause() { calls.push('pause'); this.paused = true; this.playing = false; }, async resume() { calls.push('resume'); this.paused = false; this.playing = true; },
      async seek(value) { calls.push('seek'); this.position = value; this.lastPosition = value; }, async setVolume(value) { calls.push('volume'); this.volume = value; },
      async setRepeatMode(value) { calls.push('loop'); this.repeatMode = value; },
      async skip(index = 1) { calls.push('skip'); this.queue.previous.unshift(this.queue.current); this.queue.current = this.queue.tracks.splice(0, index).at(-1) || null; manager.emit('trackEnd', this); },
      async stopPlaying() { calls.push('stopPlaying'); this.queue.tracks.length = 0; this.playing = false; },
      async destroy(reason) { calls.push('destroy'); if (manager.getPlayer('100') === this) manager.players.delete('100'); this.voiceChannelId = null; this.connected = false; manager.emit('playerDestroy', this, reason); }, ...settings,
    };
    manager.players.set('100', player); return player;
  };
  for (const member of members.values()) member.voice.channel = channels.get('300');
  const player = options.idle ? null : manager.createPlayer({});
  if (player) { player.queue.current = track(); player.queue.tracks.push(track('lmnopqrstuv'), track('01234567890')); player.playing = true; }
  library.stopSnapshots = attachSessionSnapshots(client, { intervalMs: 60_000, logger: { error() {} } });
  await library.updateGuild('100', guild => { guild.settings.musicTextChannelId = '400'; });
  const token = 'portal-test-secret-is-long-enough-32';
  if (options.songs) client.songs = options.songs;
  const bridge = startPortalBridge(client, { token, port: 0, logger: { error() {} }, ...options.bridge });
  await bridge.ready;
  const origin = `http://127.0.0.1:${bridge.server.address().port}`;
  const request = async (resource = '', { actor = '200', body, headers, method, ...rest } = {}) => {
    const endpoint = resource.startsWith('/v1/') || resource === '/health' ? resource : `/v1/guilds/100${resource}${resource.includes('?') ? '&' : '?'}actorId=${actor}`;
    const response = await fetch(`${origin}${endpoint}`, { method: method || (body ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify({ actorId: actor, ...body }) : undefined, ...rest });
    // Headers stay out of deep equality checks on the result.
    return Object.defineProperty({ status: response.status, body: await response.json() }, 'headers', { value: response.headers });
  };
  const command = (body, options) => request('/v1/guilds/100/commands', { body, ...options });
  t.after(async () => { await bridge.close(); await library.close(); await closeLibraries(); await fs.rm(dir, { recursive: true, force: true }); });
  return { client, manager, library, player, members, channels, channelCache, channelReads, roles, users, me, node, guild, calls, bridge, origin, request, command, token, dir, get memberFetches() { return memberFetches; } };
}
