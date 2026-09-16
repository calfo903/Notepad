import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * Database access.
 *
 * The Neon HTTP driver is used because Edge Functions cannot open a TCP
 * socket. `Database` is typed against the dialect-agnostic `PgDatabase` so the
 * repository works unchanged against PGlite in tests.
 */

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export class DatabaseNotConfiguredError extends Error {
  override readonly name = 'DatabaseNotConfiguredError';

  constructor() {
    super('DATABASE_URL is not configured on this deployment.');
    Object.setPrototypeOf(this, DatabaseNotConfiguredError.prototype);
  }
}

let cached: Database | null = null;

export function getDatabase(): Database {
  if (cached) return cached;

  const url = process.env.DATABASE_URL?.trim();
  // Fail loudly. Silently degrading to local-only storage would look like a
  // working sync that quietly never persists anything.
  if (!url) throw new DatabaseNotConfiguredError();

  cached = drizzle(neon(url), { schema }) as unknown as Database;
  return cached;
}

/** Test hook: drop the cached driver so a new DATABASE_URL takes effect. */
export function resetDatabase(): void {
  cached = null;
}
