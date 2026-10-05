// Run twice in separate disposable containers against the same CI-only volume.
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { SessionStore } from './src/store.js';
import { LIMITS } from './src/config.js';

assert.notEqual(process.getuid(), 0, 'Portal runtime must be non-root');
await assert.rejects(writeFile('/app/read-only-check', 'blocked'), { code: 'EROFS' });
const config = { dataDir: '/app/data', sessionSecret: 'ci-only-independent-encryption-key-0000000000' };
const store = new SessionStore(config, LIMITS);
await store.open();
assert.equal((await stat(config.dataDir)).mode & 0o777, 0o700);
const tokenFile = '/app/data/.ci-device-token';
if (process.env.PORTAL_CI_PHASE === 'create') {
  const { token } = await store.create('123456789012345678');
  await writeFile(tokenFile, token, { mode: 0o600 });
  const encrypted = await readFile(store.file);
  assert.equal(encrypted.subarray(0, 4).toString(), 'VPA1');
  assert.equal(encrypted.includes(Buffer.from(token)), false);
  assert.equal(encrypted.includes(Buffer.from('123456789012345678')), false);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
} else if (process.env.PORTAL_CI_PHASE === 'reopen') {
  const token = await readFile(tokenFile, 'utf8');
  assert.equal(store.get(token)?.actorId, '123456789012345678');
  await store.destroy(token);
  assert.equal(store.get(token), null);
  await unlink(tokenFile);
} else {
  throw new Error('CI phase must be create or reopen');
}
await store.close();
console.log('Non-root encrypted device-session container check passed: ' + process.env.PORTAL_CI_PHASE);
