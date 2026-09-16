import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { getTableName } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { authEvents, folders, notes } from './schema';
import type { Database } from './client';

/**
 * Shared test database.
 *
 * Real Postgres SQL, not a mock: the repository's upsert, conflict and
 * trigram-search behaviour is only worth testing if it runs against a real
 * planner. PGlite is used because the sandbox has no Postgres binary and CI has
 * no service container.
 *
 * Booting PGlite costs ~1.7s, so tests share one instance and `truncate`
 * between cases rather than constructing a fresh database each time — that took
 * the sync suite from 26.5s to 4.3s.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestDatabase {
  /** Raw driver, for assertions that need SQL the ORM does not express. */
  readonly client: PGlite;
  readonly db: Database;
  /** Empty every table without paying for another PGlite boot. */
  truncate(): Promise<void>;
  close(): Promise<void>;
}

/** Migrations in dependency order. */
const MIGRATIONS = ['0000_init.sql', '0001_search_and_audit.sql'] as const;

export async function createTestDatabase(): Promise<TestDatabase> {
  // Contrib extensions must be registered at construction time. Issuing only
  // `CREATE EXTENSION pg_trgm` fails with `extension "pg_trgm" is not
  // available`, because PGlite has not unpacked the extension into the
  // in-memory filesystem yet.
  const client = new PGlite({ extensions: { pg_trgm } });

  for (const file of MIGRATIONS) {
    const sql = readFileSync(path.join(__dirname, 'migrations', file), 'utf8');
    await client.exec(sql);
  }

  // `drizzle-orm/pglite` returns a narrower type than the dialect-agnostic
  // `Database` the repositories accept; the cast mirrors the one in client.ts.
  const db = drizzle(client) as unknown as Database;

  return {
    client,
    db,
    async truncate() {
      // Audit rows are deleted here only to isolate tests; the production
      // repository exposes no delete path for them.
      const tables = [authEvents, folders, notes]
        .map((table) => `"${getTableName(table)}"`)
        .join(', ');
      await client.exec(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    },
    async close() {
      await client.close();
    },
  };
}
