// ============================================================================
// Types & Interfaces
// ============================================================================

export interface Note {
  id: string;
  title: string;
  content: string;
  folderId: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  trashed: boolean;
  createdAt: number;
  updatedAt: number;
  wordCount: number;
  charCount: number;
}

export interface Folder {
  id: string;
  name: string;
  icon: string;
  color: string;
  parent?: string;
}

export type ViewMode = 'editor' | 'focus' | 'preview';
export type Theme = 'light' | 'dark';
export type SortBy = 'updatedAt' | 'createdAt' | 'title';
export type SortOrder = 'asc' | 'desc';
export type SaveStatus = 'saved' | 'saving' | 'unsaved';
export type ExportFormat = 'text' | 'html' | 'markdown';

export interface AppState {
  notes: Note[];
  folders: Folder[];
  activeNoteId: string | null;
  activeFolder: string;
  searchQuery: string;
  viewMode: ViewMode;
  theme: Theme;
  showRightPanel: boolean;
  sidebarCollapsed: boolean;
  sortBy: SortBy;
  sortOrder: SortOrder;
  saveStatus: SaveStatus;
  // Mobile state
  showMobileMenu: boolean;
  showMobileNoteList: boolean;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_FOLDERS: Folder[] = [
  { id: 'all', name: 'All Notes', icon: '📋', color: '#7c3aed' },
  { id: 'favorites', name: 'Favorites', icon: '⭐', color: '#f59e0b' },
  { id: 'personal', name: 'Personal', icon: '🏠', color: '#10b981' },
  { id: 'work', name: 'Work', icon: '💼', color: '#3b82f6' },
  { id: 'ideas', name: 'Ideas', icon: '💡', color: '#f97316' },
  { id: 'archive', name: 'Archive', icon: '📦', color: '#64748b' },
  { id: 'trash', name: 'Trash', icon: '🗑️', color: '#ef4444' },
];

export const STORAGE_KEY = 'noteflow-data';
export const AI_MEMORY_KEY = 'noteflow-ai-memory';

export const KEYBOARD_SHORTCUTS = {
  newNote: { key: 'n', ctrl: true, description: 'New Note' },
  openAI: { key: 'j', ctrl: true, description: 'AI Assistant' },
  save: { key: 's', ctrl: true, description: 'Save' },
  search: { key: 'f', ctrl: true, description: 'Search' },
  bold: { key: 'b', ctrl: true, description: 'Bold' },
  italic: { key: 'i', ctrl: true, description: 'Italic' },
  underline: { key: 'u', ctrl: true, description: 'Underline' },
} as const;

// ============================================================================
// AI Types
// ============================================================================

export interface AIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface AIMemory {
  userPreferences: {
    writingStyle?: string;
    topics?: string[];
    language?: string;
  };
  conversationHistory: AIMessage[];
  noteContext: {
    recentNotes: string[];
    commonTags: string[];
    writingPatterns?: string;
  };
}

export type AIQuickAction = 
  | 'summarize' 
  | 'improve' 
  | 'expand' 
  | 'simplify' 
  | 'translate' 
  | 'fix' 
  | 'tone' 
  | 'bullets' 
  | 'headlines' 
  | 'questions';

export type AIGenerateType = 'outline' | 'draft' | 'ideas' | 'continue';
