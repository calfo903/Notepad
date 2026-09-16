import type { Note } from '../../types';
import type { RemoteFolder, RemoteNote } from './merge';

/**
 * Sync API client.
 *
 * Same-origin and cookie-authenticated. A 401 means the session expired, which
 * the caller turns into "sync paused" rather than an error banner — the app
 * keeps working locally.
 */

export interface SyncResponse {
  readonly notes: readonly RemoteNote[];
  readonly folders: readonly RemoteFolder[];
  readonly serverTime: number;
}

export interface SnapshotResponse {
  readonly notes: readonly RemoteNote[];
  readonly folders: readonly RemoteFolder[];
}

export class SyncError extends Error {
  override readonly name = 'SyncError';
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, SyncError.prototype);
  }
}

interface ApiErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function toError(response: Response): Promise<SyncError> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    const text = await response.text();
    if (text.length > 0) envelope = JSON.parse(text) as ApiErrorEnvelope;
  } catch {
    envelope = null;
  }

  return new SyncError(
    response.status,
    envelope?.error?.code ?? 'UNKNOWN',
    envelope?.error?.message ?? `Sync failed with status ${response.status}`
  );
}

export async function pushAndPull(payload: {
  readonly notes: readonly Note[];
  readonly folders: readonly RemoteFolder[];
  readonly since: number | null;
  readonly signal?: AbortSignal;
}): Promise<SyncResponse> {
  let response: Response;
  try {
    response = await fetch('/api/notes/sync', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      signal: payload.signal,
      body: JSON.stringify({
        notes: payload.notes,
        folders: payload.folders,
        since: payload.since,
      }),
    });
  } catch (err) {
    if (payload.signal?.aborted) throw err;
    throw new SyncError(0, 'NETWORK', 'Could not reach the sync service.');
  }

  if (!response.ok) throw await toError(response);

  return (await response.json()) as SyncResponse;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotResponse> {
  let response: Response;
  try {
    response = await fetch('/api/notes', {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new SyncError(0, 'NETWORK', 'Could not reach the sync service.');
  }

  if (!response.ok) throw await toError(response);

  return (await response.json()) as SnapshotResponse;
}
