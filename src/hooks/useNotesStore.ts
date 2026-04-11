import { useState, useCallback, useRef, useMemo } from 'react';
import {
  Note,
  DEFAULT_FOLDERS,
  STORAGE_KEY,
  Theme,
  ViewMode,
  SortBy,
  SortOrder,
  SaveStatus,
  ExportFormat,
  AppState,
} from '../types';
import {
  generateId,
  stripHtml,
  countWords,
  countChars,
  htmlToMarkdown,
  safeLocalStorageGet,
  safeLocalStorageSet,
  validateNoteInput,
  sanitizeHtml,
} from '../utils/helpers';

// ============================================================================
// Initial State
// ============================================================================

function createEmptyNote(folderId: string = 'personal'): Note {
  const now = Date.now();
  return {
    id: generateId(),
    title: '',
    content: '',
    folderId,
    tags: [],
    pinned: false,
    archived: false,
    trashed: false,
    createdAt: now,
    updatedAt: now,
    wordCount: 0,
    charCount: 0,
  };
}

function getSampleNotes(): Note[] {
  const now = Date.now();
  const notes: Note[] = [
    {
      id: generateId(),
      title: '👋 Welcome to NoteFlow AI!',
      content: `<h2>Welcome to NoteFlow AI — Your Smart Notepad</h2>
<p>NoteFlow AI is a powerful, AI-enhanced notepad that runs in your browser.</p>
<h3>✨ Key Features</h3>
<ul>
<li><strong>🤖 AI Assistant</strong> — Write, summarize, improve & translate</li>
<li><strong>🧠 AI Memory</strong> — Remembers your preferences</li>
<li><strong>Rich Text</strong> — Bold, italic, headings, lists & more</li>
<li><strong>Folders</strong> — Organize into Personal, Work, Ideas</li>
<li><strong>Auto-Save</strong> — Never lose your work</li>
<li><strong>Dark Mode</strong> — Beautiful dark theme</li>
<li><strong>Export</strong> — Text, HTML, or Markdown</li>
</ul>
<h3>⌨️ Shortcuts</h3>
<ul>
<li><code>Ctrl+J</code> — AI Assistant</li>
<li><code>Ctrl+N</code> — New note</li>
<li><code>Ctrl+B/I/U</code> — Bold/Italic/Underline</li>
</ul>
<blockquote>Tip: Press Ctrl+J to open the AI Assistant! 🚀</blockquote>`,
      folderId: 'personal',
      tags: ['welcome', 'tutorial'],
      pinned: true,
      archived: false,
      trashed: false,
      createdAt: now - 86400000,
      updatedAt: now - 3600000,
      wordCount: 0,
      charCount: 0,
    },
    {
      id: generateId(),
      title: '💡 Project Ideas',
      content: `<h3>App Ideas to Explore</h3>
<ol>
<li><strong>Task Manager</strong> — Kanban with drag-and-drop</li>
<li><strong>Weather Dashboard</strong> — Real-time visualizations</li>
<li><strong>Expense Tracker</strong> — Charts and categories</li>
<li><strong>Recipe Book</strong> — Organize favorites</li>
<li><strong>Habit Tracker</strong> — Streaks and statistics</li>
</ol>
<hr>
<p>The best projects solve real problems you care about!</p>`,
      folderId: 'ideas',
      tags: ['projects', 'brainstorm'],
      pinned: false,
      archived: false,
      trashed: false,
      createdAt: now - 172800000,
      updatedAt: now - 7200000,
      wordCount: 0,
      charCount: 0,
    },
    {
      id: generateId(),
      title: '📋 Meeting Notes — Q1 Planning',
      content: `<h2>Q1 Planning Meeting</h2>
<p><strong>Date:</strong> January 2026</p>
<h3>Agenda</h3>
<ol>
<li>Review Q4 results</li>
<li>Set Q1 priorities</li>
<li>Resource allocation</li>
<li>Action items</li>
</ol>
<h3>Key Decisions</h3>
<ul>
<li>Focus on UX improvements</li>
<li>Launch feature by Feb</li>
<li>Weekly sync meetings</li>
</ul>
<h3>Action Items</h3>
<ul>
<li>Design mockups — <strong>Design</strong></li>
<li>CI/CD setup — <strong>Engineering</strong></li>
<li>Timeline — <strong>PM</strong></li>
</ul>`,
      folderId: 'work',
      tags: ['meeting', 'planning'],
      pinned: false,
      archived: false,
      trashed: false,
      createdAt: now - 259200000,
      updatedAt: now - 86400000,
      wordCount: 0,
      charCount: 0,
    },
  ];

  // Calculate word/char counts
  return notes.map((n) => {
    const text = stripHtml(n.content);
    n.wordCount = countWords(text);
    n.charCount = countChars(text);
    return n;
  });
}

