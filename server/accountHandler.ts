import { getDatabase, DatabaseNotConfiguredError, type Database } from './db/client';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  deleteAccountData,
  listAuthEvents,
  recordAuthEvent,
  searchNotes,
  type AuthEventName,
} from './db/accountRepo';
import type { NoteRow } from './db/schema';
import { errorResponse, jsonResponse } from './http';
import { readSession } from './session';
import { AuthError } from './googleAuth';
import { clientIp, RateLimiter } from './rateLimit';

/**
 * Account-scoped endpoints: search, audit trail, account deletion.
 *
 * All three are authentication-mandatory. Search in particular cannot be
 * anonymous, because an unauthenticated search over notes would be a way to
 * enumerate another tenant's data one query at a time.
 */

export interface AccountHandlerDeps {
  /** Injectable so tests can run against PGlite instead of a live database. */
  readonly db?: () => Database;
  /**
   * Injectable limiter. The defaults are module-scoped and deliberately
   * tight — a test suite that exercises every branch would otherwise exhaust
   * the deletion bucket and start seeing 429s from an earlier test.
   */
  readonly limiter?: RateLimiter;
}

/**
 * Long enough to stop a client from hammering the trigram scan, short enough
 * that typing in a search box (which fires per keystroke when debounced) never
 * trips it.
 */
const searchLimiter = new RateLimiter({
  capacity: 60,
  refillPerSecond: 60 / 60,
  sweepIntervalMs: 30_000,
});

const deleteLimiter = new RateLimiter({
  capacity: 5,
  refillPerSecond: 5 / 60,
  sweepIntervalMs: 30_000,
});

const MAX_QUERY_LENGTH = 200;

function toSearchResult(row: NoteRow & { readonly score: number }): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    folderId: row.folderId,
    tags: row.tags ?? [],
    pinned: row.pinned,
    // Excerpt only. Returning full content would make this a second, unthrottled
    // bulk-read path alongside /api/notes.
    excerpt: row.searchText.slice(0, 240),
    score: row.score,
    updatedAt: row.updatedAt.getTime(),
  };
}

export function createSearchHandler(deps: AccountHandlerDeps = {}) {
  const resolveDb = deps.db ?? getDatabase;
  const limiter = deps.limiter ?? searchLimiter;

  return async function handleSearchNotes(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET is accepted.', undefined, {
        Allow: 'GET',
      });
    }

    let user;
    try {
      user = await readSession(request);
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
      throw err;
    }

    if (!user) {
      return errorResponse(401, 'AUTH_REQUIRED', 'Sign in to search your notes.', undefined, {
        'www-authenticate': 'Cookie',
      });
    }

    const decision = limiter.consume(`search:${user.sub}`);
    if (!decision.allowed) {
      return errorResponse(
        429,
        'RATE_LIMITED',
        `Too many searches. Try again in ${decision.retryAfterSeconds}s.`,
        undefined,
        { 'retry-after': String(decision.retryAfterSeconds) }
      );
    }

    const url = new URL(request.url);
    const rawQuery = url.searchParams.get('q') ?? '';
    const limitParam = url.searchParams.get('limit');

    if (rawQuery.length > MAX_QUERY_LENGTH) {
      return errorResponse(400, 'QUERY_TOO_LONG', `Search queries are limited to ${MAX_QUERY_LENGTH} characters.`);
    }

    const limit = limitParam === null ? DEFAULT_SEARCH_LIMIT : Number(limitParam);
    if (limitParam !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT)) {
      return errorResponse(400, 'INVALID_LIMIT', `limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`);
    }

    try {
      const results = await searchNotes(resolveDb(), user.sub, rawQuery, limit);
      return jsonResponse(200, { query: rawQuery.trim(), results: results.map(toSearchResult) });
    } catch (err) {
      if (err instanceof DatabaseNotConfiguredError) {
        console.error('[search] database is not configured');
        return errorResponse(503, 'SEARCH_NOT_CONFIGURED', 'Note search is not configured on this deployment.');
      }
      console.error('[search] failed:', err instanceof Error ? err.message : err);
      return errorResponse(500, 'SEARCH_FAILED', 'Note search failed.');
    }
  };
}

