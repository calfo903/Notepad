// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { authEvents, notes } from './schema';
import { createTestDatabase, type TestDatabase } from './testDatabase';
import {
  AUTH_EVENT_RETENTION_MS,
  deleteAccountData,
  listAuthEvents,
  pruneAuthEvents,
  pseudonymiseAuthEvents,
  recordAuthEvent,
  searchNotes,
} from './accountRepo';
import { syncAll, type NoteInput } from './syncRepo';

/**
 * Runs against PGlite with pg_trgm loaded, so the trigram behaviour asserted
 * here is the real extension and not a stub of it.
 */

const USER_A = 'google-sub-search-a';
const USER_B = 'google-sub-search-b';
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

let harness!: TestDatabase;
let db!: TestDatabase['db'];

function noteInput(overrides: Partial<NoteInput> = {}): NoteInput {
  return {
    id: 'n1',
    title: 'Untitled',
    content: '',
    searchText: '',
    folderId: 'all',
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    wordCount: 0,
    charCount: 0,
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    deletedAt: null,
    ...overrides,
  };
}

/** Mirror what the client computes: lower-cased, tag-stripped title + body. */
function withSearch(title: string, body: string): Partial<NoteInput> {
  return {
    title,
    content: `<p>${body}</p>`,
    searchText: `${title} ${body}`.toLowerCase(),
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

describe('migration 0001', () => {
  it('installs pg_trgm', async () => {
    const result = await harness.client.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('adds a GIN trigram index over search_text', async () => {
    const result = await harness.client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'notes_search_trgm_idx'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toContain('gin_trgm_ops');
  });
});

describe('searchNotes', () => {
  it('finds a note by a word in the body', async () => {
    await syncAll(db, USER_A, {
      notes: [
        noteInput({ id: 'n1', ...withSearch('Meeting notes', 'We discussed the quarterly budget forecast') }),
        noteInput({ id: 'n2', ...withSearch('Groceries', 'Milk, eggs, and bread') }),
      ],
      folders: [],
      since: null,
    });

    const results = await searchNotes(db, USER_A, 'budget');

    expect(results.map((note) => note.id)).toEqual(['n1']);
  });

  it('matches a misspelling through trigram similarity', async () => {
    await syncAll(db, USER_A, {
      notes: [
        noteInput({
          id: 'n1',
          ...withSearch('Architecture', 'The authentication subsystem uses JSON web tokens'),
        }),
      ],
      folders: [],
      since: null,
    });

    // "authentcation" is missing an 'i'.
    const results = await searchNotes(db, USER_A, 'authentcation');

    expect(results.map((note) => note.id)).toEqual(['n1']);
  });

  it('matches a short title that trigrams would score too low to find', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', ...withSearch('Zx', 'nothing relevant here') })],
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_A, 'zx')).toHaveLength(1);
  });

  it('is case-insensitive', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', ...withSearch('Roadmap', 'Ship the sync engine') })],
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_A, 'SHIP')).toHaveLength(1);
    expect(await searchNotes(db, USER_A, 'ship')).toHaveLength(1);
  });

  it('ranks the closer match first', async () => {
    await syncAll(db, USER_A, {
      notes: [
        noteInput({ id: 'weak', ...withSearch('Aside', 'A passing mention of databases') }),
        noteInput({
          id: 'strong',
          ...withSearch('Databases', 'Databases and database design and database tuning'),
        }),
      ],
      folders: [],
      since: null,
    });

    const results = await searchNotes(db, USER_A, 'database');

    expect(results.length).toBeGreaterThan(1);
    expect(results[0].id).toBe('strong');
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
  });

  it('excludes tombstoned notes', async () => {
    await syncAll(db, USER_A, {
      notes: [
        noteInput({
          id: 'gone',
          ...withSearch('Deleted', 'This note mentions the secret keyword'),
          deletedAt: new Date(BASE + 1),
          updatedAt: new Date(BASE + 1),
        }),
      ],
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_A, 'keyword')).toHaveLength(0);
  });

  it("never returns another user's notes", async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'mine', ...withSearch('Private', 'uniquepassphrase content') })],
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_B, 'uniquepassphrase')).toHaveLength(0);
  });

  it('returns an empty list for a blank query rather than matching everything', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', ...withSearch('A', 'body') })],
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_A, '')).toEqual([]);
    expect(await searchNotes(db, USER_A, '   ')).toEqual([]);
  });

  it('treats LIKE wildcards in the query as literals', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', ...withSearch('Note', 'ordinary text only') })],
      folders: [],
      since: null,
    });

    // An unescaped `%` would become a match-everything pattern.
    expect(await searchNotes(db, USER_A, '%')).toHaveLength(0);
    expect(await searchNotes(db, USER_A, '_')).toHaveLength(0);
  });

  it('caps the result count', async () => {
    await syncAll(db, USER_A, {
      notes: Array.from({ length: 10 }, (_, index) =>
        noteInput({ id: `n${index}`, ...withSearch(`Note ${index}`, 'shared searchable phrase here') })
      ),
      folders: [],
      since: null,
    });

    expect(await searchNotes(db, USER_A, 'searchable', 3)).toHaveLength(3);
  });

  it('returns a numeric score', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1', ...withSearch('A', 'repeated repeated repeated') })],
      folders: [],
      since: null,
    });

    const [result] = await searchNotes(db, USER_A, 'repeated');
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});

