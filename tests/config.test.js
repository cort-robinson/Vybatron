import test from 'node:test';
import assert from 'node:assert/strict';
import { assertConfig, readConfig } from '../src/config.js';

const valid = {
  token: 't',
  clientId: '123456789012345678',
  lavalink: { host: 'localhost', port: 2333, password: 'p' },
};

test('V2: valid config passes', () => {
  assert.doesNotThrow(() => assertConfig(valid));
});

test('configuration rejects malformed endpoints, IDs, secrets, and resource limits without echoing values', () => {
  const invalid = [
    { ...valid, clientId: 'private-input' },
    { ...valid, guildId: 'private-input' },
    { ...valid, token: 'private-input\n' },
    { ...valid, lavalink: { ...valid.lavalink, password: 'private-input\r' } },
    { ...valid, lavalink: { ...valid.lavalink, host: 'https://private-input/path' } },
    ...[0, -1, 65536, NaN, 1.5].map((port) => ({ ...valid, lavalink: { ...valid.lavalink, port } })),
    { ...valid, healthPort: 0 },
    { ...valid, shutdownTimeoutMs: 30_000 },
    { ...valid, dataDir: '../private-input' },
    { ...valid, nodeEnv: 'private-input' },
  ];
  for (const cfg of invalid) {
    assert.throws(() => assertConfig(cfg), (error) => !error.message.includes('private-input'));
  }
});

test('configuration uses bounded defaults and refuses ambiguous numeric environment values', () => {
  const environment = { DISCORD_BOT_TOKEN: 't', CLIENT_ID: valid.clientId, LAVALINK_PASSWORD: 'p' };
  const defaults = readConfig(environment);
  assert.equal(defaults.healthPort, 3000);
  assert.equal(defaults.shutdownTimeoutMs, 10_000);
  assert.equal(defaults.lavalink.port, 2333);
  assert.doesNotThrow(() => assertConfig(defaults));
  for (const value of ['', 'Infinity', '2e3', ' 2333', '2333ms']) {
    assert.throws(() => assertConfig(readConfig({ ...environment, LAVALINK_PORT: value })), /LAVALINK_PORT/);
  }
  assert.doesNotThrow(() => assertConfig(readConfig({ ...environment, LAVALINK_HOST: '::1', LAVALINK_PORT: '2333' })));
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
