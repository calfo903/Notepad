import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import CharacterCount from '@tiptap/extension-character-count';
import { memo, useEffect, useCallback, useRef } from 'react';
import { Note, ViewMode } from '../types';
import { cn, sanitizeHtml } from '../utils/helpers';

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
  const isPreview = viewMode === 'preview';
  const contentRef = useRef<string>(note.content);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3, 4, 5, 6],
        },
      }),
      Placeholder.configure({
        placeholder: 'Start writing your thoughts...',
      }),
      CharacterCount.configure({
        limit: 100000,
      }),
    ],
    content: note.content,
    editable: !isPreview,
    editorProps: {
      attributes: {
        class: cn(
          'editor-content text-text-primary dark:text-text-primary-dark outline-none min-h-[50vh] focus:outline-none prose prose-lg dark:prose-invert max-w-none',
          viewMode === 'focus' ? 'text-lg leading-loose' : 'text-base sm:text-lg leading-relaxed'
        ),
      },
    },
    onUpdate: ({ editor }) => {
      const content = editor.getHTML();
      // Prevent infinite loop by checking if content actually changed
      if (content !== contentRef.current) {
        contentRef.current = content;
        onUpdate(note.id, { content });
      }
    },
  });

  // Sync editor content when note changes (avoid cursor jump)
  useEffect(() => {
    if (editor && note.content !== contentRef.current) {
      const currentContent = editor.getHTML();
      // Only update if the content is meaningfully different
      if (note.content !== currentContent) {
        editor.commands.setContent(note.content, false);
        contentRef.current = note.content;
      }
    }
  }, [note.id, note.content, editor]);

  // Expose editor instance via editorRef for parent component access
  useEffect(() => {
    if (editorRef.current && editor) {
      (editorRef.current as any).__tiptapEditor = editor;
    }
  }, [editor, editorRef]);

  // Handle format commands from toolbar via custom events
  useEffect(() => {
    if (!editor) return;

    const handleFormatCommand = (event: CustomEvent) => {
      const { command, value } = event.detail;
      
      switch (command) {
        case 'bold':
          editor.chain().focus().toggleBold().run();
          break;
        case 'italic':
          editor.chain().focus().toggleItalic().run();
          break;
        case 'underline':
          editor.chain().focus().toggleUnderline?.().run();
          break;
        case 'strikeThrough':
        case 'strike':
          editor.chain().focus().toggleStrike().run();
          break;
        case 'formatBlock':
          if (value === '<h1>') editor.chain().focus().toggleHeading({ level: 1 }).run();
          else if (value === '<h2>') editor.chain().focus().toggleHeading({ level: 2 }).run();
          else if (value === '<h3>') editor.chain().focus().toggleHeading({ level: 3 }).run();
          else if (value === '<blockquote>') editor.chain().focus().toggleBlockquote().run();
          else if (value === '<pre>') editor.chain().focus().toggleCodeBlock().run();
          break;
        case 'insertUnorderedList':
          editor.chain().focus().toggleBulletList().run();
          break;
        case 'insertOrderedList':
          editor.chain().focus().toggleOrderedList().run();
          break;
        case 'blockquote':
          editor.chain().focus().toggleBlockquote().run();
          break;
        case 'code':
          editor.chain().focus().toggleCode().run();
          break;
        case 'codeBlock':
          editor.chain().focus().toggleCodeBlock().run();
          break;
        case 'undo':
          editor.chain().focus().undo().run();
          break;
        case 'redo':
          editor.chain().focus().redo().run();
          break;
        default:
          break;
      }
    };

    window.addEventListener('format-command', handleFormatCommand as EventListener);
    return () => window.removeEventListener('format-command', handleFormatCommand as EventListener);
  }, [editor]);

  // Handle AI content insertion
  useEffect(() => {
    if (!editor) return;

    const handleInsertContent = (event: CustomEvent) => {
      const { content } = event.detail;
      editor.chain().focus().insertContent(content).run();
    };

    window.addEventListener('insert-content', handleInsertContent as EventListener);
    return () => window.removeEventListener('insert-content', handleInsertContent as EventListener);
  }, [editor]);

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUpdate(note.id, { title: e.target.value });
    },
    [note.id, onUpdate]
  );

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        editor?.commands.focus();
      }
    },
    [editor]
  );

  const isFocus = viewMode === 'focus';

  // Get word and character counts from TipTap
  const wordCount = editor?.storage.characterCount.words() || note.wordCount;
  const charCount = editor?.storage.characterCount.characters() || note.charCount;

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
            <span>{wordCount} words</span>
            <span className="w-1 h-1 rounded-full bg-current opacity-40" />
            <span>{charCount} characters</span>
          </div>
        )}

        {/* TipTap Editor */}
        {!isPreview ? (
          <div ref={editorRef}>
            <EditorContent editor={editor} />
          </div>
        ) : (
          /* Preview Mode - render sanitized HTML */
          <div
            className={cn(
              'editor-content prose prose-lg dark:prose-invert max-w-none',
              isFocus ? 'text-lg leading-loose' : 'text-base sm:text-lg leading-relaxed'
            )}
            dangerouslySetInnerHTML={{
              __html: sanitizeHtml(note.content) || '<p class="text-text-secondary dark:text-text-secondary-dark italic">Nothing to preview</p>',
            }}
          />
        )}
      </div>
    </div>
  );
});
