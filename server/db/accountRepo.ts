import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { authEvents, notes, folders, type AuthEventRow, type NoteRow } from './schema';
import type { Database } from './client';

/**
 * Account-level repository: search, deletion, audit.
 *
 * Every query is scoped by `user_id` in the WHERE clause as well as being part
 * of the composite key, because these are ad-hoc reads rather than the fixed
 * sync pull.
 */

/** Escape the LIKE wildcards so a user-supplied `%` cannot become a match-all. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Minimum `word_similarity` for a fuzzy hit.
 *
 * Measured against PGlite rather than guessed: an exact word scores 1.0 and a
 * one-character typo ("budgt" for "budget") scores 0.667, so 0.4 admits single
 * character slips while still rejecting unrelated words.
 */
export const FUZZY_SIMILARITY_THRESHOLD = 0.4;

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

export type NoteWithScore = NoteRow & { readonly score: number };

/**
 * Search a user's notes.
 *
 * Two tiers, deliberately in this order:
 *   1. substring — what someone typing into a search box expects, and the only
 *      form a GIN trigram index can accelerate;
 *   2. word_similarity — tolerates typos, which a plain substring match cannot.
 *
 * pg_trgm's own operators are deliberately not used, on evidence:
 *   - `%` compares whole strings, so a real note scores ~0.16 for any single
 *     word and sits below the 0.3 threshold. It matched nothing.
 *   - `%>` returned false even for an exact match under PGlite.
 */
export async function searchNotes(
  db: Database,
  userId: string,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT
): Promise<readonly NoteWithScore[]> {
  const normalized = query.trim().toLowerCase();
  // An empty query would match every row. Returning nothing is cheaper and
  // matches what the UI does before the user has typed.
  if (normalized.length === 0) return [];

  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
  const pattern = `%${escapeLikePattern(normalized)}%`;

  const similarity = sql<number>`COALESCE(word_similarity(${normalized}, ${notes.searchText}), 0)`;

  const rows = await db
    .select({ note: notes, score: similarity })
    .from(notes)
    .where(
      and(
        eq(notes.userId, userId),
        isNull(notes.deletedAt),
        sql`(${notes.searchText} ILIKE ${pattern}
              OR lower(${notes.title}) LIKE ${pattern}
              OR word_similarity(${normalized}, ${notes.searchText}) > ${FUZZY_SIMILARITY_THRESHOLD})`,
      ),
    )
    .orderBy(
      // Exact substring hits first, then fuzzy matches by closeness.
      sql`(${notes.searchText} ILIKE ${pattern}) DESC`,
      desc(sql`word_similarity(${normalized}, ${notes.searchText})`),
      desc(notes.updatedAt),
    )
    .limit(safeLimit);

  return rows.map((row) => ({ ...row.note, score: Number(row.score) }));
}

export interface DeletedCounts {
  readonly notes: number;
  readonly folders: number;
}

/**
 * Hard-delete every note and folder owned by a user.
 *
 * Unlike sync, this is a real delete rather than a tombstone: the point of
 * account deletion is that the data stops existing. Audit rows are intentionally
 * left behind so the deletion itself remains evidenced.
 */
export async function deleteAccountData(db: Database, userId: string): Promise<DeletedCounts> {
  const [deletedNotes, deletedFolders] = await Promise.all([
    db.delete(notes).where(eq(notes.userId, userId)).returning({ id: notes.id }),
    db.delete(folders).where(eq(folders.userId, userId)).returning({ id: folders.id }),
  ]);

  return { notes: deletedNotes.length, folders: deletedFolders.length };
}

/** Closed set. Enforced here rather than as a DB enum so adding a value is a
 *  one-line code change and not a migration. */
export const AUTH_EVENT_NAMES = ['sign_in', 'sign_out', 'account_deleted'] as const;
export type AuthEventName = (typeof AUTH_EVENT_NAMES)[number];

export interface NewAuthEvent {
  readonly userId: string;
  readonly event: AuthEventName;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** Column width from the schema; anything longer is truncated rather than
 *  failing the write, since a log entry is not worth losing a sign-in over. */
const MAX_USER_AGENT_LENGTH = 512;
const MAX_IP_LENGTH = 45;

/**
 * Append one audit entry.
 *
 * Append-only by construction: this module exports no update or delete for
 * `auth_events`, so the trail cannot be rewritten by the code that owns it.
 */
export async function recordAuthEvent(
  db: Database,
  event: NewAuthEvent
): Promise<AuthEventRow> {
  if (!AUTH_EVENT_NAMES.includes(event.event)) {
    throw new RangeError(`Unknown auth event: ${String(event.event)}`);
  }

  const [row] = await db
    .insert(authEvents)
    .values({
      id: crypto.randomUUID(),
      userId: event.userId,
      event: event.event,
      ip: event.ip?.slice(0, MAX_IP_LENGTH) ?? null,
      userAgent: event.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      createdAt: new Date(),
    })
    .returning();

  return row;
}

/** Newest first: the caller almost always wants the most recent activity. */
export async function listAuthEvents(
  db: Database,
  userId: string
): Promise<readonly AuthEventRow[]> {
  return db
    .select()
    .from(authEvents)
    .where(eq(authEvents.userId, userId))
    .orderBy(desc(authEvents.createdAt));
}
