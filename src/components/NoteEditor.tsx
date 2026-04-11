import { memo, useRef, useEffect, useCallback } from 'react';
import { Note, ViewMode } from '../types';
import { cn } from '../utils/helpers';

interface NoteEditorProps {
  note: Note;
  viewMode: ViewMode;
  editorRef: React.MutableRefObject<HTMLDivElement | null>;
  onUpdate: (id: string, updates: Partial<Note>) => void;
  onFormat: (command: string, value?: string) => void;
}

export const NoteEditor = memo(function NoteEditor({
  note,
  viewMode,
  editorRef,
  onUpdate,
  onFormat,
}: NoteEditorProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const lastContentRef = useRef<string>(note.content);

  // Sync contentEditable with note content (only when note changes)
  useEffect(() => {
    if (editorRef.current && note.content !== lastContentRef.current) {
      editorRef.current.innerHTML = note.content;
      lastContentRef.current = note.content;
    }
  }, [note.id, note.content, editorRef]);

  // Focus title on new empty note
  useEffect(() => {
    if (titleRef.current && !note.title && !note.content) {
      titleRef.current.focus();
    }
  }, [note.id, note.title, note.content]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const content = editorRef.current.innerHTML;
      lastContentRef.current = content;
      onUpdate(note.id, { content });
    }
  }, [note.id, editorRef, onUpdate]);

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(note.id, { title: e.target.value });
    },
    [note.id, onUpdate]
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Enter moves to editor
      if (e.key === 'Enter') {
        e.preventDefault();
        editorRef.current?.focus();
      }
    },
    [editorRef]
  );

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Tab inserts spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        onFormat('insertText', '  ');
      }
    },
    [onFormat]
  );

  const isFocus = viewMode === 'focus';
  const isPreview = viewMode === 'preview';

  return (
    <div
      className={cn(
        'flex-1 overflow-y-auto transition-all duration-300 scrollbar-thin',
        isFocus
          ? 'max-w-3xl mx-auto w-full px-6 md:px-16'
          : 'px-4 sm:px-6 md:px-10 lg:px-16'
      )}
    >
      <div className={cn('py-6 sm:py-8', isFocus && 'py-12 md:py-16')}>
        {/* Title */}
        <input
          ref={titleRef}
          type="text"
          value={note.title}
          onChange={handleTitleChange}
          onKeyDown={handleTitleKeyDown}
          placeholder="Untitled Note"
          readOnly={isPreview}
          className={cn(
            'w-full bg-transparent border-none outline-none font-semibold text-text-primary dark:text-white placeholder:text-text-secondary dark:placeholder:text-text-secondary-dark',
            isFocus ? 'text-3xl md:text-4xl mb-6 md:mb-8 text-center' : 'text-xl sm:text-2xl md:text-3xl mb-3 sm:mb-4'
          )}
        />

        {/* Meta info in focus mode */}
        {isFocus && (
          <div className="text-center text-sm text-text-secondary dark:text-text-secondary-dark mb-6 md:mb-8 flex items-center justify-center gap-4">
            <span>{note.wordCount} words</span>
            <span className="w-1 h-1 rounded-full bg-current opacity-40" />
            <span>{note.charCount} characters</span>
          </div>
        )}

        {/* Editor / Preview */}
        {isPreview ? (
          <div
            className="editor-content prose prose-lg dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{
              __html:
                note.content ||
                '<p class="text-text-secondary dark:text-text-secondary-dark italic">Nothing to preview</p>',
            }}
          />
        ) : (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleEditorKeyDown}
            data-placeholder="Start writing your thoughts..."
            className={cn(
              'editor-content text-text-primary dark:text-text-primary-dark outline-none',
              isFocus ? 'text-lg leading-loose' : 'text-base sm:text-lg leading-relaxed'
            )}
          />
        )}
      </div>
    </div>
  );
});
