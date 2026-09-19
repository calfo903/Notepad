// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { notes } from './schema';
import { createTestDatabase, type TestDatabase } from './testDatabase';
import { listAll, MAX_CONTENT_CHARS, PayloadTooLargeError, syncAll, type NoteInput } from './syncRepo';

/**
 * Integration tests against PGlite — a real Postgres engine compiled to WASM.
 * These exercise actual SQL: upsert conflict resolution, composite keys,
 * timestamptz round-tripping and array columns.
 */

const USER_A = 'google-sub-user-a';
const USER_B = 'google-sub-user-b';

// Assigned in beforeAll; the `!` is the standard way to tell TS that a
// vitest lifecycle hook runs before the test bodies.
let harness!: TestDatabase;
let db!: TestDatabase['db'];

// One engine for the whole file: PGlite boots a WASM Postgres, which costs
// ~1.7s per instance. Rows are truncated between tests instead.

function noteInput(overrides: Partial<NoteInput> = {}): NoteInput {
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  return {
    id: 'note-1',
    title: 'Untitled',
    content: '<p>body</p>',
    searchText: 'untitled body',
    folderId: 'all',
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    wordCount: 1,
    charCount: 13,
    createdAt: new Date(base),
    updatedAt: new Date(base),
    deletedAt: null,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
});

beforeEach(async () => {
  await harness.truncate();
});

afterAll(async () => {
  await harness.close();
});