describe('deleteAccountData', () => {
  it('removes every note and folder and reports the counts', async () => {
    await syncAll(db, USER_A, {
      notes: [noteInput({ id: 'n1' }), noteInput({ id: 'n2' })],
      folders: [
        {
          id: 'f1',
          name: 'Work',
          icon: '',
          color: '#3b82f6',
          parent: null,
          updatedAt: new Date(BASE),
          deletedAt: null,
        },
      ],
      since: null,
    });

    expect(await deleteAccountData(db, USER_A)).toEqual({ notes: 2, folders: 1 });
    expect(await db.select().from(notes).where(eq(notes.userId, USER_A))).toHaveLength(0);
  });

  it('leaves other users untouched', async () => {
    await syncAll(db, USER_A, { notes: [noteInput({ id: 'shared-id' })], folders: [], since: null });
    await syncAll(db, USER_B, { notes: [noteInput({ id: 'shared-id' })], folders: [], since: null });

    await deleteAccountData(db, USER_A);

    expect(await db.select().from(notes).where(eq(notes.userId, USER_B))).toHaveLength(1);
  });

  it('is a no-op for a user with no data', async () => {
    expect(await deleteAccountData(db, 'nobody')).toEqual({ notes: 0, folders: 0 });
  });
});

describe('audit log', () => {
  it('appends an event and returns the stored row', async () => {
    const row = await recordAuthEvent(db, {
      userId: USER_A,
      event: 'sign_in',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    expect(row.userId).toBe(USER_A);
    expect(row.event).toBe('sign_in');
    expect(row.ip).toBe('203.0.113.7');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('generates a unique id per entry', async () => {
    const first = await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });
    const second = await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });

    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThan(0);
  });

  it('rejects an unknown event name', async () => {
    await expect(
      recordAuthEvent(db, { userId: USER_A, event: 'password_reset' as 'sign_in' })
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('bounds an oversized user agent instead of failing the write', async () => {
    const row = await recordAuthEvent(db, {
      userId: USER_A,
      event: 'sign_in',
      userAgent: 'x'.repeat(5_000),
    });

    expect(row.userAgent).toHaveLength(512);
  });

  it('lists events newest first and scoped to one user', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_out' });
    await recordAuthEvent(db, { userId: USER_B, event: 'sign_in' });

    const events = await listAuthEvents(db, USER_A);

    expect(events).toHaveLength(2);
    expect(events.every((event) => event.userId === USER_A)).toBe(true);
    expect(events[0].createdAt.getTime()).toBeGreaterThanOrEqual(events[1].createdAt.getTime());
  });

  it('survives account deletion so the deletion stays auditable', async () => {
    await syncAll(db, USER_A, { notes: [noteInput({ id: 'n1' })], folders: [], since: null });
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });

    await deleteAccountData(db, USER_A);
    await recordAuthEvent(db, { userId: USER_A, event: 'account_deleted' });

    const events = await listAuthEvents(db, USER_A);
    expect(events.map((event) => event.event)).toContain('account_deleted');
    expect(await db.select().from(authEvents).where(eq(authEvents.userId, USER_A))).toHaveLength(2);
  });
});

