import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { botInviteUrl, canInvite, INVITE_PERMISSIONS } from '../src/utils/invite.js';
import { buildHelpPayload } from '../src/utils/help.js';
import { execute } from '../src/commands/invite.js';
import { execute as helpCommand } from '../src/commands/help.js';
import { commandMutationPolicy } from '../src/utils/requests.js';

const appId = '123456789012345678';

test('invite link installs the bot with only the permissions playback needs', () => {
  const url = new URL(botInviteUrl(appId));
  assert.equal(url.origin + url.pathname, 'https://discord.com/oauth2/authorize');
  assert.equal(url.searchParams.get('client_id'), appId);
  assert.equal(url.searchParams.get('scope'), 'bot applications.commands');
  assert.equal(url.searchParams.get('integration_type'), '0');
  assert.equal(BigInt(url.searchParams.get('permissions')), INVITE_PERMISSIONS.bitfield);
  for (const flag of ['ViewChannel', 'SendMessages', 'EmbedLinks', 'Connect', 'Speak', 'SetVoiceChannelStatus']) assert.ok(INVITE_PERMISSIONS.has(PermissionFlagsBits[flag]), flag);
  assert.ok(!INVITE_PERMISSIONS.has(PermissionFlagsBits.Administrator));
  assert.ok(!INVITE_PERMISSIONS.has(PermissionFlagsBits.ManageGuild));
  for (const bad of [undefined, null, '', 'abc', '12', `${appId}&scope=x`]) assert.equal(botInviteUrl(bad), null);
});

const ownerId = '223456789012345678';
const operatorId = '323456789012345678';
const strangerId = '423456789012345678';
const bot = (owner = { id: ownerId }) => ({ operatorIds: new Set([operatorId]), application: { id: appId, owner } });

test('only the application owner, a verified team owner, or an operator may invite', async () => {
  assert.equal(await canInvite(bot(), ownerId), true);
  assert.equal(await canInvite(bot(), operatorId), true);
  assert.equal(await canInvite(bot(), strangerId), false);
  assert.equal(await canInvite(bot(), undefined), false);
  // A team grants the team owner, never every member or the team's own id.
  const team = { id: '523456789012345678', ownerId };
  assert.equal(await canInvite(bot(team), ownerId), true);
  assert.equal(await canInvite(bot(team), team.id), false);
  // An uncached owner is fetched once; a failed lookup grants nothing.
  let fetches = 0;
  const lazy = { application: { id: appId, owner: null, async fetch() { fetches++; return { owner: { id: ownerId } }; } } };
  assert.equal(await canInvite(lazy, ownerId), true); assert.equal(fetches, 1);
  assert.equal(await canInvite({ application: { id: appId, owner: null, fetch: async () => { throw new Error('offline'); } } }, ownerId), false);
});

test('/invite privately gives the owner a link button and everyone else an explanation', async () => {
  assert.equal(commandMutationPolicy('invite').readOnly, true);
  let reply;
  const run = (client, id) => execute({ client, user: { id }, async reply(payload) { reply = payload; } });

  await run(bot(), ownerId);
  assert.equal(reply.flags, 64);
  const button = reply.components[0].components[0].data;
  assert.equal(button.url, botInviteUrl(appId));
  assert.equal(button.label, 'Add Vybatron to a server');

  await run(bot(), strangerId);
  assert.equal(reply.flags, 64);
  assert.equal(reply.components, undefined);
  assert.match(reply.content, /only its owner/);
  assert.doesNotMatch(JSON.stringify(reply), /oauth2/);

  await run({ operatorIds: new Set([operatorId]) }, operatorId);
  assert.equal(reply.components, undefined);
  assert.match(reply.content, /isn’t available/);
});

test('help shows the add-to-server button and tip only when given an invite link', async () => {
  for (const topic of ['start', 'controls']) assert.equal(buildHelpPayload(bot(), topic).components.length, 1);
  assert.ok(!buildHelpPayload(bot(), 'start').embeds[0].data.fields.some((field) => /another server/.test(field.name)));
  const payload = buildHelpPayload(bot(), 'start', ownerId, { inviteUrl: botInviteUrl(appId) });
  assert.equal(payload.components[1].components[0].data.url, botInviteUrl(appId));
  assert.ok(payload.embeds[0].data.fields.some((field) => field.name === 'Bring it to another server'));

  let reply;
  const help = (id) => helpCommand({ client: bot(), user: { id }, options: { getString: () => 'start' }, async reply(payload) { reply = payload; } });
  await help(ownerId); assert.equal(reply.components.length, 2);
  await help(strangerId); assert.equal(reply.components.length, 1);
});