function getInitialState(): AppState {
  // Use encrypted storage for sensitive data
  const saved = safeLocalStorageGet<Partial<AppState>>(STORAGE_KEY, {}, true);
  
  const notes = saved.notes?.length ? saved.notes : getSampleNotes();
  
  return {
    notes,
    folders: saved.folders || DEFAULT_FOLDERS,
    activeNoteId: saved.activeNoteId || (notes[0]?.id ?? null),
    activeFolder: saved.activeFolder || 'all',
    searchQuery: '',
    viewMode: (saved.viewMode as ViewMode) || 'editor',
    theme: (saved.theme as Theme) || 'dark',
    showRightPanel: saved.showRightPanel ?? false,
    sidebarCollapsed: saved.sidebarCollapsed ?? false,
    sortBy: (saved.sortBy as SortBy) || 'updatedAt',
    sortOrder: (saved.sortOrder as SortOrder) || 'desc',
    saveStatus: 'saved',
    showMobileMenu: false,
    showMobileNoteList: false,
  };
}

// ============================================================================
// Hook
// ============================================================================

export function useNotesStore() {
  const [state, setState] = useState<AppState>(getInitialState);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Save to localStorage with debounce and encryption
  const saveToStorage = useCallback((newState: AppState) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    
    saveTimeoutRef.current = setTimeout(() => {
      const toSave = {
        notes: newState.notes,
        folders: newState.folders,
        activeNoteId: newState.activeNoteId,
        activeFolder: newState.activeFolder,
        viewMode: newState.viewMode,
        theme: newState.theme,
        showRightPanel: newState.showRightPanel,
        sidebarCollapsed: newState.sidebarCollapsed,
        sortBy: newState.sortBy,
        sortOrder: newState.sortOrder,
      };
      // Encrypt sensitive data before storing
      safeLocalStorageSet(STORAGE_KEY, toSave, true);
      setState((prev) => ({ ...prev, saveStatus: 'saved' }));
    }, 500);
  }, []);

  // Update state and trigger save
  const updateState = useCallback(
    (updates: Partial<AppState> | ((prev: AppState) => Partial<AppState>)) => {
      setState((prev) => {
        const newUpdates = typeof updates === 'function' ? updates(prev) : updates;
        const newState = { ...prev, ...newUpdates, saveStatus: 'saving' as SaveStatus };
        saveToStorage(newState);
        return newState;
      });
    },
    [saveToStorage]
  );

  // ========== Memoized Selectors ==========

  const filteredNotes = useMemo(() => {
    const { notes, activeFolder, searchQuery, sortBy, sortOrder } = state;
    
    let filtered = notes.filter((note) => {
      // Folder filtering
      if (activeFolder === 'all') return !note.trashed && !note.archived;
      if (activeFolder === 'favorites') return note.pinned && !note.trashed && !note.archived;
      if (activeFolder === 'archive') return note.archived && !note.trashed;
      if (activeFolder === 'trash') return note.trashed;
      return note.folderId === activeFolder && !note.trashed && !note.archived;
    });

    // Search filtering
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (note) =>
          note.title.toLowerCase().includes(query) ||
          stripHtml(note.content).toLowerCase().includes(query) ||
          note.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    }

    // Sorting
    filtered.sort((a, b) => {
      // Pinned notes always first (except in trash/archive)
      if (!['trash', 'archive'].includes(activeFolder)) {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
      }

      let comparison = 0;
      if (sortBy === 'title') {
        comparison = a.title.localeCompare(b.title);
      } else {
        comparison = a[sortBy] - b[sortBy];
      }
      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return filtered;
  }, [state.notes, state.activeFolder, state.searchQuery, state.sortBy, state.sortOrder]);

  const activeNote = useMemo(() => {
    return state.notes.find((n) => n.id === state.activeNoteId) || null;
  }, [state.notes, state.activeNoteId]);

  const getFolderNoteCount = useCallback(
    (folderId: string): number => {
      return state.notes.filter((note) => {
        if (folderId === 'all') return !note.trashed && !note.archived;
        if (folderId === 'favorites') return note.pinned && !note.trashed && !note.archived;
        if (folderId === 'archive') return note.archived && !note.trashed;
        if (folderId === 'trash') return note.trashed;
        return note.folderId === folderId && !note.trashed && !note.archived;
      }).length;
    },
    [state.notes]
  );

  const folderNoteCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    state.folders.forEach((folder) => {
      counts[folder.id] = getFolderNoteCount(folder.id);
    });
    return counts;
  }, [state.folders, getFolderNoteCount]);

  // ========== Actions ==========

  const createNote = useCallback(() => {
    const folder = ['all', 'favorites', 'archive', 'trash'].includes(state.activeFolder)
      ? 'personal'
      : state.activeFolder;
    const newNote = createEmptyNote(folder);
    
    updateState((prev) => ({
      notes: [newNote, ...prev.notes],
      activeNoteId: newNote.id,
      showMobileNoteList: false,
    }));
  }, [state.activeFolder, updateState]);

  const updateNote = useCallback(
    (id: string, updates: Partial<Note>) => {
      updateState((prev) => ({
        notes: prev.notes.map((note) => {
          if (note.id !== id) return note;
          
          // Validate and sanitize input
          const validation = validateNoteInput(
            updates.title ?? note.title,
            updates.content ?? note.content,
            updates.tags ?? note.tags
          );
          
          if (!validation.isValid) {
            console.warn('Note validation failed:', validation.errors);
          }
          
          const updatedNote = { 
            ...note, 
            ...updates,
            title: validation.sanitizedTitle,
            content: validation.sanitizedContent,
            tags: validation.sanitizedTags,
            updatedAt: Date.now() 
          };
          
          // Recalculate word/char counts if content changed
          if (updates.content !== undefined) {
            const text = stripHtml(updates.content);
            updatedNote.wordCount = countWords(text);
            updatedNote.charCount = countChars(text);
          }
          
          return updatedNote;
        }),
      }));
    },
    [updateState]
  );

  const deleteNote = useCallback(
    (id: string) => {
      const note = state.notes.find((n) => n.id === id);
      if (!note) return;

      if (note.trashed) {
        // Permanently delete
        updateState((prev) => {
          const newNotes = prev.notes.filter((n) => n.id !== id);
          const newActiveId =
            prev.activeNoteId === id
              ? newNotes.find((n) => !n.trashed)?.id || null
              : prev.activeNoteId;
          return { notes: newNotes, activeNoteId: newActiveId };
        });
      } else {
        // Move to trash
        updateNote(id, { trashed: true, archived: false });
      }
    },
    [state.notes, updateNote, updateState]
  );

  const restoreNote = useCallback(
    (id: string) => {
      updateNote(id, { trashed: false });
    },
    [updateNote]
  );

  const togglePin = useCallback(
    (id: string) => {
      const note = state.notes.find((n) => n.id === id);
      if (note) {
        updateNote(id, { pinned: !note.pinned });
      }
    },
    [state.notes, updateNote]
  );

  const archiveNote = useCallback(
    (id: string) => {
      const note = state.notes.find((n) => n.id === id);
      if (note) {
        updateNote(id, { archived: !note.archived });
      }
    },
    [state.notes, updateNote]
  );

  const emptyTrash = useCallback(() => {
    updateState((prev) => ({
      notes: prev.notes.filter((n) => !n.trashed),
      activeNoteId: prev.notes.find((n) => !n.trashed)?.id || null,
    }));
  }, [updateState]);

  const duplicateNote = useCallback(
    (id: string) => {
      const note = state.notes.find((n) => n.id === id);
      if (!note) return;

      const newNote: Note = {
        ...note,
        id: generateId(),
        title: `${note.title} (Copy)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
      };

      updateState((prev) => ({
        notes: [newNote, ...prev.notes],
        activeNoteId: newNote.id,
      }));
    },
    [state.notes, updateState]
  );

  const exportNote = useCallback(
    (id: string, format: ExportFormat) => {
      const note = state.notes.find((n) => n.id === id);
      if (!note) return;

      let content: string;
      let filename: string;
      let mimeType: string;

      switch (format) {
        case 'html':
          content = `<!DOCTYPE html>
<html>
<head><title>${note.title}</title></head>
<body>
<h1>${note.title}</h1>
${note.content}
</body>
</html>`;
          filename = `${note.title || 'note'}.html`;
          mimeType = 'text/html';
          break;
        case 'markdown':
          content = `# ${note.title}\n\n${htmlToMarkdown(note.content)}`;
          filename = `${note.title || 'note'}.md`;
          mimeType = 'text/markdown';
          break;
        default:
          content = `${note.title}\n\n${stripHtml(note.content)}`;
          filename = `${note.title || 'note'}.txt`;
          mimeType = 'text/plain';
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    },
    [state.notes]
  );

  // ========== UI Actions ==========

  const setActiveNote = useCallback(
    (id: string | null) => {
      updateState({ activeNoteId: id, showMobileNoteList: false });
    },
    [updateState]
  );

  const setActiveFolder = useCallback(
    (folderId: string) => {
      updateState({ activeFolder: folderId, showMobileMenu: false });
    },
    [updateState]
  );

  const setSearchQuery = useCallback(
    (query: string) => {
      setState((prev) => ({ ...prev, searchQuery: query }));
    },
    []
  );

  const setViewMode = useCallback(
    (mode: ViewMode) => {
      updateState({ viewMode: mode });
    },
    [updateState]
  );

  const toggleTheme = useCallback(() => {
    updateState((prev) => {
      const newTheme = prev.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', newTheme === 'dark');
      return { theme: newTheme };
    });
  }, [updateState]);

  const toggleRightPanel = useCallback(() => {
    updateState((prev) => ({ showRightPanel: !prev.showRightPanel }));
  }, [updateState]);

  const toggleSidebar = useCallback(() => {
    updateState((prev) => ({ sidebarCollapsed: !prev.sidebarCollapsed }));
  }, [updateState]);

  const setSortBy = useCallback(
    (sortBy: SortBy) => {
      updateState({ sortBy });
    },
    [updateState]
  );

  const setSortOrder = useCallback(
    (sortOrder: SortOrder) => {
      updateState({ sortOrder });
    },
    [updateState]
  );

  const toggleMobileMenu = useCallback(() => {
    updateState((prev) => ({ 
      showMobileMenu: !prev.showMobileMenu,
      showMobileNoteList: false,
    }));
  }, [updateState]);

  const toggleMobileNoteList = useCallback(() => {
    updateState((prev) => ({ 
      showMobileNoteList: !prev.showMobileNoteList,
      showMobileMenu: false,
    }));
  }, [updateState]);

  const closeMobileOverlays = useCallback(() => {
    updateState({ showMobileMenu: false, showMobileNoteList: false });
  }, [updateState]);

  return {
    state,
    // Computed
    filteredNotes,
    activeNote,
    folderNoteCounts,
    // Note Actions
    createNote,
    updateNote,
    deleteNote,
    restoreNote,
    togglePin,
    archiveNote,
    emptyTrash,
    duplicateNote,
    exportNote,
    // UI Actions
    setActiveNote,
    setActiveFolder,
    setSearchQuery,
    setViewMode,
    toggleTheme,
    toggleRightPanel,
    toggleSidebar,
    setSortBy,
    setSortOrder,
    toggleMobileMenu,
    toggleMobileNoteList,
    closeMobileOverlays,
  };
}

export type NotesStore = ReturnType<typeof useNotesStore>;
