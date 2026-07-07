import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { AIMessage, AIMemory, AIQuickAction, AIGenerateType } from '../types';
import { cn } from '../utils/helpers';
import { Icons } from './icons';

interface AIPanelProps {
  isOpen: boolean;
  memory: AIMemory;
  isLoading: boolean;
  error: string | null;
  streamingResponse: string;
  noteContent?: string;
  noteTitle?: string;
  onClose: () => void;
  onChat: (message: string, options?: { noteContent?: string; noteTitle?: string; stream?: boolean }) => Promise<string>;
  onQuickAction: (action: AIQuickAction, content: string, extraParams?: { language?: string; tone?: string }) => Promise<string>;
  onGenerateContent: (type: AIGenerateType, topic: string, existingContent?: string) => Promise<string>;
  onStopGeneration: () => void;
  onClearHistory: () => void;
  onSetPreference: (key: 'writingStyle' | 'topics' | 'language', value: string | string[]) => void;
  onInsertContent?: (content: string) => void;
}

const QUICK_ACTIONS = [
  { id: 'summarize' as const, icon: '📝', label: 'Summarize', desc: 'Create a concise summary' },
  { id: 'improve' as const, icon: '✨', label: 'Improve', desc: 'Enhance writing quality' },
  { id: 'expand' as const, icon: '📖', label: 'Expand', desc: 'Add more details' },
  { id: 'simplify' as const, icon: '🎯', label: 'Simplify', desc: 'Make it easier to read' },
  { id: 'fix' as const, icon: '🔧', label: 'Fix Grammar', desc: 'Correct errors' },
  { id: 'bullets' as const, icon: '📋', label: 'To Bullets', desc: 'Convert to bullet list' },
  { id: 'headlines' as const, icon: '📰', label: 'Headlines', desc: 'Generate title ideas' },
  { id: 'questions' as const, icon: '❓', label: 'Questions', desc: 'Generate questions' },
];

const GENERATE_OPTIONS = [
  { id: 'outline' as const, icon: '🗂️', label: 'Generate Outline' },
  { id: 'draft' as const, icon: '📄', label: 'Write Draft' },
  { id: 'ideas' as const, icon: '💡', label: 'Brainstorm Ideas' },
  { id: 'continue' as const, icon: '➡️', label: 'Continue Writing' },
];

const LANGUAGES = ['Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Chinese', 'Japanese', 'Korean'];
const TONES = ['Professional', 'Casual', 'Friendly', 'Formal', 'Persuasive', 'Humorous', 'Academic'];

type TabType = 'chat' | 'actions' | 'memory';

