import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig } from '../src/config.js';

const valid = {
  token: 't',
  clientId: 'c',
  lavalink: { host: 'localhost', port: 2333, password: 'p' },
};

test('V2: valid config passes', () => {
  assert.doesNotThrow(() => assertConfig(valid));
});

test('V2: missing DISCORD_BOT_TOKEN throws', () => {
  assert.throws(() => assertConfig({ ...valid, token: undefined }), /DISCORD_BOT_TOKEN/);
});

test('V2: missing CLIENT_ID throws', () => {
  assert.throws(() => assertConfig({ ...valid, clientId: undefined }), /CLIENT_ID/);
});

test('V2: missing LAVALINK_PASSWORD throws', () => {
  assert.throws(
    () => assertConfig({ ...valid, lavalink: { ...valid.lavalink, password: undefined } }),
    /LAVALINK_PASSWORD/
  );
});
