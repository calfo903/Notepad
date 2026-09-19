import { useState, useCallback, useMemo, useRef } from 'react';
import { AIMessage, AIMemory, AIQuickAction, AIGenerateType, AI_MEMORY_KEY } from '../types';
import { generateId, safeLocalStorageGet, safeLocalStorageSet } from '../utils/helpers';
import { getProvider } from '../services/ai/registry';
import {
  AIProviderError,
  ChatMessage,
  ProviderAbortedError,
  ProviderRateLimitError,
} from '../services/ai/types';

const MAX_HISTORY = 20;
/** Turns of prior conversation replayed to the model. */
const MAX_CONTEXT_TURNS = 6;
/** Bound on note context forwarded per request. */
const MAX_NOTE_CONTEXT = 2_000;

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

function saveMemory(memory: AIMemory): void {
  safeLocalStorageSet(AI_MEMORY_KEY, memory);
}

/**
 * Map a provider failure to a message worth showing. Aborts are user-initiated
 * and are deliberately not surfaced as errors.
 */
export function describeAIError(error: unknown): string {
  if (error instanceof ProviderAbortedError) return '';

  if (error instanceof ProviderRateLimitError) {
    return error.retryAfterSeconds > 0
      ? `You have hit the AI rate limit. Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }

  if (error instanceof AIProviderError) return error.message;
  if (error instanceof Error) return error.message;
  return 'AI request failed';
}

export function useAI() {
  const [memory, setMemory] = useState<AIMemory>(loadMemory);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>('');

  const provider = useMemo(() => getProvider(), []);
  /** Real cancellation: aborts the HTTP request, not just the render loop. */
  const abortControllerRef = useRef<AbortController | null>(null);

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

  const setFeedback = useCallback((messageId: string, feedback: 'up' | 'down') => {
    setMemory((prev) => {
      const newHistory = prev.conversationHistory.map((message) =>
        message.id === messageId
          ? // Toggling the same verdict again clears it, which is what a user who
            // clicked the wrong button expects.
            { ...message, feedback: message.feedback === feedback ? undefined : feedback }
          : message
      );
      const newMemory = { ...prev, conversationHistory: newHistory };
      saveMemory(newMemory);
      return newMemory;
    });
  }, []);

  const updateNoteContext = useCallback((noteTitle: string, tags: string[]) => {
    setMemory((prev) => {
      const recentNotes = [noteTitle, ...prev.noteContext.recentNotes.filter((n) => n !== noteTitle)].slice(
        0,
        10
      );
      const tagCounts = [...prev.noteContext.commonTags, ...tags].reduce(
        (acc, tag) => {
          acc[tag] = (acc[tag] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );
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

  /**
   * Application-level instructions only. Note body is deliberately excluded —
   * it travels as untrusted context so the backend can wrap and bound it.
   */
  const buildSystemPrompt = useCallback(
    (noteTitle?: string) => {
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
      if (!provider.isAvailable) {
        setError(`The ${provider.label} provider is unavailable.`);
        return '';
      }

      // Cancel any in-flight request before starting another; two concurrent
      // streams writing to the same buffer would interleave into garbage.
      abortControllerRef.current?.abort();
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsLoading(true);
      setError(null);
      setStreamingResponse('');

      const userMsg: AIMessage = {
        id: generateId(),
        role: 'user',
        content: userMessage,
        timestamp: Date.now(),
      };
      addToHistory(userMsg);

      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(options?.noteTitle) },
        ...memory.conversationHistory
          .filter((m): m is AIMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
          .slice(-MAX_CONTEXT_TURNS)
          .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage },
      ];

      const noteContext = options?.noteContent?.slice(0, MAX_NOTE_CONTEXT);

      let fullResponse = '';

      try {
        if (options?.stream) {
          for await (const delta of provider.stream({
            messages,
            noteContext,
            signal: controller.signal,
          })) {
            fullResponse += delta;
            setStreamingResponse(fullResponse);
          }
        } else {
          fullResponse = await provider.complete({
            messages,
            noteContext,
            signal: controller.signal,
          });
        }

        addToHistory({
          id: generateId(),
          role: 'assistant',
          content: fullResponse,
          timestamp: Date.now(),
        });

        return fullResponse;
      } catch (e) {
        // An abort is a normal outcome of stopGeneration, not a failure.
        if (e instanceof ProviderAbortedError || controller.signal.aborted) return fullResponse;

        setError(describeAIError(e));
        return '';
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        setIsLoading(false);
        setStreamingResponse('');
      }
    },
    [addToHistory, buildSystemPrompt, memory.conversationHistory, provider]
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

      const prompt = `${prompts[action]}\n\n${content}`;
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
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setIsLoading(false);
    setStreamingResponse('');
  }, []);

  const clearHistory = useCallback(() => {
    updateMemory({ conversationHistory: [] });
  }, [updateMemory]);

  /**
   * Re-run the most recent exchange.
   *
   * The trailing assistant reply and its user turn are removed, then the same
   * text is sent through `chat`, which re-appends it. Going back through `chat`
   * rather than duplicating the request code means a regenerate cannot drift from
   * a normal send — same hardening, same budget, same abort handling.
   */
  const regenerate = useCallback(
    async (options?: { noteContent?: string; noteTitle?: string }): Promise<string> => {
      // Read from the rendered `memory`, not from inside a state updater: the
      // updater does not run until the next render, so anything assigned in it is
      // still stale on the line below.
      const history = memory.conversationHistory;
      let index = history.length - 1;

      // Step back over any assistant replies to the most recent user turn.
      while (index >= 0 && history[index].role !== 'user') index -= 1;
      if (index < 0) return '';

      const lastUserContent = history[index].content;

      setMemory((prev) => {
        const newMemory = { ...prev, conversationHistory: history.slice(0, index) };
        saveMemory(newMemory);
        return newMemory;
      });

      return chat(lastUserContent, { ...options, stream: true });
    },
    [chat, memory.conversationHistory]
  );

  return {
    memory,
    isLoading,
    error,
    streamingResponse,
    providerId: provider.id,
    providerLabel: provider.label,
    chat,
    regenerate,
    setFeedback,
    quickAction,
    generateContent,
    stopGeneration,
    updateNoteContext,
    setUserPreference,
    clearHistory,
  };
}

export type AIStore = ReturnType<typeof useAI>;
