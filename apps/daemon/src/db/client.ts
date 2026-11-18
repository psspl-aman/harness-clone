import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
  close(): void;
}

/** Locate the SQL migrations folder in both dev (src/) and bundled (dist/) layouts. */
function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '../../drizzle'), join(here, '../drizzle')]) {
    if (existsSync(join(candidate, 'meta/_journal.json'))) return candidate;
  }
  throw new Error(`Could not find drizzle migrations folder near ${here}`);
}

/** Open (or create) the SQLite database and apply pending migrations. */
export function openDb(path: string): DbHandle {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, sqlite, close: () => sqlite.close() };
}
