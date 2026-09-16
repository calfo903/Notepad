import { describe, it, expect } from 'vitest';
import {
  collectChangedFolders,
  collectChangedNotes,
  mergeFolders,
  mergeNotes,
  type RemoteNote,
} from '../services/sync/merge';
import type { Folder } from '../types';

/**
 * A merge bug destroys user data silently and permanently, so every branch of
 * the conflict rules is pinned by a test.
 */

function note(overrides: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: 'n1',
    title: 'Untitled',
    content: '',
    folderId: 'all',
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    wordCount: 0,
    charCount: 0,
    ...overrides,
  };
}

function folder(overrides: Partial<Folder> = {}): Folder {
  return { id: 'f1', name: 'Work', icon: '💼', color: '#3b82f6', ...overrides };
}

describe('mergeNotes', () => {
  it('inserts a note the client has never seen', () => {
    const result = mergeNotes([], [note({ id: 'remote' })]);

    expect(result.items).toHaveLength(1);
    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('replaces a local note when the remote revision is newer', () => {
    const local = [note({ id: 'n1', title: 'local', updatedAt: 1_000 })];
    const remote: RemoteNote[] = [note({ id: 'n1', title: 'remote', updatedAt: 2_000 })];

    const result = mergeNotes(local, remote);

    expect(result.items[0].title).toBe('remote');
    expect(result.updated).toBe(1);
  });

  it('keeps the local note when it is newer, so it can still be pushed', () => {
    const local = [note({ id: 'n1', title: 'local', updatedAt: 5_000 })];
    const remote: RemoteNote[] = [note({ id: 'n1', title: 'remote', updatedAt: 2_000 })];

    const result = mergeNotes(local, remote);

    expect(result.items[0].title).toBe('local');
    expect(result.keptLocal).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('treats an equal timestamp as local-wins to avoid a pointless rewrite', () => {
    const local = [note({ id: 'n1', updatedAt: 1_000 })];
    const remote: RemoteNote[] = [note({ id: 'n1', updatedAt: 1_000 })];

    expect(mergeNotes(local, remote).keptLocal).toBe(1);
  });

  it('drops a local note when the remote row is a tombstone', () => {
    const local = [note({ id: 'n1' }), note({ id: 'n2' })];
    const remote: RemoteNote[] = [note({ id: 'n1', deletedAt: 3_000 })];

    const result = mergeNotes(local, remote);

    expect(result.items.map((item) => item.id)).toEqual(['n2']);
    expect(result.removed).toBe(1);
  });

  it('ignores a tombstone for a note that was never local', () => {
    const result = mergeNotes([], [note({ id: 'ghost', deletedAt: 3_000 })]);

    expect(result.items).toHaveLength(0);
    expect(result.removed).toBe(0);
  });

  it('does not mutate the local array', () => {
    const local = [note({ id: 'n1' })];
    const snapshot = [...local];

    mergeNotes(local, [note({ id: 'n2' })]);

    expect(local).toEqual(snapshot);
  });

  it('handles an empty remote payload as a no-op', () => {
    const local = [note({ id: 'n1' })];
    const result = mergeNotes(local, []);

    expect(result.items).toHaveLength(1);
    expect(result.added + result.updated + result.removed).toBe(0);
  });

  it('processes a mixed batch and counts each outcome', () => {
    const local = [
      note({ id: 'keep', updatedAt: 9_000 }),
      note({ id: 'replace', updatedAt: 1_000 }),
      note({ id: 'delete' }),
    ];
    const remote: RemoteNote[] = [
      note({ id: 'keep', updatedAt: 2_000 }),
      note({ id: 'replace', title: 'newer', updatedAt: 5_000 }),
      note({ id: 'delete', deletedAt: 5_000 }),
      note({ id: 'fresh' }),
    ];

    const result = mergeNotes(local, remote);

    expect(result.keptLocal).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.items.map((item) => item.id).sort()).toEqual(['fresh', 'keep', 'replace']);
  });
});

describe('mergeFolders', () => {
  it('lets a remote folder win over a built-in folder with no timestamp', () => {
    // DEFAULT_FOLDERS carry no updatedAt, so they must not be treated as newest.
    const local = [folder({ id: 'work', name: 'Work' })];
    const remote = [{ ...folder({ id: 'work', name: 'Renamed' }), updatedAt: 5_000 }];

    const result = mergeFolders(local, remote);

    expect(result.items[0].name).toBe('Renamed');
    expect(result.updated).toBe(1);
  });

  it('drops tombstoned folders', () => {
    const local = [folder({ id: 'work' })];
    const remote = [{ ...folder({ id: 'work' }), updatedAt: 5_000, deletedAt: 6_000 }];

    expect(mergeFolders(local, remote).removed).toBe(1);
  });
});

describe('collectChangedNotes', () => {
  it('returns everything on the first sync', () => {
    const notes = [note({ id: 'a' }), note({ id: 'b' })];

    expect(collectChangedNotes(notes, null)).toHaveLength(2);
  });

  it('returns only notes modified after the cursor', () => {
    const notes = [
      note({ id: 'old', updatedAt: 1_000 }),
      note({ id: 'new', updatedAt: 5_000 }),
    ];

    expect(collectChangedNotes(notes, 3_000).map((item) => item.id)).toEqual(['new']);
  });

  it('returns nothing when no note is newer than the cursor', () => {
    expect(collectChangedNotes([note({ updatedAt: 1_000 })], 2_000)).toEqual([]);
  });
});

describe('collectChangedFolders', () => {
  it('stamps built-in folders that carry no timestamp', () => {
    const before = Date.now();
    const result = collectChangedFolders([folder({ id: 'work' })], null);

    expect(result[0].updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('filters by the cursor once stamped', () => {
    const result = collectChangedFolders(
      [{ ...folder({ id: 'work' }), updatedAt: 1_000 } as Folder],
      5_000
    );

    expect(result).toEqual([]);
  });
});
