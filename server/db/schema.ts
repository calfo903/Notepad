import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * Persistence schema.
 *
 * Every row is scoped by `user_id` and it participates in the composite primary
 * key, so tenant isolation is enforced by the key itself rather than by a WHERE
 * clause that a future query could forget.
 *
 * Deletes are tombstones (`deleted_at`), never row removals: a peer device only
 * learns a note is gone if the deletion is itself a syncable event.
 */

/** Google `sub` values are 28 chars; 64 leaves room for another provider. */
const USER_ID_LENGTH = 64;
/** Client ids are base36 timestamp + random; 64 is ample. */
const ENTITY_ID_LENGTH = 64;

export const notes = pgTable(
  'notes',
  {
    id: varchar('id', { length: ENTITY_ID_LENGTH }).notNull(),
    userId: varchar('user_id', { length: USER_ID_LENGTH }).notNull(),
    title: text('title').notNull().default(''),
    /** Sanitized HTML. The server re-sanitizes on write; this is defence in depth. */
    content: text('content').notNull().default(''),
    /**
     * Lower-cased, tag-stripped `title` + body, computed by the client.
     *
     * Edge Functions have no DOM, so the server cannot strip HTML without a
     * regex parser that would be wrong in exactly the cases that matter. The
     * client already runs DOMPurify and has a real parser, so it ships the
     * derived text alongside the content it authored.
     */
    searchText: text('search_text').notNull().default(''),
    folderId: varchar('folder_id', { length: ENTITY_ID_LENGTH }).notNull().default('all'),
    tags: text('tags').array().notNull().default([]),
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    trashed: boolean('trashed').notNull().default(false),
    wordCount: integer('word_count').notNull().default(0),
    /** Never send this note's content to a model. Enforced client-side. */
    excludeFromAi: boolean('exclude_from_ai').notNull().default(false),
    charCount: integer('char_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    // The sync pull is `WHERE user_id = ? AND updated_at > ?` on every request.
    index('notes_user_updated_idx').on(table.userId, table.updatedAt),
    // Backs the ILIKE tier of search. Measured caveat: under PGlite the planner
    // still chooses a seq scan, so this index only pays off on real Postgres.
    index('notes_search_trgm_idx').using('gin', table.searchText.op('gin_trgm_ops')),
  ]
);

/**
 * Append-only audit log.
 *
 * Deliberately has no update or delete path in the repository layer: the value
 * of an audit trail is that it cannot be quietly rewritten, including by the
 * account it describes. Account deletion removes notes and folders but leaves
 * these rows, so the deletion itself remains evidenced.
 */
export const authEvents = pgTable(
  'auth_events',
  {
    id: varchar('id', { length: ENTITY_ID_LENGTH }).primaryKey(),
    userId: varchar('user_id', { length: USER_ID_LENGTH }).notNull(),
    /** Closed set, enforced by `recordAuthEvent` rather than by a DB enum. */
    event: varchar('event', { length: 32 }).notNull(),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 512 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    // The only read pattern is "everything for this user, newest first".
    index('auth_events_user_created_idx').on(table.userId, table.createdAt),
  ]
);

export const folders = pgTable(
  'folders',
  {
    id: varchar('id', { length: ENTITY_ID_LENGTH }).notNull(),
    userId: varchar('user_id', { length: USER_ID_LENGTH }).notNull(),
    name: text('name').notNull(),
    icon: text('icon').notNull().default(''),
    color: text('color').notNull().default('#7c3aed'),
    parent: varchar('parent', { length: ENTITY_ID_LENGTH }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id] }),
    index('folders_user_updated_idx').on(table.userId, table.updatedAt),
  ]
);

export type NoteRow = typeof notes.$inferSelect;
export type NewNoteRow = typeof notes.$inferInsert;
export type FolderRow = typeof folders.$inferSelect;
export type NewFolderRow = typeof folders.$inferInsert;
export type AuthEventRow = typeof authEvents.$inferSelect;
export type NewAuthEventRow = typeof authEvents.$inferInsert;