export const AIPanel = memo(function AIPanel({
  isOpen,
  memory,
  isLoading,
  error,
  streamingResponse,
  noteContent,
  noteTitle,
  onClose,
  onChat,
  onQuickAction,
  onGenerateContent,
  onStopGeneration,
  onClearHistory,
  onSetPreference,
  onInsertContent,
}: AIPanelProps) {
  const [inputValue, setInputValue] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('chat');
  const [showLanguages, setShowLanguages] = useState(false);
  const [showTones, setShowTones] = useState(false);
  const [lastResponse, setLastResponse] = useState<string>('');
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [memory.conversationHistory, streamingResponse]);

  const handleSend = useCallback(async () => {
    if (!inputValue.trim() || isLoading) return;
    const message = inputValue;
    setInputValue('');
    const response = await onChat(message, { noteContent, noteTitle, stream: true });
    setLastResponse(response);
  }, [inputValue, isLoading, noteContent, noteTitle, onChat]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleQuickAction = useCallback(
    async (action: AIQuickAction) => {
      if (!noteContent?.trim()) {
        alert('Please add some content to your note first.');
        return;
      }
      const response = await onQuickAction(action, noteContent);
      setLastResponse(response);
    },
    [noteContent, onQuickAction]
  );

  const handleTranslate = useCallback(
    async (language: string) => {
      setShowLanguages(false);
      if (!noteContent?.trim()) {
        alert('Please add some content to your note first.');
        return;
      }
      const response = await onQuickAction('translate', noteContent, { language });
      setLastResponse(response);
    },
    [noteContent, onQuickAction]
  );

  const handleToneChange = useCallback(
    async (tone: string) => {
      setShowTones(false);
      if (!noteContent?.trim()) {
        alert('Please add some content to your note first.');
        return;
      }
      const response = await onQuickAction('tone', noteContent, { tone });
      setLastResponse(response);
    },
    [noteContent, onQuickAction]
  );

  const handleGenerate = useCallback(
    async (type: AIGenerateType) => {
      const topic = type === 'continue' ? noteContent : noteTitle || inputValue || 'general topic';
      if (!topic?.trim() && type !== 'continue') {
        alert('Please enter a topic or give your note a title.');
        return;
      }
      const response = await onGenerateContent(type, topic || '', noteContent);
      setLastResponse(response);
    },
    [inputValue, noteContent, noteTitle, onGenerateContent]
  );

  const handleInsert = useCallback(() => {
    if (lastResponse && onInsertContent) {
      onInsertContent(lastResponse);
    }
  }, [lastResponse, onInsertContent]);

  const formatMessage = useCallback((content: string) => {
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code class="bg-black/10 dark:bg-white/10 px-1 rounded text-sm">$1</code>')
      .replace(/\n/g, '<br/>');
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[340px] md:w-[380px] bg-white dark:bg-editor-dark border-l border-border dark:border-white/10 shadow-2xl z-50 flex flex-col animate-slideInRight safe-area-inset-bottom">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border dark:border-white/5 bg-gradient-to-r from-purple-500/10 to-blue-500/10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center shadow-lg">
            <span className="text-white text-lg">✨</span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary dark:text-white">
              NoteFlow AI
            </h3>
            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
              Powered by Puter
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 text-text-secondary dark:text-text-secondary-dark transition-colors"
          aria-label="Close AI panel"
        >
          <Icons.Close className="w-5 h-5" />
        </button>
      </header>

      {/* Tabs */}
      <div className="flex border-b border-border dark:border-white/5 flex-shrink-0">
        {(['chat', 'actions', 'memory'] as TabType[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 px-4 py-3 text-sm font-medium transition-colors',
              activeTab === tab
                ? 'text-accent border-b-2 border-accent bg-accent/5'
                : 'text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-white'
            )}
          >
            {tab === 'chat' && '💬 Chat'}
            {tab === 'actions' && '⚡ Actions'}
            {tab === 'memory' && '🧠 Memory'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {/* Chat Tab */}
        {activeTab === 'chat' && (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
              {memory.conversationHistory.length === 0 && !streamingResponse && (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">🤖</div>
                  <p className="text-sm text-text-secondary dark:text-text-secondary-dark font-medium">
                    How can I help you today?
                  </p>
                  <p className="text-xs text-text-secondary dark:text-text-secondary-dark/60 mt-1">
                    Ask me to write, improve, or translate your notes
                  </p>
                </div>
              )}

              {memory.conversationHistory.map((msg: AIMessage) => (
                <div
                  key={msg.id}
                  className={cn(
                    'flex',
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm',
                      msg.role === 'user'
                        ? 'bg-accent text-white rounded-br-md'
                        : 'bg-gray-100 dark:bg-white/5 text-text-primary dark:text-text-primary-dark rounded-bl-md'
                    )}
                    dangerouslySetInnerHTML={{ __html: formatMessage(msg.content) }}
                  />
                </div>
              ))}

              {streamingResponse && (
                <div className="flex justify-start">
                  <div
                    className="max-w-[85%] rounded-2xl rounded-bl-md px-4 py-2.5 text-sm bg-gray-100 dark:bg-white/5 text-text-primary dark:text-text-primary-dark"
                    dangerouslySetInnerHTML={{ __html: formatMessage(streamingResponse) }}
                  />
                </div>
              )}

              {isLoading && !streamingResponse && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md px-4 py-3 bg-gray-100 dark:bg-white/5">
                    <div className="flex gap-1.5">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="w-2 h-2 rounded-full bg-accent animate-bounce"
                          style={{ animationDelay: `${i * 0.15}s` }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-xl p-3 text-sm text-red-600 dark:text-red-400">
                  {error}
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {/* Insert button */}
            {lastResponse && !isLoading && (
              <div className="px-4 py-2 border-t border-border dark:border-white/5 flex-shrink-0">
                <button
                  onClick={handleInsert}
                  className="w-full py-2.5 bg-accent/10 hover:bg-accent/20 text-accent rounded-xl text-sm font-medium transition-colors flex items-center justify-center gap-2"
                >
                  <Icons.Plus className="w-4 h-4" />
                  Insert into Note
                </button>
              </div>
            )}

            {/* Input */}
            <div className="p-4 border-t border-border dark:border-white/5 flex-shrink-0">
              <div className="flex gap-2">
                <textarea
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask AI anything..."
                  rows={1}
                  className="flex-1 bg-gray-50 dark:bg-white/5 border border-border dark:border-white/10 rounded-xl px-4 py-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 resize-none transition-all"
                  style={{ minHeight: '44px', maxHeight: '120px' }}
                />
                {isLoading ? (
                  <button
                    onClick={onStopGeneration}
                    className="p-3 bg-red-500 hover:bg-red-600 text-white rounded-xl transition-colors flex-shrink-0"
                    title="Stop"
                  >
                    <Icons.Stop className="w-5 h-5" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                    className="p-3 bg-accent hover:bg-accent-dark text-white rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    title="Send"
                  >
                    <Icons.Send className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {/* Actions Tab */}
        {activeTab === 'actions' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-thin">
            {/* Quick Actions */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Quick Actions
              </h4>
              <div className="grid grid-cols-2 gap-2">
                {QUICK_ACTIONS.map((action) => (
                  <button
                    key={action.id}
                    onClick={() => handleQuickAction(action.id)}
                    disabled={isLoading}
                    className="flex items-center gap-2 p-3 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl text-left transition-colors disabled:opacity-50"
                  >
                    <span className="text-lg">{action.icon}</span>
                    <div>
                      <p className="text-sm font-medium text-text-primary dark:text-white">
                        {action.label}
                      </p>
                      <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                        {action.desc}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            {/* Translate */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Translate To
              </h4>
              <div className="relative">
                <button
                  onClick={() => setShowLanguages(!showLanguages)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🌍</span>
                    <span className="text-sm font-medium text-text-primary dark:text-white">
                      Select Language
                    </span>
                  </div>
                  <Icons.ChevronDown className={cn('w-4 h-4 transition-transform', showLanguages && 'rotate-180')} />
                </button>
                {showLanguages && (
                  <div className="mt-2 grid grid-cols-2 gap-2 p-2 bg-gray-50 dark:bg-white/5 rounded-xl animate-fadeIn">
                    {LANGUAGES.map((lang) => (
                      <button
                        key={lang}
                        onClick={() => handleTranslate(lang)}
                        disabled={isLoading}
                        className="p-2 text-sm text-left hover:bg-white dark:hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {lang}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Change Tone */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Change Tone
              </h4>
              <div className="relative">
                <button
                  onClick={() => setShowTones(!showTones)}
                  className="w-full flex items-center justify-between p-3 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🎭</span>
                    <span className="text-sm font-medium text-text-primary dark:text-white">
                      Select Tone
                    </span>
                  </div>
                  <Icons.ChevronDown className={cn('w-4 h-4 transition-transform', showTones && 'rotate-180')} />
                </button>
                {showTones && (
                  <div className="mt-2 grid grid-cols-2 gap-2 p-2 bg-gray-50 dark:bg-white/5 rounded-xl animate-fadeIn">
                    {TONES.map((tone) => (
                      <button
                        key={tone}
                        onClick={() => handleToneChange(tone)}
                        disabled={isLoading}
                        className="p-2 text-sm text-left hover:bg-white dark:hover:bg-white/10 rounded-lg transition-colors disabled:opacity-50"
                      >
                        {tone}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </section>

            {/* Generate */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Generate Content
              </h4>
              <div className="space-y-2">
                {GENERATE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => handleGenerate(option.id)}
                    disabled={isLoading}
                    className="w-full flex items-center gap-3 p-3 bg-gray-50 dark:bg-white/5 hover:bg-gray-100 dark:hover:bg-white/10 rounded-xl text-left transition-colors disabled:opacity-50"
                  >
                    <span className="text-lg">{option.icon}</span>
                    <span className="text-sm font-medium text-text-primary dark:text-white">
                      {option.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Memory Tab */}
        {activeTab === 'memory' && (
          <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-thin">
            {/* Preferences */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Your Preferences
              </h4>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-text-secondary dark:text-text-secondary-dark block mb-1">
                    Writing Style
                  </label>
                  <select
                    value={memory.userPreferences.writingStyle || ''}
                    onChange={(e) => onSetPreference('writingStyle', e.target.value)}
                    className="w-full bg-gray-50 dark:bg-white/5 border border-border dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent transition-colors"
                  >
                    <option value="">Not set</option>
                    <option value="concise">Concise</option>
                    <option value="detailed">Detailed</option>
                    <option value="casual">Casual</option>
                    <option value="formal">Formal</option>
                    <option value="creative">Creative</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-text-secondary dark:text-text-secondary-dark block mb-1">
                    Preferred Language
                  </label>
                  <select
                    value={memory.userPreferences.language || ''}
                    onChange={(e) => onSetPreference('language', e.target.value)}
                    className="w-full bg-gray-50 dark:bg-white/5 border border-border dark:border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent transition-colors"
                  >
                    <option value="">Auto-detect</option>
                    <option value="English">English</option>
                    <option value="Spanish">Spanish</option>
                    <option value="French">French</option>
                    <option value="German">German</option>
                    <option value="Chinese">Chinese</option>
                    <option value="Japanese">Japanese</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Recent Notes */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Recent Notes Context
              </h4>
              {memory.noteContext.recentNotes.length > 0 ? (
                <ul className="space-y-1">
                  {memory.noteContext.recentNotes.slice(0, 5).map((note: string, i: number) => (
                    <li
                      key={i}
                      className="text-sm text-text-primary dark:text-text-primary-dark truncate px-2 py-1 bg-gray-50 dark:bg-white/5 rounded"
                    >
                      📝 {note || 'Untitled'}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                  No recent notes yet
                </p>
              )}
            </section>

            {/* Common Tags */}
            <section>
              <h4 className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark uppercase tracking-wider mb-3">
                Common Topics
              </h4>
              {memory.noteContext.commonTags.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {memory.noteContext.commonTags.map((tag: string, i: number) => (
                    <span
                      key={i}
                      className="px-2 py-1 bg-accent/10 text-accent text-xs rounded-full"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                  No common topics yet
                </p>
              )}
            </section>

            {/* Clear History */}
            <section>
              <button
                onClick={onClearHistory}
                className="w-full py-2.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-xl transition-colors"
              >
                🗑️ Clear Chat History
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
});
