import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { portalFixture, deferred } from './portal-fixtures.js';
import { createOrUpdate, refresh, clearController } from '../src/utils/player-controller.js';
import { updateVoiceStatus, resetVoiceStatusWarnings } from '../src/utils/voice-status.js';
import { presentationPlayerActive } from '../src/utils/presentation-updates.js';
import { handleMessageComponent } from '../src/utils/components.js';
import { startIdleTimer, clearIdleTimer } from '../src/lavalink.js';

for (const terminal of ['portal Stop', 'component Stop', 'idle disconnect']) {
  test(`${terminal} destroys playback while owned cosmetic REST writes are held`, { timeout: 5000 }, async t => {
    const f = await portalFixture(t);
    f.client.user = f.me.user;
    const release = deferred(), controllerStarted = deferred(), voiceStarted = deferred();
    let controllerWrites = 0, voiceWrites = 0;
    const channel = f.channelCache.get('400');
    const message = { id: 'terminal-latency-message', async edit() {
      controllerWrites++; controllerStarted.resolve(); await release.promise; return message;
    } };
    channel.send = async () => message;
    channel.messages = { fetch: async () => message };
    const permissions = f.channelCache.get('300').permissionsFor.bind(f.channelCache.get('300'));
    f.channelCache.get('300').permissionsFor = member => member?.id === '999'
      ? new PermissionsBitField([P.Administrator]) : permissions(member);
    f.client.rest = { ...f.client.rest, async put() { voiceWrites++; voiceStarted.resolve(); await release.promise; } };
    await createOrUpdate(f.client, f.player);
    const pendingController = refresh(f.client, f.player), pendingVoice = updateVoiceStatus(f.client, f.player);
    try {
      await Promise.race([
        Promise.all([controllerStarted.promise, voiceStarted.promise]),
        delay(1000).then(() => assert.fail('fixture cosmetic writes did not start')),
      ]);
      assert.equal(controllerWrites, 1); assert.equal(voiceWrites, 1);
      let operation;
      if (terminal === 'portal Stop') operation = f.command({ command: 'stop' }).then(result => {
        assert.equal(result.status, 200);
        assert.equal(f.library.readGuild('100').session, null, 'durable Stop cleanup still completes');
      });
      else if (terminal === 'component Stop') operation = handleMessageComponent({
        client: f.client, guildId: '100', channelId: '400', customId: 'player:v1:stop-confirm',
        user: f.users.get('200'), member: f.members.get('200'), memberPermissions: f.members.get('200').permissions,
        isButton: () => true, async update() {}, async followUp() {}, async reply() { assert.fail('authorized Stop rejected'); },
      });
      else {
        startIdleTimer(f.player, { client: f.client, ms: 5 });
        operation = (async () => { for (let n = 0; n < 100 && !f.calls.includes('destroy'); n++) await delay(5); })();
      }
      await Promise.race([operation, delay(1000).then(() => assert.fail('cosmetic REST blocked physical shutdown'))]);
      assert.ok(f.calls.includes('destroy'));
      assert.equal(f.manager.getPlayer('100'), undefined);
      assert.equal(presentationPlayerActive(f.client, f.player), false);
      assert.equal(controllerWrites, 1, 'terminal presentation waits behind actual unsettled edit');
      assert.equal(voiceWrites, 1, 'terminal clear waits behind actual unsettled status PUT');
    } finally {
      clearIdleTimer('100'); release.resolve();
      await Promise.all([pendingController, pendingVoice]);
      clearController('100'); resetVoiceStatusWarnings();
    }
  });
}
