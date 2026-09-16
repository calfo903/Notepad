import { useCallback, useEffect, useRef, useState } from 'react';
import type { Folder, Note } from '../types';
import { safeLocalStorageGet, safeLocalStorageSet } from '../utils/helpers';
import {
  collectChangedFolders,
  collectChangedNotes,
  mergeFolders,
  mergeNotes,
} from '../services/sync/merge';
import { pushAndPull, SyncError } from '../services/sync/syncClient';

/** Server-issued cursor. Comparing against it avoids trusting the local clock. */
export const SYNC_CURSOR_KEY = 'noteflow-sync-cursor';

/** Quiet period after the last edit before a push. */
const DEBOUNCE_MS = 2_000;

export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'error';

interface UseSyncOptions {
  readonly isAuthenticated: boolean;
  readonly notes: readonly Note[];
  readonly folders: readonly Folder[];
  readonly onApplyRemote: (notes: Note[], folders: Folder[]) => void;
}

/**
 * Background sync.
 *
 * The app remains fully usable offline: this hook only moves data when it can,
 * and never blocks editing. Failure degrades to a status indicator, not a modal.
 */
export function useSync({ isAuthenticated, notes, folders, onApplyRemote }: UseSyncOptions) {
  const [status, setStatus] = useState<SyncStatus>(isAuthenticated ? 'idle' : 'disabled');
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() =>
    safeLocalStorageGet<number | null>(SYNC_CURSOR_KEY, null)
  );

  /** Set while applying remote rows, so the resulting state change is not re-pushed. */
  const suppressRef = useRef(false);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kept in refs so the debounced callback reads current data, not a stale closure.
  const notesRef = useRef(notes);
  const foldersRef = useRef(folders);
  const cursorRef = useRef(lastSyncedAt);

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);
  useEffect(() => {
    cursorRef.current = lastSyncedAt;
  }, [lastSyncedAt]);

  const runSync = useCallback(async (): Promise<void> => {
    // One sync at a time. Concurrent syncs would each compute a cursor and the
    // later write would silently drop the earlier one's changes.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStatus('syncing');

    try {
      const result = await pushAndPull({
        notes: collectChangedNotes(notesRef.current, cursorRef.current),
        folders: collectChangedFolders(foldersRef.current, cursorRef.current),
        since: cursorRef.current,
      });

      const mergedNotes = mergeNotes(notesRef.current, result.notes);
      const mergedFolders = mergeFolders(foldersRef.current, result.folders);

      setLastSyncedAt(result.serverTime);
      safeLocalStorageSet(SYNC_CURSOR_KEY, result.serverTime);

      const changed =
        mergedNotes.added + mergedNotes.updated + mergedNotes.removed +
        mergedFolders.added + mergedFolders.updated + mergedFolders.removed;

      if (changed > 0) {
        suppressRef.current = true;
        onApplyRemote([...mergedNotes.items], [...mergedFolders.items]);
      }

      setError(null);
      setStatus('idle');
    } catch (err) {
      if (err instanceof SyncError && err.status === 401) {
        // Session expired. Not an error worth shouting about; sync just pauses.
        setStatus('disabled');
        setError(null);
        return;
      }

      setError(err instanceof Error ? err.message : 'Sync failed.');
      setStatus('error');
    } finally {
      inFlightRef.current = false;
    }
  }, [onApplyRemote]);

  useEffect(() => {
    if (!isAuthenticated) {
      setStatus('disabled');
      return;
    }

    setStatus((current) => (current === 'disabled' ? 'idle' : current));

    // Consume the suppression flag raised by the previous apply, and skip: the
    // change in `notes` came from the server, not from the user.
    if (suppressRef.current) {
      suppressRef.current = false;
      return;
    }

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void runSync();
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [notes, folders, isAuthenticated, runSync]);

  // Drop a pending timer on unmount so it cannot fire against torn-down state.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    []
  );

  const syncNow = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void runSync();
  }, [runSync]);

  const resetCursor = useCallback(() => {
    setLastSyncedAt(null);
    safeLocalStorageSet(SYNC_CURSOR_KEY, null);
  }, []);

  return { status, error, lastSyncedAt, syncNow, resetCursor, isSyncing: status === 'syncing' };
}

export type SyncStore = ReturnType<typeof useSync>;
