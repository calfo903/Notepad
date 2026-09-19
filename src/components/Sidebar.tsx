import { memo, useCallback } from 'react';
import { Folder } from '../types';
import { cn } from '../utils/helpers';
import { Icons } from './icons';
import { AccountPanel } from './AccountPanel';
import type { AuthStore } from '../hooks/useAuth';
import type { SyncStore } from '../hooks/useSync';

interface SidebarProps {
  folders: Folder[];
  activeFolder: string;
  collapsed: boolean;
  noteCounts: Record<string, number>;
  searchQuery: string;
  isMobile?: boolean;
  auth: AuthStore;
  sync?: SyncStore;
  onFolderSelect: (folderId: string) => void;
  onToggleCollapse: () => void;
  onNewNote: () => void;
  onSearchChange: (query: string) => void;
  onClose?: () => void;
}

export const Sidebar = memo(function Sidebar({
  folders,
  activeFolder,
  collapsed,
  noteCounts,
  searchQuery,
  isMobile = false,
  auth,
  sync,
  onFolderSelect,
  onToggleCollapse,
  onNewNote,
  onSearchChange,
  onClose,
}: SidebarProps) {
  const handleNewNote = useCallback(() => {
    onNewNote();
    onClose?.();
  }, [onNewNote, onClose]);

  const handleFolderSelect = useCallback(
    (folderId: string) => {
      onFolderSelect(folderId);
      if (isMobile) onClose?.();
    },
    [onFolderSelect, isMobile, onClose]
  );

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-sidebar transition-all duration-300',
        collapsed && !isMobile ? 'w-16' : 'w-72',
        isMobile && 'w-full max-w-[280px]'
      )}
    >
      {/* Header */}
      <header
        className={cn(
          'flex items-center gap-3 px-4 py-4 border-b border-white/5',
          collapsed && !isMobile && 'justify-center'
        )}
      >
        {(!collapsed || isMobile) && (
          <>
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-purple-600 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-accent/30">
              N
            </div>
            <div className="flex-1">
              <h1 className="text-white font-semibold text-sm tracking-wide">NoteFlow</h1>
              <p className="text-text-secondary-dark text-xs">AI Notepad</p>
            </div>
          </>
        )}
        {collapsed && !isMobile && (
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent to-purple-600 flex items-center justify-center text-white font-bold text-sm">
            N
          </div>
        )}
        {isMobile ? (
          <button
            onClick={onClose}
            className="p-2 text-text-secondary-dark hover:text-white transition-colors rounded-lg hover:bg-sidebar-hover"
            aria-label="Close menu"
          >
            <Icons.Close className="w-5 h-5" />
          </button>
        ) : (
          <button
            onClick={onToggleCollapse}
            className={cn(
              'p-2 text-text-secondary-dark hover:text-white transition-colors rounded-lg hover:bg-sidebar-hover',
              collapsed ? '' : 'ml-auto'
            )}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <Icons.ChevronRight className="w-4 h-4" />
            ) : (
              <Icons.ChevronLeft className="w-4 h-4" />
            )}
          </button>
        )}
      </header>

      {/* New Note Button */}
      <div className={cn('px-3 py-3', collapsed && !isMobile && 'px-2')}>
        <button
          onClick={handleNewNote}
          className={cn(
            'w-full flex items-center justify-center gap-2 bg-accent hover:bg-accent-dark text-white rounded-xl py-3 transition-all duration-200 font-medium text-sm shadow-lg shadow-accent/25 hover:shadow-accent/40 active:scale-[0.98]',
            collapsed && !isMobile ? 'px-2' : 'px-4'
          )}
        >
          <Icons.Plus className="w-4 h-4" />
          {(!collapsed || isMobile) && <span>New Note</span>}
        </button>
      </div>

      {/* Search */}
      {(!collapsed || isMobile) && (
        <div className="px-3 pb-2">
          <div className="relative">
            <Icons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary-dark pointer-events-none" />
            <input
              type="text"
              placeholder="Search notes..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-full bg-sidebar-hover text-text-primary-dark text-sm rounded-xl pl-10 pr-4 py-2.5 border border-white/5 placeholder:text-text-secondary-dark focus:border-accent/50 focus:ring-2 focus:ring-accent/20 outline-none transition-all"
            />
          </div>
        </div>
      )}

      {/* Folders */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        {(!collapsed || isMobile) && (
          <p className="text-xs text-text-secondary-dark uppercase tracking-wider px-2 mb-2 font-medium">
            Folders
          </p>
        )}
        <ul className="space-y-1">
          {folders.map((folder) => {
            const isActive = activeFolder === folder.id;
            const count = noteCounts[folder.id] || 0;
            
            return (
              <li key={folder.id}>
                <button
                  onClick={() => handleFolderSelect(folder.id)}
                  className={cn(
                    'w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-150 group',
                    isActive
                      ? 'bg-sidebar-active text-white'
                      : 'text-text-secondary-dark hover:bg-sidebar-hover hover:text-white',
                    collapsed && !isMobile && 'justify-center px-2'
                  )}
                  title={collapsed && !isMobile ? folder.name : undefined}
                >
                  <span className="text-lg leading-none flex-shrink-0">{folder.icon}</span>
                  {(!collapsed || isMobile) && (
                    <>
                      <span className="flex-1 text-left truncate">{folder.name}</span>
                      {count > 0 && (
                        <span
                          className={cn(
                            'text-xs px-2 py-0.5 rounded-full transition-colors',
                            isActive
                              ? 'bg-white/15 text-white'
                              : 'bg-white/5 text-text-secondary-dark group-hover:bg-white/10'
                          )}
                        >
                          {count}
                        </span>
                      )}
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      {(!collapsed || isMobile) && (
        <footer className="px-4 py-3 border-t border-white/5">
          <div className="flex items-center gap-2 text-xs text-text-secondary-dark">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span>Auto-save enabled</span>
          </div>
          <p className="text-xs text-text-secondary-dark/50 mt-1.5 hidden sm:block">
            Ctrl+N: New • Ctrl+J: AI
          </p>
          <div className="mt-3 pt-3 border-t border-white/5">
            <AccountPanel auth={auth} sync={sync} />
          </div>
        </footer>
      )}
    </aside>
  );
});
