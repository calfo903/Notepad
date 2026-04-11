import { useState, useCallback, useRef } from 'react';
import { AIMessage, AIMemory, AIQuickAction, AIGenerateType, AI_MEMORY_KEY } from '../types';
import { generateId, safeLocalStorageGet, safeLocalStorageSet, sanitizePromptInput } from '../utils/helpers';

const MAX_HISTORY = 20;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 10; // Max 10 requests per minute

function loadMemory(): AIMemory {
  return safeLocalStorageGet<AIMemory>(AI_MEMORY_KEY, {
    userPreferences: {},
    conversationHistory: [],
    noteContext: {
      recentNotes: [],
      commonTags: [],
    },
  });
}

function saveMemory(memory: AIMemory) {
  safeLocalStorageSet(AI_MEMORY_KEY, memory);
}

export function useAI() {
  const [memory, setMemory] = useState<AIMemory>(loadMemory);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const abortRef = useRef(false);
  const rateLimitRef = useRef<number[]>([]);
  
  // Check rate limit
  const checkRateLimit = useCallback((): boolean => {
    const now = Date.now();
    // Remove timestamps outside the window
    rateLimitRef.current = rateLimitRef.current.filter(
      timestamp => now - timestamp < RATE_LIMIT_WINDOW
    );
    
    if (rateLimitRef.current.length >= MAX_REQUESTS_PER_WINDOW) {
      return false; // Rate limited
    }
    
    rateLimitRef.current.push(now);
    return true;
  }, []);

  const updateMemory = useCallback((updates: Partial<AIMemory>) => {
    setMemory((prev) => {
      const newMemory = { ...prev, ...updates };
      saveMemory(newMemory);
      return newMemory;
    });
  }, []);

  const addToHistory = useCallback((message: AIMessage) => {
    setMemory((prev) => {
      const newHistory = [...prev.conversationHistory, message].slice(-MAX_HISTORY);
      const newMemory = { ...prev, conversationHistory: newHistory };
      saveMemory(newMemory);
      return newMemory;
    });
  }, []);

  const updateNoteContext = useCallback((noteTitle: string, tags: string[]) => {
    setMemory((prev) => {
      const recentNotes = [noteTitle, ...prev.noteContext.recentNotes.filter((n) => n !== noteTitle)].slice(0, 10);
      const allTags = [...prev.noteContext.commonTags, ...tags];
      const tagCounts = allTags.reduce((acc, tag) => {
        acc[tag] = (acc[tag] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      const commonTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag]) => tag);

      const newMemory = {
        ...prev,
        noteContext: { ...prev.noteContext, recentNotes, commonTags },
      };
      saveMemory(newMemory);
      return newMemory;
    });
  }, []);

  const setUserPreference = useCallback(
    (key: 'writingStyle' | 'topics' | 'language', value: string | string[]) => {
      setMemory((prev) => {
        const newMemory = {
          ...prev,
          userPreferences: { ...prev.userPreferences, [key]: value },
        };
        saveMemory(newMemory);
        return newMemory;
      });
    },
    []
  );

  const buildSystemPrompt = useCallback(
    (noteContent?: string, noteTitle?: string) => {
      const parts = [
        'You are NoteFlow AI, an intelligent writing assistant built into an advanced notepad application.',
        'You help users write, edit, improve, summarize, translate, and brainstorm content.',
        "Be concise, helpful, and match the user's writing style when possible.",
        'Format your responses in a clean, readable way.',
      ];

      if (memory.userPreferences.writingStyle) {
        parts.push(`User's preferred writing style: ${memory.userPreferences.writingStyle}`);
      }
      if (memory.userPreferences.language) {
        parts.push(`User's preferred language: ${memory.userPreferences.language}`);
      }
      if (memory.noteContext.commonTags.length > 0) {
        parts.push(`User commonly writes about: ${memory.noteContext.commonTags.join(', ')}`);
      }
      if (noteTitle) {
        parts.push(`Current note title: "${noteTitle}"`);
      }
      if (noteContent) {
        parts.push(
          `Current note content (for context):\n---\n${noteContent.slice(0, 2000)}${noteContent.length > 2000 ? '...' : ''}\n---`
        );
      }

      return parts.join('\n');
    },
    [memory]
  );

  const chat = useCallback(
    async (
      userMessage: string,
      options?: {
        noteContent?: string;
        noteTitle?: string;
        stream?: boolean;
      }
    ): Promise<string> => {
      if (!window.puter) {
        setError('Puter.js not loaded. Please refresh the page.');
        return '';
      }

      // Check rate limit
      if (!checkRateLimit()) {
        setError('Rate limit exceeded. Please wait a moment before trying again.');
        return '';
      }

      setIsLoading(true);
      setError(null);
      setStreamingResponse('');
      abortRef.current = false;

      // Sanitize user input to prevent prompt injection
      const sanitizedMessage = sanitizePromptInput(userMessage);
      
      // Add user message to history (sanitized)
      const userMsg: AIMessage = {
        id: generateId(),
        role: 'user',
        content: sanitizedMessage,
        timestamp: Date.now(),
      };
      addToHistory(userMsg);

      try {
        const systemPrompt = buildSystemPrompt(options?.noteContent, options?.noteTitle);

        // Build messages with history context
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          ...memory.conversationHistory.slice(-6).map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: m.content,
          })),
          { role: 'user' as const, content: sanitizedMessage },
        ];

        let fullResponse = '';

        if (options?.stream) {
          const response = await window.puter.ai.chat(messages, { stream: true });

          // Handle streaming response - check if it's an async iterable
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const asyncResponse = response as any;
            if (asyncResponse && typeof asyncResponse[Symbol.asyncIterator] === 'function') {
              for await (const chunk of asyncResponse) {
                if (abortRef.current) break;
                const text = chunk?.text || '';
                fullResponse += text;
                setStreamingResponse(fullResponse);
              }
            } else {
              // Fallback for non-streaming response
              if (asyncResponse?.message?.content) {
                fullResponse = typeof asyncResponse.message.content === 'string' 
                  ? asyncResponse.message.content 
                  : asyncResponse.message.content.map((c: { text?: string }) => c.text || '').join('');
              } else {
                fullResponse = asyncResponse?.toString() || '';
              }
            }
          } catch {
            // Handle any streaming errors gracefully
            fullResponse = 'Sorry, there was an error processing the response.';
          }
        } else {
          const response = await window.puter.ai.chat(messages);
          const result = response as { message?: { content: string | Array<{ text?: string }> }; toString(): string };
          if (result?.message?.content) {
            fullResponse = typeof result.message.content === 'string' 
              ? result.message.content 
              : result.message.content.map(c => c.text || '').join('');
          } else {
            fullResponse = result?.toString() || '';
          }
        }

        // Add assistant response to history
        const assistantMsg: AIMessage = {
          id: generateId(),
          role: 'assistant',
          content: fullResponse,
          timestamp: Date.now(),
        };
        addToHistory(assistantMsg);

        setIsLoading(false);
        setStreamingResponse('');
        return fullResponse;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : 'AI request failed';
        setError(errorMessage);
        setIsLoading(false);
        return '';
      }
    },
    [addToHistory, buildSystemPrompt, memory.conversationHistory]
  );

  const quickAction = useCallback(
    async (
      action: AIQuickAction,
      content: string,
      extraParams?: { language?: string; tone?: string }
    ): Promise<string> => {
      const prompts: Record<AIQuickAction, string> = {
        summarize: 'Summarize the following text concisely, capturing the key points:',
        improve: 'Improve the writing quality, clarity, and flow of this text while maintaining the original meaning:',
        expand: 'Expand on this text with more details, examples, and explanations:',
        simplify: 'Simplify this text to make it easier to understand, using simpler words and shorter sentences:',
        translate: `Translate the following text to ${extraParams?.language || 'Spanish'}:`,
        fix: 'Fix any grammar, spelling, and punctuation errors in this text:',
        tone: `Rewrite this text in a ${extraParams?.tone || 'professional'} tone:`,
        bullets: 'Convert this text into a clear, organized bullet point list:',
        headlines: 'Generate 5 creative and engaging headline/title options for this content:',
        questions: 'Generate 5 thoughtful questions that could be asked about this content:',
      };

      // Sanitize content before sending to AI
      const sanitizedContent = sanitizePromptInput(content);
      const prompt = `${prompts[action]}

${sanitizedContent}`;
      return chat(prompt, { stream: true });
    },
    [chat]
  );

  const generateContent = useCallback(
    async (type: AIGenerateType, topic: string, existingContent?: string): Promise<string> => {
      const prompts: Record<AIGenerateType, string> = {
        outline: `Create a detailed outline for a document about: ${topic}`,
        draft: `Write a first draft for a document about: ${topic}`,
        ideas: `Brainstorm 10 creative ideas related to: ${topic}`,
        continue: `Continue writing from where this text left off, maintaining the same style and tone:\n\n${existingContent}`,
      };

      return chat(prompts[type], { stream: true });
    },
    [chat]
  );

  const stopGeneration = useCallback(() => {
    abortRef.current = true;
    setIsLoading(false);
  }, []);

  const clearHistory = useCallback(() => {
    updateMemory({ conversationHistory: [] });
  }, [updateMemory]);

  return {
    memory,
    isLoading,
    error,
    streamingResponse,
    chat,
    quickAction,
    generateContent,
    stopGeneration,
    updateNoteContext,
    setUserPreference,
    clearHistory,
  };
}

export type AIStore = ReturnType<typeof useAI>;
