import { createHash } from 'node:crypto';
import { invalid, unavailable } from './security.js';

// The listener's shared player (ADR-0018): request shapes for POST /api/me/player
// and the checks on what the bot returns. The bot validates and bounds every
// value again; this keeps malformed or oversized input from reaching it.
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const integer = (min, max) => value => Number.isSafeInteger(value) && value >= min && value <= max;
const count = integer(0, Number.MAX_SAFE_INTEGER);
export const validDeviceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
const entryId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value);
const snowflake = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const repeat = value => ['off', 'track', 'queue'].includes(value);
const volume = integer(0, 100);
const position = integer(0, 24 * 60 * 60_000);
export const DEVICE_KINDS = Object.freeze(['browser', 'android', 'tv']);
export function deviceName(value) {
  if (typeof value !== 'string' || /[\0-\x1f\x7f]/.test(value)) return null;
  const name = value.trim();
  return name && name.length <= 40 ? name : null;
}
// A song as the deck keeps it (portal/web Track). A requester or autoplay mark is dropped.
const TRACK_FIELDS = ['id', 'title', 'author', 'uri', 'source', 'durationMs', 'artworkUrl', 'isStream'];
const track = value => object(value) && Object.keys(value).every(key => [...TRACK_FIELDS, 'requestedBy', 'suggested'].includes(key))
  && typeof value.id === 'string' && value.id.length <= 64 && typeof value.title === 'string' && value.title.length <= 1000
  && typeof value.author === 'string' && value.author.length <= 1000 && typeof value.uri === 'string' && value.uri.length <= 512;
const ownTrack = value => Object.fromEntries(TRACK_FIELDS.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const tracks = (min = 1) => value => Array.isArray(value) && value.length >= min && value.length <= 50 && value.every(track);

const req = validate => ({ validate, required: true });
const opt = validate => ({ validate });
const expectedRevision = req(count);
const schemas = {
  add: { expectedRevision, tracks: req(tracks()), position: req(value => value === 'next' || value === 'end' || (object(value) && Object.keys(value).length === 1 && entryId(value.after))), guildId: opt(snowflake) },
  remove: { expectedRevision, entryId: req(entryId) },
  move: { expectedRevision, entryId: req(entryId), before: req(value => value === null || entryId(value)) },
  clear: { expectedRevision }, shuffle: { expectedRevision },
  play: { expectedRevision, tracks: req(tracks()), startIndex: req(integer(0, 49)), guildId: opt(snowflake) },
  skipTo: { expectedRevision, entryId: req(entryId) },
  report: {
    deviceId: req(validDeviceId), generation: req(count),
    advance: opt(value => object(value) && Object.keys(value).every(key => ['from', 'to', 'track'].includes(key))
      && [value.from, value.to].every(id => id === null || entryId(id)) && (value.track === undefined || track(value.track))),
    playhead: opt(value => object(value) && Object.keys(value).length === 3 && position(value.positionMs) && Number.isSafeInteger(value.at) && typeof value.playing === 'boolean'),
    volume: opt(volume), repeat: opt(repeat),
  },
  activate: { deviceId: req(validDeviceId), guildId: opt(snowflake) },
  deactivate: { deviceId: req(validDeviceId), generation: req(count) },
  control: { action: req(value => ['play', 'pause', 'seek', 'next', 'previous', 'volume', 'repeat'].includes(value)), value: opt(() => true) },
  adopt: { tracks: opt(tracks(0)), current: opt(value => value === null || track(value)), positionMs: opt(position), volume: opt(volume), repeat: opt(repeat), guildId: opt(snowflake) },
  rename: { deviceId: req(validDeviceId), name: req(value => deviceName(value) !== null) },
  forget: { deviceId: req(validDeviceId) },
};
// Changes to the device list rather than the player.
export const DEVICE_REQUESTS = Object.freeze(['rename', 'forget']);
const controlValue = { seek: position, volume, repeat };

/** A POST /api/me/player body, as the bot will receive it. */
export function validatePlayerRequest(body) {
  if (!object(body) || typeof body.op !== 'string' || !Object.hasOwn(schemas, body.op)) throw invalid();
  const schema = schemas[body.op];
  for (const [key, value] of Object.entries(body)) if (key !== 'op' && (!Object.hasOwn(schema, key) || !schema[key].validate(value))) throw invalid();
  for (const [key, rule] of Object.entries(schema)) if (rule.required && !Object.hasOwn(body, key)) throw invalid();
  if (body.op === 'control' && (controlValue[body.action] ? !controlValue[body.action](body.value) : body.value !== undefined)) throw invalid();
  if (body.op === 'play' && body.startIndex >= body.tracks.length) throw invalid();
  if (body.op === 'adopt' && !body.current && !body.tracks?.length) throw invalid();
  const request = { ...body };
  if (request.tracks) request.tracks = request.tracks.map(ownTrack);
  if (request.current) request.current = ownTrack(request.current);
  if (request.advance?.track) request.advance = { ...request.advance, track: ownTrack(request.advance.track) };
  if (request.op === 'rename') request.name = deviceName(request.name);
  return request;
}

/** The bot's player for this portal's devices: checked, bounded, devices reduced to their public fields. */
export function playerShape(player, maxBytes) {
  if (!object(player) || !count(player.revision) || !count(player.generation) || !count(player.updatedAt) || !count(player.playbackVersion)
    || !(player.activeDeviceId === null || validDeviceId(player.activeDeviceId)) || !Array.isArray(player.queue) || !Array.isArray(player.history)
    || !object(player.playhead) || Buffer.byteLength(JSON.stringify(player)) > maxBytes) throw unavailable();
  return player;
}
export function playerData(data, maxBytes) {
  if (!object(data) || !Array.isArray(data.devices) || data.devices.length > 10 || !data.devices.every(device => object(device) && validDeviceId(device.deviceId)
    && deviceName(device.name) === device.name && DEVICE_KINDS.includes(device.kind) && count(device.lastSeen))) throw unavailable();
  return { player: playerShape(data.player, maxBytes), devices: data.devices.map(({ deviceId, name, kind, lastSeen }) => ({ deviceId, name, kind, lastSeen })),
    ...(count(data.dropped) && { dropped: data.dropped }) };
}

// What the bot keeps to forget a session's devices at sign-out: derived from
// the session's key, so it can't be used to find or replay the session.
export const deviceSessionRef = sessionKey => createHash('sha256').update('vybertron-portal-device-v1\0').update(sessionKey).digest('base64url');
