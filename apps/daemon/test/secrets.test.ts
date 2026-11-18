import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secrets } from '../src/db/schema';
import { SecretStore } from '../src/services/secrets';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => t.cleanup());

describe('SecretStore', () => {
  it('round-trips values and never stores plaintext', () => {
    t.ctx.secrets.set('github.token', 'ghp_supersecretvalue123456');
    expect(t.ctx.secrets.get('github.token')).toBe('ghp_supersecretvalue123456');
    const raw = JSON.stringify(t.ctx.db.select().from(secrets).all());
    expect(raw).not.toContain('supersecret');
    t.ctx.secrets.set('github.token', 'rotated-value-000000000');
    expect(t.ctx.secrets.get('github.token')).toBe('rotated-value-000000000');
    t.ctx.secrets.delete('github.token');
    expect(t.ctx.secrets.get('github.token')).toBeNull();
  });

  it('keeps the key file private and survives re-instantiation', () => {
    t.ctx.secrets.set('a', 'value');
    expect(statSync(join(t.home, 'secret.key')).mode & 0o777).toBe(0o600);
    expect(new SecretStore(t.ctx.db, t.home).get('a')).toBe('value');
  });

  it('detects tampering (GCM auth + name binding)', () => {
    t.ctx.secrets.set('a', 'value');
    const row = t.ctx.db.select().from(secrets).get()!;
    t.ctx.db.update(secrets).set({ name: 'b' }).run(); // move ciphertext to another name
    expect(() => t.ctx.secrets.get('b')).toThrow();
    t.ctx.db
      .update(secrets)
      .set({ name: 'a', ciphertext: Buffer.from('garbage').toString('base64') })
      .run();
    expect(() => t.ctx.secrets.get('a')).toThrow();
    expect(row.ciphertext).not.toBe('value');
  });
});
