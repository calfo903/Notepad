import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * `npx drizzle-kit push` applies server/db/schema.ts directly to the database.
 * `npx drizzle-kit generate` writes a migration into server/db/migrations/.
 * DATABASE_URL must point at a pooled connection string.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
