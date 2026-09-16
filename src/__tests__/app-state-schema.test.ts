import { describe, it, expect } from 'vitest';
import { hydrateAppState } from '../utils/appStateSchema';
import { DEFAULT_FOLDERS } from '../types';

/**
 * `localStorage` is untrusted: another tab, an extension, or an older app
 * version can write anything into it. These cover the shapes that used to reach
 * React unchecked and throw during render.
 */

function validNote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    title: 'Hello',
    content: '<p>World</p>',
    folderId: 'all',
    tags: ['a'],
    pinned: false,
    archived: false,
    trashed: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    wordCount: 1,
    charCount: 5,
    ...overrides,
  };
}

describe('hydrateAppState — corrupt top-level values', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not json object'],
    ['a number', 42],
    ['a boolean', true],
  ])('returns defaults for %s', (_label, value) => {
    const result = hydrateAppState(value);

    expect(result.wasCorrupt).toBe(true);
    expect(result.state.notes).toEqual([]);
    expect(result.state.folders).toHaveLength(DEFAULT_FOLDERS.length);
    expect(result.state.theme).toBe('dark');
    expect(result.state.viewMode).toBe('editor');
  });

  it('treats an array as corrupt rather than an empty state', () => {
    const result = hydrateAppState([validNote()]);

    expect(result.wasCorrupt).toBe(true);
    expect(result.state.notes).toEqual([]);
  });
});

describe('hydrateAppState — repair rather than reject', () => {
  it('keeps valid notes and reports the ones it dropped', () => {
    const result = hydrateAppState({
      notes: [validNote({ id: 'good' }), { id: 123, title: null }, null, 'nonsense', validNote({ id: 'also-good' })],
    });

    expect(result.wasCorrupt).toBe(false);
    expect(result.state.notes.map((note) => note.id)).toEqual(['good', 'also-good']);
    expect(result.droppedNotes).toBe(3);
  });

  it('does not lose every note when `notes` is not an array', () => {
    const result = hydrateAppState({ notes: 'definitely not an array' });

    expect(result.wasCorrupt).toBe(true);
  });

  it('reports dropped folders separately from dropped notes', () => {
    const result = hydrateAppState({
      notes: [validNote()],
      folders: [{ id: 'custom', name: 'Custom' }, { nope: true }],
    });

    expect(result.droppedNotes).toBe(0);
    expect(result.droppedFolders).toBe(1);
  });

  it('dedupes repeated ids, keeping the last write', () => {
    const result = hydrateAppState({
      notes: [validNote({ id: 'dup', title: 'first' }), validNote({ id: 'dup', title: 'second' })],
    });

    expect(result.state.notes).toHaveLength(1);
    expect(result.state.notes[0].title).toBe('second');
  });

  it('re-adds built-in folders a corrupt write removed', () => {
    const result = hydrateAppState({ folders: [{ id: 'custom', name: 'Custom', icon: '', color: '#000000' }] });

    const ids = result.state.folders.map((folder) => folder.id);
    expect(ids).toContain('custom');
    for (const builtIn of DEFAULT_FOLDERS) expect(ids).toContain(builtIn.id);
  });

  it('fills missing optional fields with defaults', () => {
    const result = hydrateAppState({ notes: [{ id: 'sparse' }] });

    expect(result.droppedNotes).toBe(0);
    expect(result.state.notes[0]).toMatchObject({
      id: 'sparse',
      title: '',
      content: '',
      folderId: 'all',
      tags: [],
      pinned: false,
    });
  });
});

describe('hydrateAppState — dangling references', () => {
  it('falls back to the first note when activeNoteId points at a dropped note', () => {
    const result = hydrateAppState({
      notes: [validNote({ id: 'kept' }), { broken: true }],
      activeNoteId: 'gone',
    });

    expect(result.droppedNotes).toBe(1);
    expect(result.state.activeNoteId).toBe('kept');
  });

  it('falls back to null when no notes survive', () => {
    const result = hydrateAppState({ notes: [{ broken: true }], activeNoteId: 'x' });

    expect(result.state.notes).toEqual([]);
    expect(result.state.activeNoteId).toBeNull();
  });

  it('falls back to "all" when activeFolder no longer exists', () => {
    const result = hydrateAppState({
      folders: [{ id: 'custom', name: 'Custom', icon: '', color: '#000000' }],
      activeFolder: 'deleted-folder',
    });

    expect(result.state.activeFolder).toBe('all');
  });

  it('keeps a valid activeFolder', () => {
    const result = hydrateAppState({
      folders: [{ id: 'custom', name: 'Custom', icon: '', color: '#000000' }],
      activeFolder: 'custom',
    });

    expect(result.state.activeFolder).toBe('custom');
  });
});

describe('hydrateAppState — preference enums', () => {
  it('rejects unknown enum values instead of passing them through', () => {
    const result = hydrateAppState({
      theme: 'neon',
      viewMode: 'hologram',
      sortBy: 'vibes',
      sortOrder: 'sideways',
    });

    // Unknown enums fail the schema, so the whole object is treated as corrupt
    // and the caller starts from defaults rather than rendering an invalid theme.
    expect(result.wasCorrupt).toBe(true);
    expect(result.state.theme).toBe('dark');
    expect(result.state.viewMode).toBe('editor');
    expect(result.state.sortBy).toBe('updatedAt');
    expect(result.state.sortOrder).toBe('desc');
  });

  it('preserves valid preferences', () => {
    const result = hydrateAppState({
      theme: 'light',
      viewMode: 'focus',
      sortBy: 'title',
      sortOrder: 'asc',
      showRightPanel: true,
      sidebarCollapsed: true,
    });

    expect(result.state).toMatchObject({
      theme: 'light',
      viewMode: 'focus',
      sortBy: 'title',
      sortOrder: 'asc',
      showRightPanel: true,
      sidebarCollapsed: true,
    });
  });

  it('never trusts a stored searchQuery, which is not persisted', () => {
    const result = hydrateAppState({ searchQuery: 'injected' } as unknown);

    expect('searchQuery' in result.state).toBe(false);
  });
});
