import { z } from 'zod';
import { DEFAULT_FOLDERS, type Folder, type Note, type SortBy, type SortOrder, type Theme, type ViewMode } from '../types';

/**
 * Validated hydration of persisted app state.
 *
 * `localStorage` is untrusted input in the same sense a request body is: another
 * tab, a browser extension, or an older version of the app can write anything
 * into it. The previous path was `safeLocalStorageGet<Partial<AppState>>`, which
 * only caught a JSON parse failure — a well-formed object with a non-array
 * `notes`, or a note missing `id`, flowed straight into React and threw during
 * render, which blanks the app with no way for the user to recover.
 *
 * Policy is repair, not reject. A single corrupt note must not cost the user
 * every other note, so bad entries are dropped and reported rather than causing
 * the whole load to fail.
 */

const noteSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  content: z.string().default(''),
  folderId: z.string().min(1).default('all'),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  trashed: z.boolean().default(false),
  createdAt: z.number().default(() => Date.now()),
  updatedAt: z.number().default(() => Date.now()),
  wordCount: z.number().int().min(0).default(0),
  charCount: z.number().int().min(0).default(0),
});

const folderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().default(''),
  color: z.string().default('#7c3aed'),
  parent: z.string().optional(),
});

const persistedStateSchema = z.object({
  // `z.unknown().array()` rather than `z.array(noteSchema)`: one bad element
  // would otherwise fail the whole array and lose every valid note with it.
  notes: z.array(z.unknown()).optional(),
  folders: z.array(z.unknown()).optional(),
  activeNoteId: z.string().nullable().optional(),
  activeFolder: z.string().optional(),
  viewMode: z.enum(['editor', 'focus', 'preview']).optional(),
  theme: z.enum(['light', 'dark']).optional(),
  showRightPanel: z.boolean().optional(),
  sidebarCollapsed: z.boolean().optional(),
  sortBy: z.enum(['updatedAt', 'createdAt', 'title']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export interface HydratedState {
  readonly notes: Note[];
  readonly folders: Folder[];
  readonly activeNoteId: string | null;
  readonly activeFolder: string;
  readonly viewMode: ViewMode;
  readonly theme: Theme;
  readonly showRightPanel: boolean;
  readonly sidebarCollapsed: boolean;
  readonly sortBy: SortBy;
  readonly sortOrder: SortOrder;
}

export interface HydrationResult {
  readonly state: HydratedState;
  /** Count of entries discarded as unparseable. Surfaced, never silent. */
  readonly droppedNotes: number;
  readonly droppedFolders: number;
  /** True when the stored value was not an object at all. */
  readonly wasCorrupt: boolean;
}

function parseEntries<T>(entries: readonly unknown[] | undefined, schema: z.ZodType<T>): {
  valid: T[];
  dropped: number;
} {
  if (!entries) return { valid: [], dropped: 0 };

  const valid: T[] = [];
  let dropped = 0;

  for (const entry of entries) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) valid.push(parsed.data);
    else dropped += 1;
  }

  return { valid, dropped };
}

/** Drop duplicate ids, keeping the last occurrence: the newest write wins. */
function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * Validate and repair a raw `localStorage` value.
 *
 * Accepts `unknown` deliberately — the caller passes whatever `JSON.parse`
 * returned, including `null`, a string, or an array.
 */
export function hydrateAppState(raw: unknown): HydrationResult {
  const parsed = persistedStateSchema.safeParse(raw);

  if (!parsed.success) {
    // Nothing recoverable. Start from defaults rather than throwing.
    return {
      state: {
        notes: [],
        folders: [...DEFAULT_FOLDERS],
        activeNoteId: null,
        activeFolder: 'all',
        viewMode: 'editor',
        theme: 'dark',
        showRightPanel: false,
        sidebarCollapsed: false,
        sortBy: 'updatedAt',
        sortOrder: 'desc',
      },
      droppedNotes: 0,
      droppedFolders: 0,
      wasCorrupt: true,
    };
  }

  const data = parsed.data;

  const notes = parseEntries(data.notes, noteSchema);
  const folders = parseEntries(data.folders, folderSchema);

  const validNotes = dedupeById(notes.valid);
  const validFolders = dedupeById(folders.valid);

  // Built-in folders are structural. If a corrupt write removed one, re-add it
  // so the sidebar cannot end up pointing at a folder that no longer exists.
  const existingIds = new Set(validFolders.map((folder) => folder.id));
  for (const builtIn of DEFAULT_FOLDERS) {
    if (!existingIds.has(builtIn.id)) validFolders.push({ ...builtIn });
  }

  const folderIds = new Set(validFolders.map((folder) => folder.id));
  const activeFolder =
    data.activeFolder && folderIds.has(data.activeFolder) ? data.activeFolder : 'all';

  // An activeNoteId pointing at a dropped note would select nothing and look
  // like a bug, so fall back to the first note.
  const noteIds = new Set(validNotes.map((note) => note.id));
  const activeNoteId =
    data.activeNoteId && noteIds.has(data.activeNoteId)
      ? data.activeNoteId
      : (validNotes[0]?.id ?? null);

  return {
    state: {
      notes: validNotes,
      folders: validFolders,
      activeNoteId,
      activeFolder,
      viewMode: data.viewMode ?? 'editor',
      theme: data.theme ?? 'dark',
      showRightPanel: data.showRightPanel ?? false,
      sidebarCollapsed: data.sidebarCollapsed ?? false,
      sortBy: data.sortBy ?? 'updatedAt',
      sortOrder: data.sortOrder ?? 'desc',
    },
    droppedNotes: notes.dropped,
    droppedFolders: folders.dropped,
    wasCorrupt: false,
  };
}
