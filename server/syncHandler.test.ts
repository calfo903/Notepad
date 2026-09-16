// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema';
import { createListHandler, createSyncHandler } from './syncHandler';
import type { Database } from './db/client';
import { createSessionToken } from './session';

/**
 * Handler tests run against a real Postgres (PGlite) rather than a stubbed
 * repository, so the HTTP layer and the SQL are verified together.
 */

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('./db/migrations/0000_init.sql', import.meta.url)),
  'utf8'
);

const SECRET = 'test-secret-value-that-is-long-enough-for-hs256';
const USER_SUB = 'google-sub-http-test';

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let cookie: string;

/** PGlite and the Neon driver are different Drizzle dialects over the same schema. */
function asDatabase(value: PgliteDatabase<typeof schema>): Database {
  return value as unknown as Database;
}

function handlers() {
  const resolve = () => asDatabase(db);
  return { sync: createSyncHandler({ db: resolve }), list: createListHandler({ db: resolve }) };
}

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

function notePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    title: 'Untitled',
    content: '<p>body</p>',
    folderId: 'all',
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    wordCount: 1,
    charCount: 13,
    createdAt: BASE,
    updatedAt: BASE,
    ...overrides,
  };
}

function syncRequest(body: unknown, opts: { auth?: boolean; method?: string } = {}): Request {
  const method = opts.method ?? 'POST';
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.auth !== false) headers.set('cookie', cookie);

  return new Request('https://app.test/api/notes/sync', {
    method,
    headers,
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

function listRequest(opts: { auth?: boolean; method?: string } = {}): Request {
  const method = opts.method ?? 'GET';
  const headers = new Headers();
  if (opts.auth !== false) headers.set('cookie', cookie);

  return new Request('https://app.test/api/notes', { method, headers });
}

beforeAll(async () => {
  process.env.SESSION_SECRET = SECRET;
  client = new PGlite();
  await client.exec(MIGRATION_SQL);
  db = drizzle(client, { schema });

  const token = await createSessionToken(
    { sub: USER_SUB, email: 'sync@example.com', emailVerified: true, name: 'Sync', picture: null },
    process.env
  );
  cookie = `nf_session=${token}`;
});

beforeEach(async () => {
  await client.exec('TRUNCATE "notes", "folders"');
});

afterAll(async () => {
  await client.close();
  delete process.env.SESSION_SECRET;
});

describe('POST /api/notes/sync', () => {
  it('rejects GET with 405', async () => {
    const response = await handlers().sync(syncRequest({}, { method: 'GET' }));
    expect(response.status).toBe(405);
  });

  it('requires authentication', async () => {
    const response = await handlers().sync(syncRequest({ notes: [] }, { auth: false }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('AUTH_REQUIRED');
    expect(response.headers.get('www-authenticate')).toBe('Cookie');
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await handlers().sync(syncRequest('{oops'));
    expect(response.status).toBe(400);
  });

  it('rejects a note id over 64 characters', async () => {
    const response = await handlers().sync(
      syncRequest({ notes: [notePayload({ id: 'x'.repeat(65) })] })
    );
    const body = (await response.json()) as { error: { code: string; details: unknown[] } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).not.toHaveLength(0);
  });

  it('rejects a negative word count', async () => {
    const response = await handlers().sync(
      syncRequest({ notes: [notePayload({ wordCount: -1 })] })
    );
    expect(response.status).toBe(400);
  });

  it('rejects a folder color that is not hex', async () => {
    const response = await handlers().sync(
      syncRequest({
        folders: [{ id: 'f1', name: 'Work', color: 'javascript:alert(1)', updatedAt: BASE }],
      })
    );
    expect(response.status).toBe(400);
  });

  it('persists notes and returns them with a server cursor', async () => {
    const response = await handlers().sync(
      syncRequest({ notes: [notePayload({ title: 'Persisted' })], since: null })
    );
    const body = (await response.json()) as {
      notes: Array<Record<string, unknown>>;
      serverTime: number;
    };

    expect(response.status).toBe(200);
    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].title).toBe('Persisted');
    expect(typeof body.serverTime).toBe('number');
  });

  it('converts epoch milliseconds to Date and back without drift', async () => {
    const updatedAt = Date.parse('2026-03-04T05:06:07.123Z');

    await handlers().sync(syncRequest({ notes: [notePayload({ updatedAt })], since: null }));

    const list = await handlers().list(listRequest());
    const body = (await list.json()) as { notes: Array<{ updatedAt: number }> };

    expect(body.notes[0].updatedAt).toBe(updatedAt);
  });

  it('enforces last-write-wins across separate requests', async () => {
    const { sync } = handlers();

    await sync(syncRequest({ notes: [notePayload({ title: 'newer', updatedAt: BASE + 60_000 })] }));
    await sync(syncRequest({ notes: [notePayload({ title: 'older', updatedAt: BASE })] }));

    const list = await handlers().list(listRequest());
    const body = (await list.json()) as { notes: Array<{ title: string }> };

    expect(body.notes).toHaveLength(1);
    expect(body.notes[0].title).toBe('newer');
  });

  it('returns tombstones so peers can delete locally', async () => {
    const { sync } = handlers();

    await sync(syncRequest({ notes: [notePayload()] }));
    await sync(
      syncRequest({
        notes: [
          notePayload({ trashed: true, deletedAt: BASE + 60_000, updatedAt: BASE + 60_000 }),
        ],
      })
    );

    const list = await handlers().list(listRequest());
    const body = (await list.json()) as { notes: Array<{ deletedAt?: number }> };

    expect(body.notes[0].deletedAt).toBe(BASE + 60_000);
  });

  it('honours the since cursor', async () => {
    const { sync } = handlers();

    await sync(
      syncRequest({
        notes: [
          notePayload({ id: 'old', updatedAt: BASE }),
          notePayload({ id: 'new', updatedAt: BASE + 120_000 }),
        ],
      })
    );

    const response = await sync(syncRequest({ notes: [], since: BASE + 60_000 }));
    const body = (await response.json()) as { notes: Array<{ id: string }> };

    expect(body.notes.map((note) => note.id)).toEqual(['new']);
  });

  it('isolates one user from another', async () => {
    await handlers().sync(syncRequest({ notes: [notePayload({ id: 'mine' })] }));

    const otherToken = await createSessionToken(
      { sub: 'google-sub-other', email: 'o@example.com', emailVerified: true, name: 'O', picture: null },
      process.env
    );

    const list = await handlers().list(
      new Request('https://app.test/api/notes', {
        headers: { cookie: `nf_session=${otherToken}` },
      })
    );
    const body = (await list.json()) as { notes: unknown[] };

    expect(body.notes).toHaveLength(0);
  });
});

describe('GET /api/notes', () => {
  it('rejects POST with 405', async () => {
    const response = await handlers().list(listRequest({ method: 'POST' }));
    expect(response.status).toBe(405);
  });

  it('requires authentication', async () => {
    const response = await handlers().list(listRequest({ auth: false }));
    expect(response.status).toBe(401);
  });

  it('returns an empty snapshot for a new user', async () => {
    const response = await handlers().list(listRequest());
    const body = (await response.json()) as { notes: unknown[]; folders: unknown[] };

    expect(response.status).toBe(200);
    expect(body.notes).toEqual([]);
    expect(body.folders).toEqual([]);
  });
});

describe('database misconfiguration', () => {
  it('returns 503 rather than leaking the driver error', async () => {
    delete process.env.DATABASE_URL;

    // Default resolver, not the injected one: exercises the real getDatabase path.
    const response = await createSyncHandler()(syncRequest({ notes: [] }));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('SYNC_NOT_CONFIGURED');
    expect(body.error.message).not.toContain('DATABASE_URL');
  });
});
