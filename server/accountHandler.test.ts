// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from './db/testDatabase';
import {
  createAuthEventsHandler,
  createDeleteAccountHandler,
  createSearchHandler,
} from './accountHandler';
import { DatabaseNotConfiguredError } from './db/client';
import { RateLimiter } from './rateLimit';
import { syncAll } from './db/syncRepo';
import { createSessionToken } from './session';

/**
 * HTTP layer over a real Postgres (PGlite), so the auth gate, the zod/query
 * validation and the trigram SQL are verified together rather than in isolation.
 */

const SECRET = 'test-secret-value-that-is-long-enough-for-hs256';
const USER_SUB = 'google-sub-account-test';
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

let harness!: TestDatabase;
let cookie!: string;

/** A per-suite limiter keeps tests independent of the module-scoped buckets,
 *  which are deliberately tight enough that a full suite would exhaust them. */
function handlers(db = () => harness.db) {
  const limiter = new RateLimiter({ capacity: 1000, refillPerSecond: 1000, sweepIntervalMs: 60_000 });
  return {
    search: createSearchHandler({ db, limiter }),
    events: createAuthEventsHandler({ db }),
    deleteAccount: createDeleteAccountHandler({ db, limiter }),
  };
}

function noteInput(overrides: Partial<Parameters<typeof syncAll>[2]['notes'][number]> = {}) {
  return {
    id: 'n1',
    title: 'Untitled',
    content: '<p>body</p>',
    searchText: 'untitled body',
    folderId: 'all',
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    wordCount: 2,
    charCount: 11,
    createdAt: new Date(BASE),
    updatedAt: new Date(BASE),
    deletedAt: null,
    ...overrides,
  };
}

function request(
  path: string,
  method: string,
  opts: { auth?: boolean; headers?: Record<string, string> } = {}
): Request {
  const headers = new Headers(opts.headers);
  if (opts.auth !== false) headers.set('cookie', cookie);
  return new Request(`https://app.test${path}`, { method, headers });
}

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  harness = await createTestDatabase();

  const token = await createSessionToken(
    { sub: USER_SUB, email: 'account@example.com', emailVerified: true, name: 'Account', picture: null },
    process.env
  );
  cookie = `nf_session=${token}`;
});

beforeEach(async () => {
  await harness.truncate();
});

afterAll(async () => {
  await harness.close();
  delete process.env.SESSION_SECRET;
});

