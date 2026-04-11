import { memo, useCallback, useState } from 'react';
import { Note, Folder } from '../types';
import { cn, formatFullDate } from '../utils/helpers';
import { Icons } from './icons';

interface RightPanelProps {
  note: Note;
  folders: Folder[];
  onUpdate: (id: string, updates: Partial<Note>) => void;
  onClose: () => void;
}

export const RightPanel = memo(function RightPanel({
  note,
  folders,
  onUpdate,
  onClose,
}: RightPanelProps) {
  const [tagInput, setTagInput] = useState('');

  const writableFolders = folders.filter(
    (f) => !['all', 'favorites', 'trash', 'archive'].includes(f.id)
  );

  const addTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !note.tags.includes(tag)) {
      onUpdate(note.id, { tags: [...note.tags, tag] });
      setTagInput('');
    }
  }, [tagInput, note.id, note.tags, onUpdate]);

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addTag();
      }
    },
    [addTag]
  );

  const removeTag = useCallback(
    (tagToRemove: string) => {
      onUpdate(note.id, { tags: note.tags.filter((t) => t !== tagToRemove) });
    },
    [note.id, note.tags, onUpdate]
  );

  const handleFolderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      onUpdate(note.id, { folderId: e.target.value });
    },
    [note.id, onUpdate]
  );

  // Calculate paragraph count
  const paragraphCount = note.content
    ? note.content
        .split(/<\/?p[^>]*>/gi)
        .filter((s) => s.trim().length > 0).length
    : 0;

  return (
    <aside className="w-72 bg-white dark:bg-editor-dark border-l border-border dark:border-white/5 flex flex-col overflow-hidden animate-slideInRight">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-white/5 flex-shrink-0">
        <h3 className="text-sm font-semibold text-text-primary dark:text-white">
          Note Info
        </h3>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/5 text-text-secondary dark:text-text-secondary-dark transition-colors"
          aria-label="Close panel"
        >
          <Icons.Close className="w-4 h-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5 scrollbar-thin">
        {/* Folder */}
        <section>
          <label className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-2 block">
            Folder
          </label>
          <select
            value={note.folderId}
            onChange={handleFolderChange}
            className="w-full bg-gray-50 dark:bg-white/5 border border-border dark:border-white/10 rounded-xl px-3 py-2.5 text-sm text-text-primary dark:text-text-primary-dark outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition-all cursor-pointer"
          >
            {writableFolders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.icon} {f.name}
              </option>
            ))}
          </select>
        </section>

        {/* Tags */}
        <section>
          <label className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-2 block">
            Tags
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {note.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-accent/10 text-accent dark:text-accent-light rounded-full text-xs font-medium group"
              >
                #{tag}
                <button
                  onClick={() => removeTag(tag)}
                  className="hover:text-accent-dark dark:hover:text-white transition-colors opacity-60 hover:opacity-100"
                  aria-label={`Remove tag ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder="Add tag..."
              className="flex-1 bg-gray-50 dark:bg-white/5 border border-border dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent transition-colors"
            />
            <button
              onClick={addTag}
              disabled={!tagInput.trim()}
              className="px-3 py-2 bg-accent/10 text-accent rounded-lg text-sm font-medium hover:bg-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </section>

        {/* Statistics */}
        <section>
          <label className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-2 block">
            Statistics
          </label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Words', value: note.wordCount },
              { label: 'Characters', value: note.charCount },
              { label: 'Min Read', value: Math.ceil(note.wordCount / 200) || '< 1' },
              { label: 'Paragraphs', value: paragraphCount },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-gray-50 dark:bg-white/5 rounded-xl p-3 text-center"
              >
                <p className="text-lg font-bold text-text-primary dark:text-white">
                  {value}
                </p>
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                  {label}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Dates */}
        <section>
          <label className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-2 block">
            Details
          </label>
          <div className="space-y-3 text-sm">
            <div>
              <span className="text-text-secondary dark:text-text-secondary-dark block text-xs mb-0.5">
                Created
              </span>
              <span className="text-text-primary dark:text-text-primary-dark text-xs">
                {formatFullDate(note.createdAt)}
              </span>
            </div>
            <div>
              <span className="text-text-secondary dark:text-text-secondary-dark block text-xs mb-0.5">
                Last Modified
              </span>
              <span className="text-text-primary dark:text-text-primary-dark text-xs">
                {formatFullDate(note.updatedAt)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-text-secondary dark:text-text-secondary-dark text-xs">
                Status
              </span>
              <span
                className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full',
                  note.pinned
                    ? 'bg-yellow-100 dark:bg-yellow-400/20 text-yellow-700 dark:text-yellow-400'
                    : 'bg-green-100 dark:bg-green-400/20 text-green-700 dark:text-green-400'
                )}
              >
                {note.pinned ? '⭐ Pinned' : '📝 Active'}
              </span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
});
