import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useNotesStore } from './hooks/useNotesStore';
import { useAI } from './hooks/useAI';
import { useAuth } from './hooks/useAuth';
import { useSync } from './hooks/useSync';
import { Sidebar } from './components/Sidebar';
import { NoteList } from './components/NoteList';
import { Toolbar } from './components/Toolbar';
import { NoteEditor } from './components/NoteEditor';
import { RightPanel } from './components/RightPanel';
import { AIPanel } from './components/AIPanel';
import { cn, stripHtml, textToHtml, estimateReadTime } from './utils/helpers';
import { sanitizeHtml } from './utils/sanitize';
import { Icons } from './components/icons';
import { SortBy } from './types';

function App() {
  const store = useNotesStore();
  const ai = useAI();
  const auth = useAuth();
  // Sync only runs while authenticated; offline the app stays fully usable.
  const sync = useSync({
    isAuthenticated: auth.status === 'authenticated',
    notes: store.state.notes,
    folders: store.state.folders,
    onApplyRemote: store.applyRemoteSync,
  });
  const [showAIPanel, setShowAIPanel] = useState(false);
  const editorRef = useRef<HTMLDivElement | null>(null);

  const {
    state,
    filteredNotes,
    activeNote,
    allTags,
    folderNoteCounts,
    createNote,
    updateNote,
    deleteNote,
    restoreNote,
    togglePin,
    archiveNote,
    emptyTrash,
    duplicateNote,
    exportNote,
    reorderNotes,
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
  } = store;

  // Apply theme on mount
  useEffect(() => {
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
  }, [state.theme]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key.toLowerCase()) {
          case 'n':
            e.preventDefault();
            createNote();
            break;
          case 'j':
            e.preventDefault();
            setShowAIPanel((prev) => !prev);
            break;
        }
      }
      // Escape to close overlays
      if (e.key === 'Escape') {
        if (showAIPanel) {
          setShowAIPanel(false);
        } else {
          closeMobileOverlays();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [createNote, closeMobileOverlays, showAIPanel, setShowAIPanel]);

  // Format command handler.
  // execCommand mutates the editor DOM directly, so the serialisation is
  // sanitized before it becomes note state (and is later persisted/exported).
  const handleFormat = useCallback(
    (command: string, value?: string) => {
      document.execCommand(command, false, value);
      if (editorRef.current && state.activeNoteId) {
        updateNote(state.activeNoteId, {
          content: sanitizeHtml(editorRef.current.innerHTML),
        });
      }
    },
    [state.activeNoteId, updateNote]
  );

  // Update AI context when active note changes
  useEffect(() => {
    if (activeNote) {
      ai.updateNoteContext(activeNote.title, activeNote.tags);
    }
  }, [activeNote, ai]);

  // Handle inserting AI-generated content.
  // `content` is raw LLM output: textToHtml escapes it into inert paragraphs,
  // then the concatenated document is sanitized as a whole before it reaches
  // either the editor DOM or persisted state.
  const handleInsertContent = useCallback(
    (content: string) => {
      if (!activeNote || !editorRef.current) return;

      const htmlContent = textToHtml(content);
      const newContent = sanitizeHtml(activeNote.content + htmlContent);
      updateNote(activeNote.id, { content: newContent });
      editorRef.current.innerHTML = newContent;
    },
    [activeNote, updateNote, editorRef]
  );

  // Auto-select first note if none selected
  useEffect(() => {
    if (!state.activeNoteId && filteredNotes.length > 0) {
      setActiveNote(filteredNotes[0].id);
    }
  }, [state.activeNoteId, filteredNotes, setActiveNote]);

  // Memoized current folder info
  const currentFolder = useMemo(
    () => state.folders.find((f) => f.id === state.activeFolder),
    [state.folders, state.activeFolder]
  );

  // Check if mobile
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

  return (
    <div className="h-screen h-[100dvh] flex overflow-hidden bg-gray-50 dark:bg-surface-dark font-sans">
      {/* Mobile Menu Overlay */}
      {state.showMobileMenu && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden animate-fadeIn"
          onClick={closeMobileOverlays}
        />
      )}

      {/* Sidebar - Desktop: always visible, Mobile: slide-in */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 md:relative md:z-auto transition-transform duration-300',
          state.showMobileMenu ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        <Sidebar
          folders={state.folders}
          activeFolder={state.activeFolder}
          collapsed={state.sidebarCollapsed && !isMobile}
          noteCounts={folderNoteCounts}
          searchQuery={state.searchQuery}
          isMobile={state.showMobileMenu}
          auth={auth}
          sync={sync}
          onFolderSelect={setActiveFolder}
          onToggleCollapse={toggleSidebar}
          onNewNote={createNote}
          onSearchChange={setSearchQuery}
          onClose={closeMobileOverlays}
        />
      </div>

      {/* Note List Panel - Desktop: sidebar, Mobile: slide-up */}
      {!state.sidebarCollapsed && (
        <div
          className={cn(
            'hidden md:flex w-72 bg-sidebar border-r border-white/5 flex-col shrink-0'
          )}
        >
          {/* List Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              {currentFolder?.icon}
              {currentFolder?.name}
              <span className="text-xs text-text-secondary-dark font-normal">
                ({filteredNotes.length})
              </span>
            </h2>
            <div className="flex items-center gap-1">
              <select
                value={state.sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="bg-sidebar-hover text-text-secondary-dark text-xs rounded px-2 py-1 border-none outline-none cursor-pointer"
              >
                <option value="updatedAt">Modified</option>
                <option value="createdAt">Created</option>
                <option value="title">Title</option>
              </select>
              <button
                onClick={() => setSortOrder(state.sortOrder === 'asc' ? 'desc' : 'asc')}
                className="p-1.5 text-text-secondary-dark hover:text-white transition-colors rounded-lg hover:bg-white/5"
                title={state.sortOrder === 'asc' ? 'Ascending' : 'Descending'}
              >
                <Icons.Sort
                  className={cn('w-3.5 h-3.5 transition-transform', state.sortOrder === 'asc' && 'rotate-180')}
                />
              </button>
            </div>
          </div>

          {/* Empty trash button */}
          {state.activeFolder === 'trash' && filteredNotes.length > 0 && (
            <div className="px-3 py-2 border-b border-white/5">
              <button
                onClick={emptyTrash}
                className="w-full text-xs text-red-400 hover:text-red-300 hover:bg-white/5 py-2 rounded-lg transition-colors"
              >
                🗑️ Empty Trash
              </button>
            </div>
          )}

          {/* Note List */}
          <NoteList
            notes={filteredNotes}
            activeNoteId={state.activeNoteId}
            activeFolder={state.activeFolder}
            onSelectNote={setActiveNote}
            onDeleteNote={deleteNote}
            onTogglePin={togglePin}
            onRestoreNote={restoreNote}
            onArchiveNote={archiveNote}
            onReorderNotes={reorderNotes}
          />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-editor-dark">
        {/* Mobile Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-white/5 md:hidden">
          <button
            onClick={toggleMobileMenu}
            className="p-2 -ml-2 text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-white transition-colors rounded-lg"
          >
            <Icons.Menu className="w-5 h-5" />
          </button>
          <h1 className="font-semibold text-text-primary dark:text-white truncate max-w-[200px]">
            {activeNote?.title || 'NoteFlow'}
          </h1>
          <div className="flex items-center gap-1">
            <button
              onClick={toggleMobileNoteList}
              className="p-2 text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-white transition-colors rounded-lg"
            >
              <Icons.Notes className="w-5 h-5" />
            </button>
            <button
              onClick={() => setShowAIPanel(true)}
              className="p-2 text-accent hover:bg-accent/10 transition-colors rounded-lg"
            >
              <Icons.Sparkles className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Mobile Note List Drawer */}
        {state.showMobileNoteList && (
          <>
            <div
              className="fixed inset-0 bg-black/50 z-40 md:hidden animate-fadeIn"
              onClick={closeMobileOverlays}
            />
            <div className="fixed inset-x-0 bottom-0 z-50 bg-sidebar rounded-t-2xl max-h-[70vh] flex flex-col md:hidden animate-slideUp safe-area-inset-bottom">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <h2 className="text-sm font-semibold text-white">
                  {currentFolder?.icon} {currentFolder?.name}
                </h2>
                <button
                  onClick={closeMobileOverlays}
                  className="p-2 text-text-secondary-dark hover:text-white transition-colors"
                >
                  <Icons.Close className="w-5 h-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <NoteList
                  notes={filteredNotes}
                  activeNoteId={state.activeNoteId}
                  activeFolder={state.activeFolder}
                  onSelectNote={setActiveNote}
                  onDeleteNote={deleteNote}
                  onTogglePin={togglePin}
                  onRestoreNote={restoreNote}
                  onArchiveNote={archiveNote}
                  onReorderNotes={reorderNotes}
                />
              </div>
              <div className="p-3 border-t border-white/5">
                <button
                  onClick={() => {
                    createNote();
                    closeMobileOverlays();
                  }}
                  className="w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent-dark text-white rounded-xl py-3 font-medium text-sm transition-colors"
                >
                  <Icons.Plus className="w-4 h-4" />
                  New Note
                </button>
              </div>
            </div>
          </>
        )}

        {activeNote ? (
          <>
            {/* Toolbar - Hidden in focus mode */}
            {state.viewMode !== 'focus' && (
              <Toolbar
                viewMode={state.viewMode}
                showRightPanel={state.showRightPanel}
                showAIPanel={showAIPanel}
                isDark={state.theme === 'dark'}
                onFormat={handleFormat}
                onViewModeChange={setViewMode}
                onToggleRightPanel={toggleRightPanel}
                onExport={(format) => exportNote(activeNote.id, format)}
                onDuplicate={() => duplicateNote(activeNote.id)}
                onToggleTheme={toggleTheme}
                onToggleAI={() => setShowAIPanel((prev) => !prev)}
              />
            )}

            {/* Focus mode toolbar */}
            {state.viewMode === 'focus' && (
              <div className="flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-editor-dark border-b border-border dark:border-white/5 no-print">
                <button
                  onClick={() => setViewMode('editor')}
                  className="text-xs text-text-secondary dark:text-text-secondary-dark hover:text-accent px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                >
                  ← Back to Editor
                </button>
                <button
                  onClick={() => setShowAIPanel((prev) => !prev)}
                  className="text-xs text-text-secondary dark:text-text-secondary-dark hover:text-accent px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5"
                >
                  <Icons.Sparkles className="w-3.5 h-3.5" />
                  AI
                </button>
                <button
                  onClick={toggleTheme}
                  className="text-xs text-text-secondary dark:text-text-secondary-dark hover:text-accent px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 transition-colors"
                >
                  {state.theme === 'dark' ? '☀️' : '🌙'}
                </button>
              </div>
            )}

            {/* Editor */}
            <NoteEditor
              note={activeNote}
              viewMode={state.viewMode}
              editorRef={editorRef}
              onUpdate={updateNote}
              onFormat={handleFormat}
            />

            {/* Status Bar */}
            <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-sidebar border-t border-border dark:border-white/5 text-xs text-text-secondary dark:text-text-secondary-dark no-print">
              <div className="flex items-center gap-3 sm:gap-4">
                <span>{activeNote.wordCount} words</span>
                <span className="hidden sm:inline">{activeNote.charCount} chars</span>
                <span className="hidden sm:inline">{estimateReadTime(activeNote.wordCount)} read</span>
              </div>
              <div className="flex items-center gap-3 sm:gap-4">
                {/* AI Shortcut hint - desktop only */}
                <span className="hidden md:flex items-center gap-1 text-accent/60">
                  <kbd className="px-1.5 py-0.5 bg-accent/10 rounded text-[10px] font-mono">Ctrl+J</kbd>
                  <span>AI</span>
                </span>
                {/* Save status */}
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      state.saveStatus === 'saved'
                        ? 'bg-success'
                        : state.saveStatus === 'saving'
                        ? 'bg-warning animate-pulse'
                        : 'bg-danger'
                    )}
                  />
                  <span className="hidden sm:inline">
                    {state.saveStatus === 'saved' ? 'Saved' : state.saveStatus === 'saving' ? 'Saving...' : 'Unsaved'}
                  </span>
                </span>
              </div>
            </div>
          </>
        ) : (
          /* Empty State */
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 flex items-center justify-center mb-6">
              <span className="text-4xl sm:text-5xl">✍️</span>
            </div>
            <h2 className="text-lg sm:text-xl font-semibold text-text-primary dark:text-white mb-2">
              Select or Create a Note
            </h2>
            <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-sm mb-6">
              Choose a note from the sidebar or create a new one to start writing.
            </p>
            <button
              onClick={createNote}
              className="flex items-center gap-2 bg-accent hover:bg-accent-dark text-white px-6 py-3 rounded-xl font-medium transition-all shadow-lg shadow-accent/25 hover:shadow-accent/40 active:scale-[0.98]"
            >
              <Icons.Plus className="w-5 h-5" />
              Create New Note
            </button>
            <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 text-xs text-text-secondary dark:text-text-secondary-dark">
              {[
                { key: 'Ctrl+N', label: 'New Note' },
                { key: 'Ctrl+J', label: 'AI Assistant' },
                { key: 'Ctrl+B', label: 'Bold' },
                { key: 'Ctrl+I', label: 'Italic' },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center gap-2">
                  <kbd className="px-2 py-1 bg-gray-100 dark:bg-white/5 rounded border border-border dark:border-white/10 font-mono text-[11px]">
                    {key}
                  </kbd>
                  <span>{label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right Panel - Desktop only */}
      {state.showRightPanel && activeNote && (
        <div className="hidden md:block">
          <RightPanel
            note={activeNote}
            folders={state.folders}
            allTags={allTags}
            onUpdate={updateNote}
            onClose={toggleRightPanel}
          />
        </div>
      )}

      {/* AI Panel */}
      <AIPanel
        isOpen={showAIPanel}
        memory={ai.memory}
        isLoading={ai.isLoading}
        error={ai.error}
        streamingResponse={ai.streamingResponse}
        noteContent={activeNote ? stripHtml(activeNote.content) : undefined}
        noteTitle={activeNote?.title}
        noteExcludedFromAi={activeNote?.excludeFromAi === true}
        onToggleExcludeFromAi={
          activeNote
            ? (value) => updateNote(activeNote.id, { excludeFromAi: value })
            : undefined
        }
        onClose={() => setShowAIPanel(false)}
        onChat={ai.chat}
        onQuickAction={ai.quickAction}
        onGenerateContent={ai.generateContent}
        onStopGeneration={ai.stopGeneration}
        onClearHistory={ai.clearHistory}
        onSetPreference={ai.setUserPreference}
        onInsertContent={handleInsertContent}
      />

      {/* Mobile AI FAB */}
      {!showAIPanel && (
        <button
          onClick={() => setShowAIPanel(true)}
          className={cn(
            'fixed bottom-6 right-6 w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 text-white shadow-xl flex items-center justify-center transition-all md:hidden safe-area-inset-bottom',
            ai.isLoading && 'animate-pulse-glow'
          )}
          style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <Icons.Sparkles className="w-6 h-6" />
        </button>
      )}
    </div>
  );
}

export default App;
