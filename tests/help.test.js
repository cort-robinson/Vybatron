import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelpPayload, HELP_TOPICS } from '../src/utils/help.js';
import { execute } from '../src/commands/help.js';

test('help topics explain existing v2 commands within Discord limits', () => {
  for (const { value } of HELP_TOPICS) {
    const payload = buildHelpPayload({}, value, 'listener');
    const json = payload.embeds[0].toJSON();
    assert.ok(json.title.length <= 256);
    assert.ok(json.description.length <= 4096);
    assert.ok(json.fields.every((field) => field.name.length <= 256 && field.value.length <= 1024));
    assert.ok(json.title.length + json.description.length + json.fields.reduce((total, field) => total + field.name.length + field.value.length, 0) < 6000);
    const options = payload.components[0].components[0].options;
    assert.equal(options.filter((option) => option.data.default).length, 1);
    assert.deepEqual(payload.allowedMentions.parse, []);
  }
  assert.match(buildHelpPayload({}, 'library').embeds[0].data.fields.map((field) => field.value).join(' '), /\/favorite.*\/mix.*\/radio.*\/session.*\/settings/);
});

test('source help reports connected capabilities only and explains Spotify matching', () => {
  const client = { lavalink: { nodeManager: { nodes: new Map([
    ['active', { connected: true, info: { sourceManagers: ['youtube', 'spotify', '@everyone'] } }],
    ['down', { connected: false, info: { sourceManagers: ['unavailable'] } }],
  ]) } } };
  const json = buildHelpPayload(client, 'sources').embeds[0].toJSON();
  assert.match(json.description, /youtube, spotify/);
  assert.ok(json.description.includes('@\u200b'));
  assert.doesNotMatch(json.description, /unavailable/);
  assert.match(json.fields.find((field) => field.name === 'Spotify links').value, /catalog metadata/);
});

test('/help is a private response available without joining voice', async () => {
  let reply;
  await execute({ client: {}, user: { id: 'listener' }, options: { getString: () => 'start' }, async reply(payload) { reply = payload; } });
  assert.equal(reply.flags, 64);
  assert.equal(reply.components[0].components[0].data.custom_id, 'help:v2:topic:listener');
});
