-- Search + audit additions to 0000_init.sql.
--
-- Incremental and idempotent: safe to apply to a database that already has the
-- 0000 schema, and safe to re-run. Written by hand because `drizzle-kit
-- generate` has no journal entry for 0000_init.sql and would otherwise emit a
-- full CREATE TABLE for `notes` and `folders` that fails on an existing
-- database.
--
-- Applied with: npx drizzle-kit push   (or execute this file directly)

-- pg_trgm powers fuzzy/substring search. Available on Neon and on PGlite
-- (where it must also be registered in the PGlite constructor, not just here).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "search_text" text DEFAULT '' NOT NULL;

-- Backfill so pre-existing rows are searchable immediately rather than only
-- after their next sync writes a client-derived value.
UPDATE "notes" SET "search_text" = lower("title") WHERE "search_text" = '';

-- Backs the ILIKE tier of search. Note: the planner may still prefer a seq scan
-- on small tables; the index pays off as row counts grow.
CREATE INDEX IF NOT EXISTS "notes_search_trgm_idx" ON "notes" USING gin ("search_text" gin_trgm_ops);

-- Append-only audit log. No UPDATE/DELETE path exists in the repository layer.
CREATE TABLE IF NOT EXISTS "auth_events" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"event" varchar(32) NOT NULL,
	"ip" varchar(45),
	"user_agent" varchar(512),
	"created_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "auth_events_user_created_idx" ON "auth_events" USING btree ("user_id", "created_at");
