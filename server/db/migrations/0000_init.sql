-- NoteFlow sync schema.
--
-- Applied with: npx drizzle-kit push   (or execute this file directly)
-- Composite PK puts user_id first: tenant isolation is a property of the key,
-- not of a WHERE clause a future query could forget.

CREATE TABLE IF NOT EXISTS "notes" (
	"id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"folder_id" varchar(64) DEFAULT 'all' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"trashed" boolean DEFAULT false NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"char_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notes_user_id_id_pk" PRIMARY KEY("user_id", "id")
);

CREATE INDEX IF NOT EXISTS "notes_user_updated_idx" ON "notes" USING btree ("user_id", "updated_at");

CREATE TABLE IF NOT EXISTS "folders" (
	"id" varchar(64) NOT NULL,
	"user_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"color" text DEFAULT '#7c3aed' NOT NULL,
	"parent" varchar(64),
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "folders_user_id_id_pk" PRIMARY KEY("user_id", "id")
);

CREATE INDEX IF NOT EXISTS "folders_user_updated_idx" ON "folders" USING btree ("user_id", "updated_at");
