import { invalid } from './security.js';

const string = max => value => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0-\x1f\x7f]/.test(value);
const integer = (min, max) => value => Number.isInteger(value) && value >= min && value <= max;
const boolean = value => typeof value === 'boolean';
const snowflake = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const choice = values => value => values.includes(value);
const opt = validate => ({ validate });
const required = validate => ({ validate, required: true });
const position = required(integer(1, 500));
const name = required(string(40));
const selectionFields = {
  expectedTrackId: value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value),
  expectedHistoryId: string(40),
  expectedMixVersion: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value),
  expectedImportId: value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value),
};
const selectionFor = {
  'favorite/play': 'expectedTrackId', 'favorite/remove': 'expectedTrackId',
  replay: 'expectedHistoryId', 'mix/delete': 'expectedMixVersion',
  'radio/promote': 'expectedTrackId', 'radio/remove': 'expectedTrackId', 'radio/less': 'expectedTrackId',
};
// Present only to confirm an import preview; without it the command is the preview.
const optionalSelectionFor = { 'favorite/import': 'expectedImportId', 'mix/import': 'expectedImportId' };
const publicLink = value => {
  if (!string(200)(value) || /\s/.test(value)) return false;
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
};
// Match the bot's 4..12-character slash field and parseSeekTimestamp grammar.
const timestamp = value => {
  if (!string(12)(value) || value.length < 4) return false;
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+$/.test(part))) return false;
  return Number(parts.at(-1)) <= 59 && (parts.length === 2 || Number(parts.at(-2)) <= 59);
};

// A device session moving into voice: public song links, current song first.
const transferTracks = value => Array.isArray(value) && value.length >= 1 && value.length <= 100 && value.every(uri => {
  if (!string(512)(uri) || /\s/.test(uri)) return false;
  try { return new URL(uri).protocol === 'https:'; } catch { return false; }
});

const personalPlaylist = { playlist: opt(choice(['mix', 'top', 'rediscover', 'artist'])), artist: opt(string(100)),
  window: opt(choice(['7d', '30d', '90d', '365d', 'all'])) };

// Contract option names deliberately differ from some legacy slash schemas.
// The bot adapter translates skipto(position) and replay(index) at its boundary.
const schemas = {
  play: { query: required(string(200)) }, playnext: { query: required(string(200)) },
  pause: {}, resume: {}, seek: { timestamp: required(timestamp) }, skip: {}, back: {},
  skipto: { position }, stop: {}, clear: {}, remove: { position }, move: { from: position, to: position },
  shuffle: {}, loop: { mode: required(choice(['off', 'track', 'queue'])) },
  volume: { level: required(integer(0, 100)) }, filter: { preset: required(string(40)) }, voteskip: {},
  'radio/on': { track: opt(string(200)) }, 'radio/off': {},
  'radio/promote': { position: required(integer(1, 3)) }, 'radio/remove': { position: required(integer(1, 3)) }, 'radio/less': { position: opt(integer(1, 3)) }, replay: { index: required(integer(1, 100)) },
  'session/resume': {}, 'session/discard': {}, 'session/show': {},
  'sleep/in': { minutes: required(integer(1, 720)) }, 'sleep/after-track': {}, 'sleep/cancel': {}, 'sleep/show': {},
  'favorite/add': { position: opt(integer(1, 500)) }, 'favorite/list': { page: opt(integer(1, 1000)) },
  'favorite/play': { index: required(integer(1, Number.MAX_SAFE_INTEGER)) }, 'favorite/remove': { index: required(integer(1, Number.MAX_SAFE_INTEGER)) },
  'favorite/clear': { confirm: required(boolean) }, 'favorite/import': { link: required(publicLink) },
  'mix/save': { name, replace: opt(boolean), session: opt(boolean) }, 'mix/list': {}, 'mix/load': { name }, 'mix/delete': { name }, 'mix/import': { name, link: required(publicLink) },
  'settings/show': {}, 'settings/volume': { value: required(integer(0, 100)) },
  'settings/fairqueue': { enabled: required(boolean) }, 'settings/autoplay': { mode: required(choice(['off', 'on', 'listening'])) }, 'settings/djrole': { role: opt(value => value === null || snowflake(value)) },
  'settings/reset': {}, 'settings/musicchannel': { channel: required(snowflake) },
  queue: {}, nowplaying: {}, history: {}, help: { topic: opt(string(40)) },
  'top/show': { list: opt(choice(['on-repeat', 'forgotten-gems'])), page: opt(integer(1, 3)) },
  'top/play': { list: opt(choice(['on-repeat', 'forgotten-gems'])), shuffle: opt(boolean) },
  'mymix/show': { ...personalPlaylist, page: opt(integer(1, 3)) },
  'mymix/play': { ...personalPlaylist, shuffle: opt(boolean) },
  transfer: { position: required(integer(0, 24 * 60 * 60_000)), paused: required(boolean), volume: required(integer(0, 100)), repeat: required(choice(['off', 'track', 'queue'])) },
};

export function validateCommand(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['command', 'subcommand', 'options', 'expectedRevision', 'tracks', ...Object.keys(selectionFields)].includes(key)) ||
      typeof body.command !== 'string' || !/^[a-z]+$/.test(body.command) ||
      (body.subcommand !== undefined && (typeof body.subcommand !== 'string' || !/^[a-z]+(?:-[a-z]+)*$/.test(body.subcommand))) ||
      (body.expectedRevision !== undefined && !string(256)(body.expectedRevision))) throw invalid();
  const key = body.subcommand ? `${body.command}/${body.subcommand}` : body.command;
  if (!Object.hasOwn(schemas, key)) throw invalid();
  const selection = selectionFor[key];
  const optional = optionalSelectionFor[key];
  if ((key === 'transfer') !== Object.hasOwn(body, 'tracks') || (key === 'transfer' && !transferTracks(body.tracks))) throw invalid();
  for (const [field, valid] of Object.entries(selectionFields)) {
    if (Object.hasOwn(body, field) && (![selection, optional].includes(field) || !valid(body[field]))) throw invalid();
  }
  if (selection && !Object.hasOwn(body, selection)) throw invalid();
  const schema = schemas[key]; const options = body.options ?? {};
  if (body.options === null || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length > 8) throw invalid();
  for (const [option, value] of Object.entries(options)) {
    if (!Object.hasOwn(schema, option) || !schema[option].validate(value)) throw invalid();
  }
  for (const [option, rule] of Object.entries(schema)) if (rule.required && !Object.hasOwn(options, option)) throw invalid();
  const conflicting = ['clear', 'remove', 'move', 'shuffle', 'skip', 'skipto', 'back', 'seek', 'playnext', 'replay',
    'mix/save', 'favorite/add', 'session/resume', 'session/discard'].includes(key);
  if (conflicting && body.expectedRevision === undefined) throw invalid();
  return { command: body.command, ...(body.subcommand && { subcommand: body.subcommand }),
    options, ...(body.expectedRevision !== undefined && { expectedRevision: body.expectedRevision }),
    ...(selection && { [selection]: body[selection] }), ...(optional && Object.hasOwn(body, optional) && { [optional]: body[optional] }), ...(key === 'transfer' && { tracks: body.tracks }) };
}