describe('schema migration', () => {
  it('creates every table with its indexes', async () => {
    const tables = await harness.client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual(['auth_events', 'folders', 'notes']);

    const indexes = await harness.client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`
    );
    const names = indexes.rows.map((row) => row.indexname);

    expect(names).toContain('notes_user_updated_idx');
    expect(names).toContain('folders_user_updated_idx');
  });
});

describe('syncAll — writes', () => {
  it('inserts new notes and returns them', async () => {
    const result = await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'First' })],
      folders: [],
      since: null,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].id).toBe('n1');
    expect(result.notes[0].userId).toBe(USER_A);
    expect(result.notes[0].title).toBe('First');
  });

  it('round-trips array and boolean columns intact', async () => {
    await syncAll(db, USER_A, {
      notes: [
        noteInput({
          id: 'n1',
          tags: ['alpha', 'beta'],
          pinned: true,
          archived: true,
          trashed: false,
          wordCount: 42,
          charCount: 300,
        }),
      ],
      folders: [],
      since: null,
    });

    const { notes: rows } = await listAll(db, USER_A);

    expect(rows[0].tags).toEqual(['alpha', 'beta']);
    expect(rows[0].pinned).toBe(true);
    expect(rows[0].archived).toBe(true);
    expect(rows[0].trashed).toBe(false);
    expect(rows[0].wordCount).toBe(42);
  });

  it('preserves millisecond timestamps through timestamptz', async () => {
    const updatedAt = new Date('2026-03-04T05:06:07.123Z');

    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', updatedAt })],
      folders: [],
      since: null,
    });

    const { notes: rows } = await listAll(db, USER_A);
    expect(rows[0].updatedAt.toISOString()).toBe('2026-03-04T05:06:07.123Z');
  });

  it('applies a newer revision over an older one', async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'v1', updatedAt: new Date(t0) })],
      folders: [],
      since: null,
    });

    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'v2', updatedAt: new Date(t0 + 60_000) })],
      folders: [],
      since: null,
    });

    const { notes: rows } = await listAll(db, USER_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('v2');
  });

  it('refuses to let a stale revision overwrite a newer one', async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'new', updatedAt: new Date(t0 + 60_000) })],
      folders: [],
      since: null,
    });

    // A device that has been offline for a while pushes its old copy.
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'stale', updatedAt: new Date(t0) })],
      folders: [],
      since: null,
    });

    const { notes: rows } = await listAll(db, USER_A);
    expect(rows[0].title).toBe('new');
  });

  it('rejects a note body over the size cap', async () => {
    await expect(
      syncAll(db, USER_A, {
        notes: [noteInput({ id: 'n1', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) })],
        folders: [],
        since: null,
      })
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
});

describe('syncAll — tenant isolation', () => {
  it('scopes writes and reads to the authenticated user', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', title: 'A note' })],
      folders: [],
      since: null,
    });
    await syncAll(db, USER_B, {
      notes: [noteInput({ id: 'n1', title: 'B note' })],
      folders: [],
      since: null,
    });

    const a = await listAll(db, USER_A);
    const b = await listAll(db, USER_B);

    // Same note id, two users: the composite primary key allows both.
    expect(a.notes).toHaveLength(1);
    expect(a.notes[0].title).toBe('A note');
    expect(b.notes).toHaveLength(1);
    expect(b.notes[0].title).toBe('B note');
  });

  it('cannot be tricked into writing as another user', async () => {
    await syncAll(db, USER_A, {
      // The repo injects userId, so this row lands under USER_A regardless.
      notes: [noteInput({ id: 'n1' })],
      folders: [],
      since: null,
    });

    const foreign = await db.select().from(notes).where(eq(notes.userId, USER_B));
    expect(foreign).toHaveLength(0);
  });
});

describe('syncAll — tombstones and cursor', () => {
  it('records a deletion as a tombstone rather than removing the row', async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', updatedAt: new Date(t0) })],
      folders: [],
      since: null,
    });
    await syncAll(db, USER_A, {
      notes: [
        noteInput({
          id: 'n1',
          trashed: true,
          deletedAt: new Date(t0 + 60_000),
          updatedAt: new Date(t0 + 60_000),
        }),
      ],
      folders: [],
      since: null,
    });

    const { notes: rows } = await listAll(db, USER_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].deletedAt?.toISOString()).toBe(new Date(t0 + 60_000).toISOString());
  });

  it('returns only rows newer than the cursor', async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    await syncAll(db, USER_A, {
      notes: [
        noteInput({ id: 'old', updatedAt: new Date(t0) }),
        noteInput({ id: 'new', updatedAt: new Date(t0 + 120_000) }),
      ],
      folders: [],
      since: null,
    });

    const result = await syncAll(db, USER_A, {
      notes: [],
      folders: [],
      since: new Date(t0 + 60_000),
    });

    expect(result.notes.map((note) => note.id)).toEqual(['new']);
  });

  it('returns the full snapshot when the cursor is null', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'a' }), noteInput({ id: 'b' })],
      folders: [],
      since: null,
    });

    const result = await syncAll(db, USER_A, { notes: [], folders: [], since: null });
    expect(result.notes).toHaveLength(2);
  });

  it('returns a server time that can be used as the next cursor', async () => {
    const before = Date.now();
    const result = await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', updatedAt: new Date() })],
      folders: [],
      since: null,
    });

    expect(result.serverTime.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe('syncAll — folders', () => {
  it('upserts folders with the same last-write-wins rule', async () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

    await syncAll(db, USER_A, {
      notes: [],
      folders: [
        { id: 'work', name: 'Work', icon: '💼', color: '#3b82f6', parent: null, updatedAt: new Date(t0 + 60_000), deletedAt: null },
      ],
      since: null,
    });

    await syncAll(db, USER_A, {
      notes: [],
      folders: [
        { id: 'work', name: 'Stale name', icon: '💼', color: '#3b82f6', parent: null, updatedAt: new Date(t0), deletedAt: null },
      ],
      since: null,
    });

    const { folders: rows } = await listAll(db, USER_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Work');
  });

  it('returns folders and notes together in one sync', async () => {
    const result = await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1' })],
      folders: [
        { id: 'ideas', name: 'Ideas', icon: '💡', color: '#f97316', parent: null, updatedAt: new Date(), deletedAt: null },
      ],
      since: null,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.folders).toHaveLength(1);
    expect(result.folders[0].id).toBe('ideas');
  });
});
