import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { settings } from './schema';

/** Small typed key/value helpers on the `settings` table for internal state. */
export function kvGet<T>(db: Db, key: string): T | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return (row?.value as T | undefined) ?? null;
}

export function kvSet(db: Db, key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
    .run();
}

export function kvDelete(db: Db, key: string): void {
  db.delete(settings).where(eq(settings.key, key)).run();
}