describe('GET /api/notes/search', () => {
  it('rejects methods other than GET', async () => {
    const response = await handlers().search(request('/api/notes/search', 'POST'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
  });

  it('requires a session', async () => {
    const response = await handlers().search(request('/api/notes/search?q=budget', 'GET', { auth: false }));

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('AUTH_REQUIRED');
  });

  it('returns matching notes with a score and excerpt', async () => {
    await syncAll(harness.db, USER_SUB, {
      notes: [
        noteInput({ id: 'n1', title: 'Budget', searchText: 'budget the quarterly budget forecast' }),
        noteInput({ id: 'n2', title: 'Groceries', searchText: 'groceries milk eggs bread' }),
      ],
      folders: [],
      since: null,
    });

    const response = await handlers().search(request('/api/notes/search?q=budget', 'GET'));
    const body = (await response.json()) as {
      query: string;
      results: { id: string; excerpt: string; score: number }[];
    };

    expect(response.status).toBe(200);
    expect(body.query).toBe('budget');
    expect(body.results.map((row) => row.id)).toEqual(['n1']);
    expect(body.results[0].excerpt).toContain('budget');
    expect(typeof body.results[0].score).toBe('number');
  });

  it('does not return note content, only an excerpt', async () => {
    await syncAll(harness.db, USER_SUB, {
      notes: [noteInput({ id: 'n1', content: '<p>secret body text</p>', searchText: 'budget' })],
      folders: [],
      since: null,
    });

    const response = await handlers().search(request('/api/notes/search?q=budget', 'GET'));
    const body = (await response.json()) as { results: Record<string, unknown>[] };

    expect(Object.keys(body.results[0])).not.toContain('content');
    expect(JSON.stringify(body)).not.toContain('secret body text');
  });

  it('rejects an over-long query', async () => {
    const response = await handlers().search(
      request(`/api/notes/search?q=${'a'.repeat(201)}`, 'GET')
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('QUERY_TOO_LONG');
  });

  it('rejects a non-integer or out-of-range limit', async () => {
    expect((await handlers().search(request('/api/notes/search?q=a&limit=abc', 'GET'))).status).toBe(400);
    expect((await handlers().search(request('/api/notes/search?q=a&limit=0', 'GET'))).status).toBe(400);
    expect((await handlers().search(request('/api/notes/search?q=a&limit=9999', 'GET'))).status).toBe(400);
  });

  it('honours limit', async () => {
    await syncAll(harness.db, USER_SUB, {
      notes: Array.from({ length: 5 }, (_, index) =>
        noteInput({ id: `n${index}`, searchText: 'common searchable phrase' })
      ),
      folders: [],
      since: null,
    });

    const response = await handlers().search(request('/api/notes/search?q=searchable&limit=2', 'GET'));
    const body = (await response.json()) as { results: unknown[] };

    expect(body.results).toHaveLength(2);
  });

  it('returns 503 rather than 500 when no database is configured', async () => {
    const unconfigured = () => {
      throw new DatabaseNotConfiguredError();
    };

    const response = await handlers(unconfigured).search(request('/api/notes/search?q=a', 'GET'));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('SEARCH_NOT_CONFIGURED');
  });

  it('does not leak database errors to the client', async () => {
    const broken = () => {
      throw new Error('connection to pg-host-7.internal refused');
    };

    const response = await handlers(broken).search(request('/api/notes/search?q=a', 'GET'));
    const body = (await response.json()) as { error: { message: string } };

    expect(response.status).toBe(500);
    expect(body.error.message).not.toContain('pg-host-7.internal');
  });
});

describe('GET /api/auth/events', () => {
  it('rejects methods other than GET', async () => {
    const response = await handlers().events(request('/api/auth/events', 'POST'));
    expect(response.status).toBe(405);
  });

  it('requires a session', async () => {
    const response = await handlers().events(request('/api/auth/events', 'GET', { auth: false }));
    expect(response.status).toBe(401);
  });

  it('lists the caller audit trail', async () => {
    await harness.client.exec(
      `INSERT INTO auth_events (id, user_id, event, ip, user_agent, created_at)
       VALUES ('e1', '${USER_SUB}', 'sign_in', '203.0.113.9', 'curl/8', now())`
    );

    const response = await handlers().events(request('/api/auth/events', 'GET'));
    const body = (await response.json()) as {
      events: { event: string; ip: string; createdAt: number }[];
    };

    expect(response.status).toBe(200);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event).toBe('sign_in');
    expect(body.events[0].ip).toBe('203.0.113.9');
    expect(typeof body.events[0].createdAt).toBe('number');
  });

  it('never returns another user events', async () => {
    await harness.client.exec(
      `INSERT INTO auth_events (id, user_id, event, created_at)
       VALUES ('e1', 'someone-else', 'sign_in', now())`
    );

    const response = await handlers().events(request('/api/auth/events', 'GET'));
    const body = (await response.json()) as { events: unknown[] };

    expect(body.events).toHaveLength(0);
  });
});

describe('DELETE /api/auth/account', () => {
  it('rejects methods other than DELETE', async () => {
    const response = await handlers().deleteAccount(request('/api/auth/account', 'GET'));
    expect(response.status).toBe(405);
  });

  it('requires a session', async () => {
    const response = await handlers().deleteAccount(
      request('/api/auth/account?confirm=true', 'DELETE', { auth: false })
    );
    expect(response.status).toBe(401);
  });

  it('refuses to delete without explicit confirmation', async () => {
    await syncAll(harness.db, USER_SUB, {
      notes: [noteInput({ id: 'n1' })],
      folders: [],
      since: null,
    });

    const response = await handlers().deleteAccount(request('/api/auth/account', 'DELETE'));

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('CONFIRMATION_REQUIRED');

    const remaining = await harness.client.query<{ n: number }>('SELECT count(*)::int AS n FROM notes');
    expect(remaining.rows[0].n).toBe(1);
  });

  it('deletes the caller data and reports counts', async () => {
    await syncAll(harness.db, USER_SUB, {
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

    const response = await handlers().deleteAccount(request('/api/auth/account?confirm=true', 'DELETE'));
    const body = (await response.json()) as { deleted: { notes: number; folders: number } };

    expect(response.status).toBe(200);
    expect(body.deleted).toEqual({ notes: 2, folders: 1 });

    const remaining = await harness.client.query<{ n: number }>('SELECT count(*)::int AS n FROM notes');
    expect(remaining.rows[0].n).toBe(0);
  });

  it('evidences the deletion without retaining the identity it describes', async () => {
    await syncAll(harness.db, USER_SUB, { notes: [noteInput({ id: 'n1' })], folders: [], since: null });

    const response = await handlers().deleteAccount(request('/api/auth/account?confirm=true', 'DELETE'));
    const body = (await response.json()) as { auditRowsPseudonymised: number };

    expect(body.auditRowsPseudonymised).toBe(1);

    // The event survives...
    const events = await harness.client.query<{ event: string }>(
      `SELECT event FROM auth_events WHERE event = 'account_deleted'`
    );
    expect(events.rows).toHaveLength(1);

    // ...but under a pseudonym, not the real subject.
    const owners = await harness.client.query<{ user_id: string }>(
      `SELECT user_id FROM auth_events WHERE event = 'account_deleted'`
    );
    expect(owners.rows[0].user_id).toMatch(/^deleted:[0-9a-f]{32}$/);
    expect(owners.rows[0].user_id).not.toBe(USER_SUB);

    // And nothing in the table still identifies the user.
    const remaining = await harness.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM auth_events WHERE user_id = '${USER_SUB}'`
    );
    expect(remaining.rows[0].n).toBe(0);
  });

  it('drops the client IP once the account is deleted', async () => {
    const response = await handlers().deleteAccount(
      request('/api/auth/account?confirm=true', 'DELETE', {
        headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
      })
    );

    expect(response.status).toBe(200);

    const rows = await harness.client.query<{ ip: string | null; user_agent: string | null }>(
      `SELECT ip, user_agent FROM auth_events WHERE event = 'account_deleted'`
    );
    expect(rows.rows[0].ip).toBeNull();
    expect(rows.rows[0].user_agent).toBeNull();
  });

  it('keeps the IP on the audit trail of an account that still exists', async () => {
    // The pseudonymisation is scoped to deletion, not applied globally.
    await harness.client.exec(
      `INSERT INTO auth_events (id, user_id, event, ip, created_at)
       VALUES ('keep-1', '${USER_SUB}', 'sign_in', '203.0.113.9', now())`
    );

    const events = await handlers().events(request('/api/auth/events', 'GET'));
    const body = (await events.json()) as { events: { ip: string | null }[] };

    expect(body.events[0].ip).toBe('203.0.113.9');
  });
});
