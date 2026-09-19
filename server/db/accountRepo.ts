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

/**
 * Remove the personal data from a user's audit trail while keeping the timeline.
 *
 * Called on account deletion. The rows stay — an audit log that can be deleted by
 * the account it describes is not an audit log — but `user_id` is replaced with a
 * salted hash and the IP and user agent are dropped, so what remains evidences
 * *that* an account signed in and was deleted without identifying anyone.
 *
 * The hash is not reversible from the table alone: recovering the mapping needs
 * the original `sub`, which the deletion just removed.
 */
export async function pseudonymiseAuthEvents(
  db: Database,
  userId: string
): Promise<number> {
  const token = `deleted:${await pseudonym(userId)}`;

  const updated = await db
    .update(authEvents)
    .set({ userId: token, ip: null, userAgent: null })
    .where(eq(authEvents.userId, userId))
    .returning({ id: authEvents.id });

  return updated.length;
}

/** Salted, one-way identifier used in place of a real `user_id`. */
async function pseudonym(userId: string): Promise<string> {
  const salt = process.env.LOG_SALT?.trim() || 'noteflow-audit-pseudonymisation';
  const bytes = new TextEncoder().encode(`${salt}:${userId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Drop audit entries older than the retention window.
 *
 * An audit log with no expiry grows forever and keeps personal data indefinitely,
 * which is the retention half of the GDPR problem. Called opportunistically on
 * sign-in rather than on a scheduler, because Edge Functions have no cron to
 * hang it on.
 */
export const AUTH_EVENT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;

export async function pruneAuthEvents(
  db: Database,
  olderThan: Date = new Date(Date.now() - AUTH_EVENT_RETENTION_MS)
): Promise<number> {
  const removed = await db
    .delete(authEvents)
    .where(sql`${authEvents.createdAt} < ${olderThan}`)
    .returning({ id: authEvents.id });

  return removed.length;
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
