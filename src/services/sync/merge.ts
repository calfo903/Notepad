import { stripHtml } from '../../utils/helpers';
import type { Folder, Note } from '../../types';

/**
 * Client-side sync merge.
 *
 * Pure and total: no I/O, no clock reads, no mutation of inputs. Every rule is
 * covered by a unit test because a merge bug silently destroys user data.
 *
 * Conflict policy matches the server: per-row last-write-wins on `updatedAt`.
 */

/** A row as returned by the API. `deletedAt` marks a tombstone. */
export type RemoteNote = Note & { readonly deletedAt?: number };
export type RemoteFolder = Folder & { readonly deletedAt?: number; readonly updatedAt?: number };

export interface MergeResult<T> {
  readonly items: readonly T[];
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly keptLocal: number;
}

/**
 * Fold remote rows into the local collection.
 *
 * - tombstone            -> drop locally
 * - unknown id           -> insert
 * - remote newer         -> replace
 * - local newer or equal -> keep local (it is still pending a push)
 */
export function mergeNotes(
  local: readonly Note[],
  remote: readonly RemoteNote[]
): MergeResult<Note> {
  return mergeByKey(
    local,
    remote,
    (note) => note.id,
    (note) => note.updatedAt,
    (remoteNote) => remoteNote.deletedAt
  );
}

export function mergeFolders(
  local: readonly Folder[],
  remote: readonly RemoteFolder[]
): MergeResult<Folder> {
  return mergeByKey(
    local,
    remote,
    (folder) => folder.id,
    // Built-in folders predate sync and carry no timestamp; treat them as epoch 0
    // so any server row wins rather than being discarded as stale.
    (folder) => (folder as Folder & { updatedAt?: number }).updatedAt ?? 0,
    (remoteFolder) => remoteFolder.deletedAt
  );
}

function mergeByKey<T, R extends T>(
  local: readonly T[],
  remote: readonly R[],
  keyOf: (item: T) => string,
  updatedAtOf: (item: T) => number,
  deletedAtOf: (item: R) => number | undefined
): MergeResult<T> {
  // O(n) index rather than a nested scan: notes can number in the thousands.
  const index = new Map<string, T>();
  for (const item of local) index.set(keyOf(item), item);

  let added = 0;
  let updated = 0;
  let removed = 0;
  let keptLocal = 0;

  for (const incoming of remote) {
    const key = keyOf(incoming);
    const existing = index.get(key);

    if (deletedAtOf(incoming) !== undefined) {
      if (index.delete(key)) removed += 1;
      continue;
    }

    if (!existing) {
      index.set(key, incoming);
      added += 1;
      continue;
    }

    if (updatedAtOf(incoming) > updatedAtOf(existing)) {
      index.set(key, incoming);
      updated += 1;
    } else {
      keptLocal += 1;
    }
  }

  return { items: [...index.values()], added, updated, removed, keptLocal };
}

/**
 * Rows that still need pushing.
 *
 * `lastSyncedAt` is a server-issued cursor, so comparing against it does not
 * depend on the local clock being accurate.
 */
export function collectChangedNotes(
  notes: readonly Note[],
  lastSyncedAt: number | null
): readonly Note[] {
  if (lastSyncedAt === null) return [...notes];
  return notes.filter((note) => note.updatedAt > lastSyncedAt);
}

/**
 * A note ready to push: the stored note plus the derived search text.
 *
 * `searchText` is computed here rather than on the server because Edge Functions
 * have no DOM. Stripping HTML with a regex on the server would be wrong in
 * exactly the cases that matter (entities, `<script>`, nested tags), and the
 * client already runs DOMPurify and has a real parser.
 */
export type SyncNote = Note & { readonly searchText: string };

export function toSyncNote(note: Note): SyncNote {
  const plainText = stripHtml(note.content).replace(/\s+/g, ' ');
  return { ...note, searchText: `${note.title} ${plainText}`.toLowerCase().trim() };
}

export function prepareNotesForSync(notes: readonly Note[]): readonly SyncNote[] {
  return notes.map(toSyncNote);
}

export function collectChangedFolders(
  folders: readonly Folder[],
  lastSyncedAt: number | null
): readonly RemoteFolder[] {
  const stamped = folders.map((folder) => ({
    ...folder,
    updatedAt: (folder as Folder & { updatedAt?: number }).updatedAt ?? Date.now(),
  }));

  if (lastSyncedAt === null) return stamped;
  return stamped.filter((folder) => folder.updatedAt > lastSyncedAt);
}
