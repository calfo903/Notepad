import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useAI } from '../hooks/useAI';

// The registry hands back a live provider; the tests need one they can assert on.
// chat() without `stream: true` takes the non-streaming path, so both halves of
// the provider have to be mocked or the first turn silently resolves to nothing.
// The request parameter must be declared: vi.fn infers an empty tuple from a
// zero-argument function and mock.calls[0][0] then does not typecheck.
const stream = vi.fn(async function* (_request: unknown): AsyncGenerator<string> {
  yield 'second ';
  yield 'answer';
});

vi.mock('../services/ai/registry', () => ({
  getProvider: () => ({
    id: 'test',
    label: 'Test AI',
    isAvailable: true,
    stream,
    complete: vi.fn(async () => 'first answer'),
  }),
}));

describe('useAI — conversation feedback', () => {
  beforeEach(() => {
    localStorage.clear();
    stream.mockClear();
  });

  it('records a verdict on a response', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('hello');
    });

    const assistant = result.current.memory.conversationHistory.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();

    act(() => {
      result.current.setFeedback(assistant!.id, 'up');
    });

    const rated = result.current.memory.conversationHistory.find((m) => m.id === assistant!.id);
    expect(rated?.feedback).toBe('up');
  });

  it('clicking the same verdict again clears it', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('hello');
    });
    const assistant = result.current.memory.conversationHistory.find((m) => m.role === 'assistant')!;

    act(() => result.current.setFeedback(assistant.id, 'down'));
    expect(result.current.memory.conversationHistory.find((m) => m.id === assistant.id)?.feedback).toBe('down');

    act(() => result.current.setFeedback(assistant.id, 'down'));
    expect(result.current.memory.conversationHistory.find((m) => m.id === assistant.id)?.feedback).toBeUndefined();
  });

  it('persists the verdict so it survives a reload', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('hello');
    });
    const assistant = result.current.memory.conversationHistory.find((m) => m.role === 'assistant')!;
    act(() => result.current.setFeedback(assistant.id, 'up'));

    const remounted = renderHook(() => useAI());
    const restored = remounted.result.current.memory.conversationHistory.find(
      (m) => m.id === assistant.id
    );

    expect(restored?.feedback).toBe('up');
  });
});

describe('useAI — regenerate', () => {
  beforeEach(() => {
    localStorage.clear();
    stream.mockClear();
  });

  it('replaces the last answer rather than appending a second one', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('first question');
    });
    expect(result.current.memory.conversationHistory).toHaveLength(2);

    await act(async () => {
      await result.current.regenerate();
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const history = result.current.memory.conversationHistory;
    // One user turn, one assistant reply — not two of each.
    expect(history.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(history.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(history[0].content).toBe('first question');
  });

  it('resends the same text the user originally wrote', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('rewrite this paragraph');
    });
    stream.mockClear();

    await act(async () => {
      await result.current.regenerate();
    });

    expect(stream).toHaveBeenCalledTimes(1);
    const sent = stream.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    const userTurns = sent.messages.filter((m) => m.role === 'user');

    expect(userTurns.at(-1)?.content).toBe('rewrite this paragraph');
  });

  it('does nothing when there is no conversation yet', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.regenerate();
    });

    expect(stream).not.toHaveBeenCalled();
    expect(result.current.memory.conversationHistory).toEqual([]);
  });

  it('drops a previously given verdict on the answer it replaces', async () => {
    const { result } = renderHook(() => useAI());

    await act(async () => {
      await result.current.chat('hello');
    });
    const assistant = result.current.memory.conversationHistory.find((m) => m.role === 'assistant')!;
    act(() => result.current.setFeedback(assistant.id, 'down'));

    await act(async () => {
      await result.current.regenerate();
    });

    const remaining = result.current.memory.conversationHistory.find((m) => m.id === assistant.id);
    expect(remaining).toBeUndefined();
  });
});
