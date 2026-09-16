import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database } from './client';
import { folders, notes, type FolderRow, type NewFolderRow, type NewNoteRow, type NoteRow } from './schema';

/**
 * Sync repository.
 *
 * Conflict policy is per-row last-write-wins on `updated_at`. That is a real
 * limitation, stated plainly: two devices editing the same note concurrently
 * lose the older revision. Resolving that properly needs a CRDT or operation
 * log; it is out of scope for phase 1 and the client surfaces the timestamp so
 * a future revision can detect the loss.
 *
 * The whole push is a single upsert statement per table, so a sync costs two
 * round trips regardless of how many notes changed.
 */

/** Hard cap per note body. Guards storage, not just bandwidth. */
export const MAX_CONTENT_CHARS = 2_000_000;

export class PayloadTooLargeError extends Error {
  override readonly name = 'PayloadTooLargeError';

  constructor() {
    super(`Note content exceeds ${MAX_CONTENT_CHARS} characters.`);
    Object.setPrototypeOf(this, PayloadTooLargeError.prototype);
  }
}

/**
 * Row inputs omit `userId` deliberately: the repository injects it from the
 * authenticated session, so a caller cannot write into another tenant by
 * supplying a different id.
 */
export type NoteInput = Omit<NewNoteRow, 'userId'>;
export type FolderInput = Omit<NewFolderRow, 'userId'>;

export interface SyncInput {
  readonly notes: readonly NoteInput[];
  readonly folders: readonly FolderInput[];
  /** Exclusive cursor. Rows with `updated_at > since` are returned. */
  readonly since: Date | null;
}

export interface SyncResult {
  readonly notes: readonly NoteRow[];
  readonly folders: readonly FolderRow[];
  /** Server clock at the start of the sync; becomes the client's next cursor. */
  readonly serverTime: Date;
}

/** Note content is stored as authored. The render-time sanitizer in the client
 *  is the security boundary — Edge has no DOM, so a partial server-side
 *  sanitizer would create false confidence rather than safety. */
function assertPayloadSize(rows: readonly NoteInput[]): void {
  for (const row of rows) {
    if (typeof row.content === 'string' && row.content.length > MAX_CONTENT_CHARS) {
      throw new PayloadTooLargeError();
    }
  }
}

export async function syncAll(
  db: Database,
  userId: string,
  input: SyncInput
): Promise<SyncResult> {
  assertPayloadSize(input.notes);

  // Captured before the writes so a concurrent update can only make the result
  // set over-inclusive, never miss a change.
  const serverTime = new Date();

  if (input.folders.length > 0) {
    await db
      .insert(folders)
      .values(input.folders.map((folder) => ({ ...folder, userId })))
      .onConflictDoUpdate({
        target: [folders.userId, folders.id],
        set: {
          name: sql`excluded.name`,
          icon: sql`excluded.icon`,
          color: sql`excluded.color`,
          parent: sql`excluded.parent`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
        // Never let a stale revision overwrite a newer one.
        setWhere: sql`excluded.updated_at > ${folders.updatedAt}`,
      });
  }

  if (input.notes.length > 0) {
    await db
      .insert(notes)
      .values(input.notes.map((note) => ({ ...note, userId })))
      .onConflictDoUpdate({
        target: [notes.userId, notes.id],
        set: {
          title: sql`excluded.title`,
          content: sql`excluded.content`,
          // Must be updated alongside `content`: a note edited on another device
          // would otherwise keep its stale search text and stay findable by
          // words it no longer contains.
          searchText: sql`excluded.search_text`,
          folderId: sql`excluded.folder_id`,
          tags: sql`excluded.tags`,
          pinned: sql`excluded.pinned`,
          archived: sql`excluded.archived`,
          trashed: sql`excluded.trashed`,
          wordCount: sql`excluded.word_count`,
          charCount: sql`excluded.char_count`,
          createdAt: sql`excluded.created_at`,
          updatedAt: sql`excluded.updated_at`,
          deletedAt: sql`excluded.deleted_at`,
        },
        setWhere: sql`excluded.updated_at > ${notes.updatedAt}`,
      });
  }

  const noteFilter = input.since
    ? and(eq(notes.userId, userId), gt(notes.updatedAt, input.since))
    : eq(notes.userId, userId);

  const folderFilter = input.since
    ? and(eq(folders.userId, userId), gt(folders.updatedAt, input.since))
    : eq(folders.userId, userId);

  const [changedNotes, changedFolders] = await Promise.all([
    db.select().from(notes).where(noteFilter).orderBy(notes.updatedAt),
    db.select().from(folders).where(folderFilter).orderBy(folders.updatedAt),
  ]);

  return { notes: changedNotes, folders: changedFolders, serverTime };
}

/** Full snapshot for a user, including tombstones. */
export async function listAll(
  db: Database,
  userId: string
): Promise<{ notes: readonly NoteRow[]; folders: readonly FolderRow[] }> {
  const [userNotes, userFolders] = await Promise.all([
    db.select().from(notes).where(eq(notes.userId, userId)).orderBy(notes.updatedAt),
    db.select().from(folders).where(eq(folders.userId, userId)).orderBy(folders.updatedAt),
  ]);

  return { notes: userNotes, folders: userFolders };
}
