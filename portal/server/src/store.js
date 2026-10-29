import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { busy, unavailable } from './security.js';

export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = value => createHash('sha256').update(value).digest('hex');

export class SessionStore {
  constructor(config, limits, now = Date.now) {
    this.directory = config.dataDir; this.file = path.join(this.directory, 'sessions.enc');
    this.key = createHash('sha256').update('vybertron-portal-auth-v1\0').update(config.sessionSecret).digest();
    this.limits = limits; this.now = now; this.sessions = new Map(); this.pendingWrite = Promise.resolve(); this.healthy = true;
  }

  async open() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Auth storage must be a private directory');
    await fs.chmod(this.directory, 0o700);
    let handle;
    try {
      handle = await fs.open(this.file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > this.limits.authFileBytes) throw new Error('Invalid auth storage');
      await fs.chmod(this.file, 0o600);
      const buffer = await handle.readFile();
      if (buffer.subarray(0, 4).toString() !== 'VPA1' || buffer.length < 32) throw new Error('Invalid auth storage');
      const decipher = createDecipheriv('aes-256-gcm', this.key, buffer.subarray(4, 16));
      decipher.setAAD(Buffer.from('vybertron-portal-auth-v1')); decipher.setAuthTag(buffer.subarray(16, 32));
      const records = JSON.parse(Buffer.concat([decipher.update(buffer.subarray(32)), decipher.final()]).toString());
      if (!Array.isArray(records) || records.length > this.limits.sessions) throw new Error('Invalid auth storage');
      for (const record of records) {
        if (!record || !/^[a-f0-9]{64}$/.test(record.key) || !/^\d{1,20}$/.test(record.actorId) ||
            !/^[A-Za-z0-9_-]{43}$/.test(record.csrfToken) || !Number.isSafeInteger(record.createdAt) ||
            !Number.isSafeInteger(record.expiresAt) || (record.renewedAt !== undefined && !Number.isSafeInteger(record.renewedAt)) ||
            this.sessions.has(record.key)) throw new Error('Invalid auth storage');
        // A record outside its lifetime's bounds is dropped, never trusted and never fatal.
        if (this.withinBounds(record) && record.expiresAt > this.now()) this.sessions.set(record.key, record);
      }
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- the cause can quote stored session data.
      if (error.code !== 'ENOENT') throw new Error('Auth storage cannot be safely opened');
    } finally { await handle?.close(); }
  }

  // Records from before renewal expire exactly 7 days after sign-in. A renewed
  // record expires at most 30 days after its last renewal and 90 after sign-in.
  withinBounds({ createdAt, renewedAt, expiresAt }) {
    const limits = this.limits;
    if (renewedAt === undefined) return expiresAt === createdAt + limits.legacySessionMs;
    return renewedAt >= createdAt && expiresAt > renewedAt && expiresAt <= renewedAt + limits.sessionIdleMs
      && expiresAt <= createdAt + limits.sessionAbsoluteMs;
  }

  // Use renews a session at most once a day, up to 90 days after sign-in. The
  // move is made at once, so a concurrent request doesn't renew it again; only
  // a renewal writes the store. Returns the new lifetime in seconds, or null.
  async renew(session) {
    const now = this.now();
    if (now - (session.renewedAt ?? session.createdAt) < this.limits.sessionRenewMs) return null;
    const expiresAt = Math.min(now + this.limits.sessionIdleMs, session.createdAt + this.limits.sessionAbsoluteMs);
    if (expiresAt <= session.expiresAt) return null;
    session.renewedAt = now; session.expiresAt = expiresAt;
    await this.persist();
    return Math.floor((expiresAt - now) / 1000);
  }

  get(token) {
    if (!this.healthy) throw unavailable();
    if (!token) return null;
    const session = this.sessions.get(tokenHash(token));
    if (!session || session.expiresAt <= this.now()) { if (session) this.sessions.delete(session.key); return null; }
    return session;
  }

  async create(actorId, previousToken) {
    if (!this.healthy) throw unavailable();
    for (const [key, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(key);
    const previousKey = previousToken ? tokenHash(previousToken) : null;
    if (this.sessions.size >= this.limits.sessions && !this.sessions.has(previousKey)) throw busy();
    const token = randomToken(); const createdAt = this.now();
    const session = { key: tokenHash(token), actorId, csrfToken: randomToken(), createdAt, renewedAt: createdAt, expiresAt: createdAt + this.limits.sessionIdleMs };
    if (previousKey) this.sessions.delete(previousKey);
    this.sessions.set(session.key, session);
    await this.persist();
    return { token, session, maxAge: Math.floor(this.limits.sessionIdleMs / 1000) };
  }

  async destroy(token) {
    if (!this.healthy) throw unavailable();
    if (token) this.sessions.delete(tokenHash(token));
    await this.persist();
  }

  async persist() {
    const operation = this.pendingWrite.then(async () => {
      const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
      cipher.setAAD(Buffer.from('vybertron-portal-auth-v1'));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify([...this.sessions.values()])), cipher.final()]);
      const body = Buffer.concat([Buffer.from('VPA1'), nonce, cipher.getAuthTag(), encrypted]);
      if (body.length > this.limits.authFileBytes) throw new Error('Auth storage capacity exceeded');
      const temp = path.join(this.directory, `.sessions-${randomToken()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temp, 'wx', 0o600); await handle.writeFile(body); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temp, this.file);
      } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
    });
    this.pendingWrite = operation.catch(() => { this.healthy = false; });
    try { await operation; } catch { this.healthy = false; throw unavailable(); }
  }

  async close() { await this.pendingWrite; this.key.fill(0); }
}