describe('pseudonymiseAuthEvents', () => {
  it('replaces the subject with a salted hash and drops IP and user agent', async () => {
    await recordAuthEvent(db, {
      userId: USER_A,
      event: 'sign_in',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });

    const count = await pseudonymiseAuthEvents(db, USER_A);

    expect(count).toBe(1);
    const rows = await harness.client.query<{ user_id: string; ip: string | null; user_agent: string | null }>(
      `SELECT user_id, ip, user_agent FROM auth_events`
    );
    expect(rows.rows[0].user_id).toMatch(/^deleted:[0-9a-f]{32}$/);
    expect(rows.rows[0].ip).toBeNull();
    expect(rows.rows[0].user_agent).toBeNull();
  });

  it('keeps the event and timestamp, so the timeline survives', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_out' });

    await pseudonymiseAuthEvents(db, USER_A);

    const rows = await harness.client.query<{ event: string; created_at: Date }>(
      `SELECT event, created_at FROM auth_events ORDER BY event`
    );
    expect(rows.rows.map((row) => row.event)).toEqual(['sign_in', 'sign_out']);
    expect(rows.rows.every((row) => row.created_at instanceof Date)).toBe(true);
  });

  it('is deterministic, so repeated calls do not fork the identity', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });

    await pseudonymiseAuthEvents(db, USER_A);
    const first = await harness.client.query<{ user_id: string }>(`SELECT user_id FROM auth_events`);

    // A second call finds nothing under the original id.
    expect(await pseudonymiseAuthEvents(db, USER_A)).toBe(0);
    const second = await harness.client.query<{ user_id: string }>(`SELECT user_id FROM auth_events`);

    expect(second.rows[0].user_id).toBe(first.rows[0].user_id);
  });

  it('does not touch other users', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in', ip: '203.0.113.1' });
    await recordAuthEvent(db, { userId: USER_B, event: 'sign_in', ip: '203.0.113.2' });

    await pseudonymiseAuthEvents(db, USER_A);

    const kept = await listAuthEvents(db, USER_B);
    expect(kept).toHaveLength(1);
    expect(kept[0].ip).toBe('203.0.113.2');
  });
});

describe('pruneAuthEvents', () => {
  it('removes entries older than the window and keeps recent ones', async () => {
    const now = Date.now();
    await harness.client.exec(
      `INSERT INTO auth_events (id, user_id, event, created_at) VALUES
        ('old', '${USER_A}', 'sign_in', to_timestamp(${(now - AUTH_EVENT_RETENTION_MS - 1_000) / 1_000})),
        ('new', '${USER_A}', 'sign_in', to_timestamp(${now / 1_000}))`
    );

    const removed = await pruneAuthEvents(db);

    expect(removed).toBe(1);
    const rows = await harness.client.query<{ id: string }>(`SELECT id FROM auth_events`);
    expect(rows.rows.map((row) => row.id)).toEqual(['new']);
  });

  it('honours a custom cutoff', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });

    expect(await pruneAuthEvents(db, new Date(Date.now() + 1_000))).toBe(1);
    expect(await listAuthEvents(db, USER_A)).toHaveLength(0);
  });

  it('is a no-op when nothing has expired', async () => {
    await recordAuthEvent(db, { userId: USER_A, event: 'sign_in' });
    expect(await pruneAuthEvents(db)).toBe(0);
  });

  it('has a retention window of one year', () => {
    expect(AUTH_EVENT_RETENTION_MS).toBe(365 * 24 * 60 * 60 * 1_000);
  });
});