export function createAuthEventsHandler(deps: AccountHandlerDeps = {}) {
  const resolveDb = deps.db ?? getDatabase;

  return async function handleAuthEvents(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only GET is accepted.', undefined, {
        Allow: 'GET',
      });
    }

    let user;
    try {
      user = await readSession(request);
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
      throw err;
    }

    if (!user) {
      return errorResponse(401, 'AUTH_REQUIRED', 'Sign in to view your sign-in history.', undefined, {
        'www-authenticate': 'Cookie',
      });
    }

    try {
      const events = await listAuthEvents(resolveDb(), user.sub);
      return jsonResponse(200, {
        events: events.map((event) => ({
          event: event.event,
          ip: event.ip,
          userAgent: event.userAgent,
          createdAt: event.createdAt.getTime(),
        })),
      });
    } catch (err) {
      if (err instanceof DatabaseNotConfiguredError) {
        console.error('[auth-events] database is not configured');
        return errorResponse(503, 'AUTH_EVENTS_NOT_CONFIGURED', 'Sign-in history is not available on this deployment.');
      }
      console.error('[auth-events] failed:', err instanceof Error ? err.message : err);
      return errorResponse(500, 'AUTH_EVENTS_FAILED', 'Could not load sign-in history.');
    }
  };
}

/**
 * Account deletion.
 *
 * Requires an explicit `?confirm=true` so a stray or replayed DELETE cannot wipe
 * an account. The confirmation is a guard against accidents, not a security
 * control — the session cookie is.
 */
export function createDeleteAccountHandler(deps: AccountHandlerDeps = {}) {
  const resolveDb = deps.db ?? getDatabase;
  const limiter = deps.limiter ?? deleteLimiter;

  return async function handleDeleteAccount(request: Request): Promise<Response> {
    if (request.method !== 'DELETE') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only DELETE is accepted.', undefined, {
        Allow: 'DELETE',
      });
    }

    let user;
    try {
      user = await readSession(request);
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
      throw err;
    }

    if (!user) {
      return errorResponse(401, 'AUTH_REQUIRED', 'Sign in to delete your account.', undefined, {
        'www-authenticate': 'Cookie',
      });
    }

    const url = new URL(request.url);
    if (url.searchParams.get('confirm') !== 'true') {
      return errorResponse(400, 'CONFIRMATION_REQUIRED', 'Pass ?confirm=true to delete your account.');
    }

    const decision = limiter.consume(`delete:${user.sub}`);
    if (!decision.allowed) {
      return errorResponse(429, 'RATE_LIMITED', 'Too many deletion attempts.', undefined, {
        'retry-after': String(decision.retryAfterSeconds),
      });
    }

    try {
      const db = resolveDb();
      const deleted = await deleteAccountData(db, user.sub);

      // Best-effort: the deletion already happened, so a failed audit write must
      // not make it look like the account survived.
      await recordAuthEventSafely(db, {
        userId: user.sub,
        event: 'account_deleted',
        request,
      });

      return jsonResponse(200, { deleted });
    } catch (err) {
      if (err instanceof DatabaseNotConfiguredError) {
        console.error('[account] database is not configured');
        return errorResponse(503, 'DELETE_NOT_CONFIGURED', 'Account deletion is not configured on this deployment.');
      }
      console.error('[account] delete failed:', err instanceof Error ? err.message : err);
      return errorResponse(500, 'DELETE_FAILED', 'Account deletion failed.');
    }
  };
}

/**
 * Record an auth event without ever letting the write break the request that
 * caused it. A missing database is a deployment without sync configured and is
 * expected; anything else is logged loudly.
 */
export async function tryRecordAuthEvent(input: {
  readonly db: () => Database;
  readonly userId: string;
  readonly event: AuthEventName;
  readonly request: Request;
}): Promise<void> {
  try {
    await recordAuthEvent(input.db(), {
      userId: input.userId,
      event: input.event,
      ip: clientIp(input.request),
      userAgent: input.request.headers.get('user-agent'),
    });
  } catch (err) {
    if (err instanceof DatabaseNotConfiguredError) return;
    console.error('[auth] failed to record audit event:', err instanceof Error ? err.message : err);
  }
}

async function recordAuthEventSafely(
  db: Database,
  input: { readonly userId: string; readonly event: AuthEventName; readonly request: Request }
): Promise<void> {
  await tryRecordAuthEvent({ db: () => db, ...input });
}

export const handleSearchNotes = createSearchHandler();
export const handleAuthEvents = createAuthEventsHandler();
export const handleDeleteAccount = createDeleteAccountHandler();
