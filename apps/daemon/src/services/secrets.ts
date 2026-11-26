import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { secrets } from '../db/schema';
import { newId } from '../lib/id';

/**
 * Secrets are encrypted at rest with AES-256-GCM. The 32-byte key lives in
 * `<AI_HARNESS_HOME>/secret.key` (mode 0600), separate from the database, so a
 * copied DB file alone reveals nothing. Plaintext never leaves the daemon.
 */
export class SecretStore {
  private readonly key: Buffer;
  private cachedValues: string[] | null = null;

  constructor(
    private readonly db: Db,
    home: string,
  ) {
    const keyPath = join(home, 'secret.key');
    if (!existsSync(keyPath)) {
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    }
    chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error(`Corrupt secret key at ${keyPath}`);
  }

  set(name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(name));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const row = {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
    this.db
      .insert(secrets)
      .values({ id: newId('sec'), name, ...row })
      .onConflictDoUpdate({ target: secrets.name, set: { ...row, updatedAt: Date.now() } })
      .run();
    this.cachedValues = null;
  }

  get(name: string): string | null {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get();
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'base64'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  delete(name: string): void {
    this.db.delete(secrets).where(eq(secrets.name, name)).run();
    this.cachedValues = null;
  }

  /** Every stored secret value (for redacting logs); cached until a secret changes. */
  values(): string[] {
    if (!this.cachedValues) {
      const out: string[] = [];
      for (const r of this.db.select({ name: secrets.name }).from(secrets).all()) {
        try {
          const v = this.get(r.name);
          if (v && v.length >= 8) out.push(v);
        } catch {
          // A secret written with another key can't be decrypted; skip it.
        }
      }
      this.cachedValues = out.sort((a, b) => b.length - a.length);
    }
    return this.cachedValues;
  }

  has(name: string): boolean {
    return !!this.db.select({ id: secrets.id }).from(secrets).where(eq(secrets.name, name)).get();
  }
}
