import { memo, useCallback, useMemo } from 'react';
import { Note } from '../types';
import { cn, truncateContent, formatRelativeDate } from '../utils/helpers';
import { Icons } from './icons';

interface NoteListProps {
  notes: Note[];
  activeNoteId: string | null;
  activeFolder: string;
  onSelectNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRestoreNote?: (id: string) => void;
  onArchiveNote?: (id: string) => void;
}

interface NoteItemProps {
  note: Note;
  isActive: boolean;
  activeFolder: string;
  onSelect: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onRestore?: () => void;
  onArchive?: () => void;
}

const NoteItem = memo(function NoteItem({
  note,
  isActive,
  activeFolder,
  onSelect,
  onDelete,
  onTogglePin,
  onRestore,
  onArchive,
}: NoteItemProps) {
  const preview = useMemo(() => truncateContent(note.content, 100), [note.content]);
  const dateStr = useMemo(() => formatRelativeDate(note.updatedAt), [note.updatedAt]);
  
  const isTrash = activeFolder === 'trash';
  const isArchive = activeFolder === 'archive';
  const showActions = !isTrash && !isArchive;

  return (
    <li className="group">
      <button
        onClick={onSelect}
        className={cn(
          'w-full text-left px-4 py-3.5 transition-all duration-150 hover:bg-sidebar-hover border-l-2',
          isActive
            ? 'bg-sidebar-active border-accent'
            : 'border-transparent'
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            {/* Title */}
            <div className="flex items-center gap-2">
              {note.pinned && (
                <span className="text-yellow-400 text-xs flex-shrink-0">⭐</span>
              )}
              <h3
                className={cn(
                  'text-sm font-medium truncate',
                  isActive ? 'text-white' : 'text-text-primary-dark'
                )}
              >
                {note.title || 'Untitled Note'}
              </h3>
            </div>
            
            {/* Preview */}
            {preview && (
              <p className="text-xs text-text-secondary-dark mt-1 line-clamp-2 leading-relaxed">
                {preview}
              </p>
            )}
            
            {/* Meta */}
            <div className="flex items-center gap-3 mt-2">
              <span className="text-xs text-text-secondary-dark/60">
                {dateStr}
              </span>
              <span className="text-xs text-text-secondary-dark/40">
                {note.wordCount} words
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            {isTrash && onRestore && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore();
                }}
                className="p-1.5 rounded-lg hover:bg-white/10 text-text-secondary-dark hover:text-green-400 transition-colors"
                title="Restore"
              >
                <Icons.Restore className="w-3.5 h-3.5" />
              </button>
            )}
            
            {showActions && onArchive && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
                className="p-1.5 rounded-lg hover:bg-white/10 text-text-secondary-dark hover:text-blue-400 transition-colors"
                title="Archive"
              >
                <Icons.Archive className="w-3.5 h-3.5" />
              </button>
            )}
            
            {showActions && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin();
                }}
                className="p-1.5 rounded-lg hover:bg-white/10 text-text-secondary-dark hover:text-yellow-400 transition-colors"
                title={note.pinned ? 'Unpin' : 'Pin'}
              >
                <Icons.Pin className="w-3.5 h-3.5" filled={note.pinned} />
              </button>
            )}
            
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="p-1.5 rounded-lg hover:bg-white/10 text-text-secondary-dark hover:text-red-400 transition-colors"
              title={isTrash ? 'Delete permanently' : 'Move to trash'}
            >
              <Icons.Trash className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </button>
    </li>
  );
});

export const NoteList = memo(function NoteList({
  notes,
  activeNoteId,
  activeFolder,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  onRestoreNote,
  onArchiveNote,
}: NoteListProps) {
  const handleSelect = useCallback(
    (id: string) => () => onSelectNote(id),
    [onSelectNote]
  );
  
  const handleDelete = useCallback(
    (id: string) => () => onDeleteNote(id),
    [onDeleteNote]
  );
  
  const handleTogglePin = useCallback(
    (id: string) => () => onTogglePin(id),
    [onTogglePin]
  );
  
  const handleRestore = useCallback(
    (id: string) => () => onRestoreNote?.(id),
    [onRestoreNote]
  );
  
  const handleArchive = useCallback(
    (id: string) => () => onArchiveNote?.(id),
    [onArchiveNote]
  );

  if (notes.length === 0) {
    const emptyStates = {
      trash: { icon: '🗑️', title: 'Trash is empty', subtitle: 'Deleted notes will appear here' },
      archive: { icon: '📦', title: 'No archived notes', subtitle: 'Archive notes to store them long-term' },
      default: { icon: '📝', title: 'No notes found', subtitle: 'Click "New Note" to get started' },
    };
    
    const { icon, title, subtitle } = emptyStates[activeFolder as keyof typeof emptyStates] || emptyStates.default;

    return (
      <div className="flex flex-col items-center justify-center h-full px-6 text-center py-12">
        <div className="text-5xl mb-4 opacity-30">{icon}</div>
        <p className="text-text-secondary-dark text-sm font-medium">{title}</p>
        <p className="text-text-secondary-dark/50 text-xs mt-1">{subtitle}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin">
      <ul className="divide-y divide-white/5">
        {notes.map((note) => (
          <NoteItem
            key={note.id}
            note={note}
            isActive={note.id === activeNoteId}
            activeFolder={activeFolder}
            onSelect={handleSelect(note.id)}
            onDelete={handleDelete(note.id)}
            onTogglePin={handleTogglePin(note.id)}
            onRestore={onRestoreNote ? handleRestore(note.id) : undefined}
            onArchive={onArchiveNote ? handleArchive(note.id) : undefined}
          />
        ))}
      </ul>
    </div>
  );
});
