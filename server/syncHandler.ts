import { z } from 'zod';
import { getDatabase, DatabaseNotConfiguredError, type Database } from './db/client';
import { MAX_CONTENT_CHARS, PayloadTooLargeError, syncAll, listAll } from './db/syncRepo';
import type { FolderRow, NoteRow } from './db/schema';
import { errorResponse, jsonResponse, readJsonBody } from './http';
import { readSession } from './session';
import { AuthError } from './googleAuth';
import { clientIp, RateLimiter } from './rateLimit';

/**
 * Note sync endpoints. Authentication is mandatory — there is no anonymous
 * sync, because an unauthenticated writer would be an open storage proxy.
 */

const noteInputSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().max(2_000).default(''),
  content: z.string().max(MAX_CONTENT_CHARS).default(''),
  folderId: z.string().min(1).max(64).default('all'),
  tags: z.array(z.string().min(1).max(64)).max(100).default([]),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  trashed: z.boolean().default(false),
  wordCount: z.number().int().min(0).max(10_000_000).default(0),
  charCount: z.number().int().min(0).max(10_000_000).default(0),
  // Client timestamps are epoch milliseconds.
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  deletedAt: z.number().int().min(0).nullable().optional(),
});

const folderInputSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  icon: z.string().max(32).default(''),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, 'color must be a #rrggbb hex value')
    .default('#7c3aed'),
  parent: z.string().min(1).max(64).nullable().optional(),
  updatedAt: z.number().int().min(0),
  deletedAt: z.number().int().min(0).nullable().optional(),
});

const syncRequestSchema = z.object({
  notes: z.array(noteInputSchema).max(5_000).default([]),
  folders: z.array(folderInputSchema).max(500).default([]),
  since: z.number().int().min(0).nullable().optional(),
});

/** Syncs are bulk operations; keep the bucket well below the chat allowance. */
const syncLimiter = new RateLimiter({
  capacity: 30,
  refillPerSecond: 30 / 60,
  sweepIntervalMs: 30_000,
});

function toClientNote(row: NoteRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    folderId: row.folderId,
    tags: row.tags ?? [],
    pinned: row.pinned,
    archived: row.archived,
    trashed: row.trashed,
    wordCount: row.wordCount,
    charCount: row.charCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt.getTime() }),
  };
}

function toClientFolder(row: FolderRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    ...(row.parent === null ? {} : { parent: row.parent }),
    updatedAt: row.updatedAt.getTime(),
    ...(row.deletedAt === null ? {} : { deletedAt: row.deletedAt.getTime() }),
  };
}

export interface SyncHandlerDeps {
  /** Injectable so tests can run against PGlite instead of a live database. */
  readonly db?: () => Database;
}

export function createSyncHandler(deps: SyncHandlerDeps = {}) {
  const resolveDb = deps.db ?? getDatabase;

  return async function handleSync(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Only POST is accepted.', undefined, {
        Allow: 'POST',
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
      return errorResponse(401, 'AUTH_REQUIRED', 'Sign in to sync your notes.', undefined, {
        'www-authenticate': 'Cookie',
      });
    }

    const decision = syncLimiter.consume(`sync:${user.sub}`);
    if (!decision.allowed) {
      return errorResponse(
        429,
        'RATE_LIMITED',
        `Too many syncs. Try again in ${decision.retryAfterSeconds}s.`,
        undefined,
        { 'retry-after': String(decision.retryAfterSeconds) }
      );
    }

    const body = await readJsonBody(request);
    if (body === null) {
      return errorResponse(400, 'INVALID_JSON', 'Request body is not valid JSON.');
    }

    const parsed = syncRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_FAILED',
        'Sync payload failed schema validation.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })).slice(0, 20)
      );
    }

    const { notes: incomingNotes, folders: incomingFolders, since } = parsed.data;

    try {
      const result = await syncAll(resolveDb(), user.sub, {
        notes: incomingNotes.map((note) => ({
          id: note.id,
          title: note.title,
          content: note.content,
          folderId: note.folderId,
          tags: note.tags,
          pinned: note.pinned,
          archived: note.archived,
          trashed: note.trashed,
          wordCount: note.wordCount,
          charCount: note.charCount,
          createdAt: new Date(note.createdAt),
          updatedAt: new Date(note.updatedAt),
          deletedAt: note.deletedAt === null || note.deletedAt === undefined ? null : new Date(note.deletedAt),
        })),
        folders: incomingFolders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          icon: folder.icon,
          color: folder.color,
          parent: folder.parent ?? null,
          updatedAt: new Date(folder.updatedAt),
          deletedAt: folder.deletedAt === null || folder.deletedAt === undefined ? null : new Date(folder.deletedAt),
        })),
        since: since === null || since === undefined ? null : new Date(since),
      });

      return jsonResponse(200, {
        notes: result.notes.map(toClientNote),
        folders: result.folders.map(toClientFolder),
        serverTime: result.serverTime.getTime(),
      });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return errorResponse(413, 'PAYLOAD_TOO_LARGE', err.message);
      }
      if (err instanceof DatabaseNotConfiguredError) {
        console.error('[sync] database is not configured');
        return errorResponse(503, 'SYNC_NOT_CONFIGURED', 'Note sync is not configured on this deployment.');
      }
      // Never echo a database error to the client: it can leak schema and host.
      console.error('[sync] failed:', err instanceof Error ? err.message : err);
      return errorResponse(500, 'SYNC_FAILED', 'Note sync failed.');
    }
  };
}

export function createListHandler(deps: SyncHandlerDeps = {}) {
  const resolveDb = deps.db ?? getDatabase;

  return async function handleListNotes(request: Request): Promise<Response> {
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
      return errorResponse(401, 'AUTH_REQUIRED', 'Sign in to read your notes.');
    }

    try {
      const result = await listAll(resolveDb(), user.sub);
      return jsonResponse(200, {
        notes: result.notes.map(toClientNote),
        folders: result.folders.map(toClientFolder),
      });
    } catch (err) {
      if (err instanceof DatabaseNotConfiguredError) {
        return errorResponse(503, 'SYNC_NOT_CONFIGURED', 'Note sync is not configured on this deployment.');
      }
      console.error('[sync] list failed:', err instanceof Error ? err.message : err);
      return errorResponse(500, 'SYNC_FAILED', 'Could not read your notes.');
    }
  };
}

export const handleSync = createSyncHandler();
export const handleListNotes = createListHandler();

/** Re-exported so the sync bucket can be inspected in tests. */
export { clientIp };
