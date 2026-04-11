import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { ViewMode, ExportFormat } from '../types';
import { cn } from '../utils/helpers';
import { Icons } from './icons';

interface ToolbarProps {
  viewMode: ViewMode;
  showRightPanel: boolean;
  showAIPanel: boolean;
  isDark: boolean;
  onFormat: (command: string, value?: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
  onToggleRightPanel: () => void;
  onExport: (format: ExportFormat) => void;
  onDuplicate: () => void;
  onToggleTheme: () => void;
  onToggleAI: () => void;
}

interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

const ToolbarButton = memo(function ToolbarButton({
  onClick,
  active = false,
  title,
  className,
  children,
}: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'p-2 rounded-lg transition-all duration-150 touch-manipulation',
        active
          ? 'bg-accent text-white shadow-md'
          : 'text-text-secondary hover:bg-gray-100 hover:text-text-primary dark:text-text-secondary-dark dark:hover:bg-white/5 dark:hover:text-white',
        className
      )}
      title={title}
    >
      {children}
    </button>
  );
});

const Divider = memo(function Divider() {
  return <div className="w-px h-6 bg-border dark:bg-white/10 mx-1 hidden sm:block" />;
});

export const Toolbar = memo(function Toolbar({
  viewMode,
  showRightPanel,
  showAIPanel,
  isDark,
  onFormat,
  onViewModeChange,
  onToggleRightPanel,
  onExport,
  onDuplicate,
  onToggleTheme,
  onToggleAI,
}: ToolbarProps) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Close menus on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  const handleFormat = useCallback(
    (command: string, value?: string) => () => {
      // Dispatch custom event for TipTap editor
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('format-command', { 
          detail: { command, value } 
        }));
      }
      // Fallback to document.execCommand for contentEditable
      onFormat(command, value);
    },
    [onFormat]
  );

  const handleExport = useCallback(
    (format: ExportFormat) => () => {
      onExport(format);
      setShowExportMenu(false);
    },
    [onExport]
  );

  const handleInsertLink = useCallback(() => {
    const url = prompt('Enter URL:');
    if (url) onFormat('createLink', url);
  }, [onFormat]);

  return (
    <div className="flex items-center gap-0.5 px-2 sm:px-4 py-2 bg-white dark:bg-editor-dark border-b border-border dark:border-white/5 flex-wrap no-print overflow-x-auto scrollbar-hide">
      {/* Undo/Redo - Always visible */}
      <ToolbarButton onClick={handleFormat('undo')} title="Undo (Ctrl+Z)">
        <Icons.Undo className="w-4 h-4" />
      </ToolbarButton>
      <ToolbarButton onClick={handleFormat('redo')} title="Redo (Ctrl+Y)">
        <Icons.Redo className="w-4 h-4" />
      </ToolbarButton>

      <Divider />

      {/* Headings - Hidden on small mobile */}
      <div className="hidden sm:flex items-center gap-0.5">
        <ToolbarButton onClick={handleFormat('formatBlock', '<h1>')} title="Heading 1">
          <span className="text-xs font-bold w-4 h-4 flex items-center justify-center">H1</span>
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('formatBlock', '<h2>')} title="Heading 2">
          <span className="text-xs font-bold w-4 h-4 flex items-center justify-center">H2</span>
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('formatBlock', '<h3>')} title="Heading 3">
          <span className="text-xs font-bold w-4 h-4 flex items-center justify-center">H3</span>
        </ToolbarButton>
        <Divider />
      </div>

      {/* Text formatting */}
      <ToolbarButton onClick={handleFormat('bold')} title="Bold (Ctrl+B)">
        <Icons.Bold className="w-4 h-4" />
      </ToolbarButton>
      <ToolbarButton onClick={handleFormat('italic')} title="Italic (Ctrl+I)">
        <Icons.Italic className="w-4 h-4" />
      </ToolbarButton>
      <ToolbarButton onClick={handleFormat('underline')} title="Underline (Ctrl+U)" className="hidden sm:flex">
        <Icons.Underline className="w-4 h-4" />
      </ToolbarButton>
      <ToolbarButton onClick={handleFormat('strikeThrough')} title="Strikethrough" className="hidden md:flex">
        <Icons.Strikethrough className="w-4 h-4" />
      </ToolbarButton>

      <Divider />

      {/* Lists - Hidden on mobile */}
      <div className="hidden sm:flex items-center gap-0.5">
        <ToolbarButton onClick={handleFormat('insertUnorderedList')} title="Bullet List">
          <Icons.List className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('insertOrderedList')} title="Numbered List">
          <Icons.ListOrdered className="w-4 h-4" />
        </ToolbarButton>
        <Divider />
      </div>

      {/* Block elements - Hidden on mobile */}
      <div className="hidden md:flex items-center gap-0.5">
        <ToolbarButton onClick={handleFormat('formatBlock', '<blockquote>')} title="Blockquote">
          <Icons.Quote className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('formatBlock', '<pre>')} title="Code Block">
          <Icons.Code className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton onClick={handleInsertLink} title="Insert Link">
          <Icons.Link className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('insertHorizontalRule')} title="Horizontal Rule">
          <Icons.HorizontalRule className="w-4 h-4" />
        </ToolbarButton>
        <ToolbarButton onClick={handleFormat('removeFormat')} title="Clear Formatting">
          <Icons.ClearFormat className="w-4 h-4" />
        </ToolbarButton>
        <Divider />
      </div>

      {/* More menu for mobile */}
      <div className="relative md:hidden" ref={moreRef}>
        <ToolbarButton
          onClick={() => setShowMoreMenu(!showMoreMenu)}
          title="More formatting"
        >
          <Icons.MoreVertical className="w-4 h-4" />
        </ToolbarButton>
        {showMoreMenu && (
          <div className="absolute top-full left-0 mt-1 bg-white dark:bg-editor-dark border border-border dark:border-white/10 rounded-xl shadow-xl z-50 py-1 min-w-[160px] animate-scaleIn">
            <button
              onClick={() => {
                onFormat('formatBlock', '<h1>');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <span className="font-bold">H1</span>
              <span className="text-text-secondary dark:text-text-secondary-dark">Heading 1</span>
            </button>
            <button
              onClick={() => {
                onFormat('formatBlock', '<h2>');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <span className="font-bold">H2</span>
              <span className="text-text-secondary dark:text-text-secondary-dark">Heading 2</span>
            </button>
            <div className="border-t border-border dark:border-white/10 my-1" />
            <button
              onClick={() => {
                onFormat('insertUnorderedList');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <Icons.List className="w-4 h-4" />
              <span>Bullet List</span>
            </button>
            <button
              onClick={() => {
                onFormat('insertOrderedList');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <Icons.ListOrdered className="w-4 h-4" />
              <span>Numbered List</span>
            </button>
            <button
              onClick={() => {
                onFormat('formatBlock', '<blockquote>');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <Icons.Quote className="w-4 h-4" />
              <span>Quote</span>
            </button>
            <button
              onClick={() => {
                onFormat('formatBlock', '<pre>');
                setShowMoreMenu(false);
              }}
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5 flex items-center gap-3"
            >
              <Icons.Code className="w-4 h-4" />
              <span>Code Block</span>
            </button>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1 min-w-4" />

      {/* Right side controls */}
      <div className="flex items-center gap-1">
        {/* View modes - Simplified on mobile */}
        <div className="hidden sm:flex items-center bg-gray-100 dark:bg-white/5 rounded-lg p-0.5">
          {(['editor', 'focus', 'preview'] as ViewMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => onViewModeChange(mode)}
              className={cn(
                'px-2.5 py-1.5 rounded-md text-xs font-medium transition-all capitalize',
                viewMode === mode
                  ? 'bg-white dark:bg-white/10 text-accent shadow-sm'
                  : 'text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-white'
              )}
              title={`${mode} Mode`}
            >
              {mode}
            </button>
          ))}
        </div>

        {/* AI Button */}
        <ToolbarButton
          onClick={onToggleAI}
          active={showAIPanel}
          title="AI Assistant (Ctrl+J)"
          className="hidden sm:flex"
        >
          <Icons.Sparkles className="w-4 h-4" />
        </ToolbarButton>

        {/* Export */}
        <div className="relative hidden sm:block" ref={exportRef}>
          <ToolbarButton
            onClick={() => setShowExportMenu(!showExportMenu)}
            title="Export"
          >
            <Icons.Export className="w-4 h-4" />
          </ToolbarButton>
          {showExportMenu && (
            <div className="absolute top-full right-0 mt-1 bg-white dark:bg-editor-dark border border-border dark:border-white/10 rounded-xl shadow-xl z-50 py-1 min-w-[140px] animate-scaleIn">
              <button
                onClick={handleExport('text')}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              >
                📄 Plain Text
              </button>
              <button
                onClick={handleExport('html')}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              >
                🌐 HTML
              </button>
              <button
                onClick={handleExport('markdown')}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              >
                📝 Markdown
              </button>
              <div className="border-t border-border dark:border-white/10 my-1" />
              <button
                onClick={() => {
                  onDuplicate();
                  setShowExportMenu(false);
                }}
                className="w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-white/5"
              >
                📋 Duplicate
              </button>
            </div>
          )}
        </div>

        {/* Info panel toggle */}
        <ToolbarButton
          onClick={onToggleRightPanel}
          active={showRightPanel}
          title="Note Info"
          className="hidden sm:flex"
        >
          <Icons.Info className="w-4 h-4" />
        </ToolbarButton>

        {/* Theme toggle */}
        <ToolbarButton onClick={onToggleTheme} title={isDark ? 'Light mode' : 'Dark mode'}>
          {isDark ? <Icons.Sun className="w-4 h-4" /> : <Icons.Moon className="w-4 h-4" />}
        </ToolbarButton>
      </div>
    </div>
  );
});
