import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenRouterProvider } from '../services/ai/openRouterProvider';
import { PuterProvider } from '../services/ai/puterProvider';
import { getProvider, listProviders, resetProviderRegistry } from '../services/ai/registry';
import {
  ProviderAbortedError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderUpstreamError,
  ProviderValidationError,
  ChatMessage,
} from '../services/ai/types';
import { describeAIError } from '../hooks/useAI';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'Improve this.' }];

function sse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stub(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetProviderRegistry();
});

describe('OpenRouterProvider.complete', () => {
  it('posts to the same-origin endpoint and returns the content', async () => {
    const spy = stub(async () => json(200, { content: 'Polished.', model: 'openai/gpt-4o-mini' }));
    const provider = new OpenRouterProvider();

    await expect(provider.complete({ messages: MESSAGES })).resolves.toBe('Polished.');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/chat');
    expect(JSON.parse(init.body as string)).toMatchObject({ stream: false });
  });

  it('forwards note context in the body, never as a header', async () => {
    const spy = stub(async () => json(200, { content: 'ok' }));
    const provider = new OpenRouterProvider();

    // Header values cannot contain newlines, so multi-line notes must go in the body.
    await provider.complete({ messages: MESSAGES, noteContext: 'line one\nline two' });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const payload = JSON.parse(init.body as string) as { noteContext?: string; messages: unknown[] };

    expect(headers['x-note-context']).toBeUndefined();
    expect(payload.noteContext).toBe('line one\nline two');
    expect(JSON.stringify(payload.messages)).not.toContain('line one');
  });

  it('bounds note context to the configured maximum', async () => {
    const spy = stub(async () => json(200, { content: 'ok' }));

    await new OpenRouterProvider().complete({
      messages: MESSAGES,
      noteContext: 'y'.repeat(9_000),
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as { noteContext: string };

    expect(payload.noteContext).toHaveLength(2_000);
  });

  it('omits the model field when none is configured', async () => {
    const spy = stub(async () => json(200, { content: 'ok' }));
    await new OpenRouterProvider().complete({ messages: MESSAGES });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('model');
  });

  it('sends the model when one is configured', async () => {
    const spy = stub(async () => json(200, { content: 'ok' }));
    await new OpenRouterProvider('anthropic/claude-3.5-haiku').complete({ messages: MESSAGES });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe('anthropic/claude-3.5-haiku');
  });

  it('maps 401 to ProviderAuthError', async () => {
    stub(async () => json(401, { error: { code: 'UPSTREAM_AUTH_FAILED', message: 'Bad key' } }));

    await expect(new OpenRouterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderAuthError
    );
  });

  it('maps 403 MODEL_NOT_ALLOWED to ProviderAuthError', async () => {
    stub(async () => json(403, { error: { code: 'MODEL_NOT_ALLOWED', message: 'Not enabled' } }));

    await expect(new OpenRouterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderAuthError
    );
  });

  it('maps 429 to ProviderRateLimitError carrying Retry-After', async () => {
    stub(async () =>
      json(429, { error: { code: 'RATE_LIMITED', message: 'Slow down' } }, { 'retry-after': '37' })
    );

    const error = await new OpenRouterProvider()
      .complete({ messages: MESSAGES })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect((error as ProviderRateLimitError).retryAfterSeconds).toBe(37);
    expect((error as ProviderRateLimitError).retryable).toBe(true);
  });

  it('maps 400 to ProviderValidationError', async () => {
    stub(async () => json(400, { error: { code: 'VALIDATION_FAILED', message: 'Bad body' } }));

    await expect(new OpenRouterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderValidationError
    );
  });

  it('maps 503 to ProviderUnavailableError', async () => {
    stub(async () => json(503, { error: { code: 'PROVIDER_NOT_CONFIGURED', message: 'No key' } }));

    await expect(new OpenRouterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });

  it('wraps a network failure in ProviderUnavailableError', async () => {
    stub(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(new OpenRouterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });
});

describe('OpenRouterProvider.stream', () => {
  it('yields text deltas in arrival order and stops at [DONE]', async () => {
    stub(async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"SHOULD NOT APPEAR"}}]}\n\n',
      ])
    );

    const out: string[] = [];
    for await (const delta of new OpenRouterProvider().stream({ messages: MESSAGES })) out.push(delta);

    expect(out.join('')).toBe('Hello');
  });

  it('skips role-only deltas instead of yielding empty strings', async () => {
    stub(async () =>
      sse([
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );

    const out: string[] = [];
    for await (const delta of new OpenRouterProvider().stream({ messages: MESSAGES })) out.push(delta);

    expect(out).toEqual(['x']);
  });

  it('throws ProviderUpstreamError on an SSE error frame', async () => {
    stub(async () =>
      sse([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
        'event: error\ndata: {"error":{"code":"UPSTREAM_STREAM_ERROR","message":"cut off"}}\n\n',
      ])
    );

    await expect(async () => {
      for await (const _delta of new OpenRouterProvider().stream({ messages: MESSAGES })) {
        void _delta;
      }
    }).rejects.toBeInstanceOf(ProviderUpstreamError);
  });

  it('degrades to a single yield when the backend returns JSON', async () => {
    stub(async () => json(200, { content: 'Whole answer' }));

    const out: string[] = [];
    for await (const delta of new OpenRouterProvider().stream({ messages: MESSAGES })) out.push(delta);

    expect(out).toEqual(['Whole answer']);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const spy = stub(async () => json(200, { content: 'ok' }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      (async () => {
        for await (const _delta of new OpenRouterProvider().stream({
          messages: MESSAGES,
          signal: controller.signal,
        })) {
          void _delta;
        }
      })()
    ).rejects.toBeInstanceOf(ProviderAbortedError);

    expect(spy).not.toHaveBeenCalled();
  });
});

describe('PuterProvider', () => {
  it('reports unavailable when window.puter is absent', () => {
    // setup.ts defines window.puter with configurable:false, so assign undefined.
    (window as unknown as { puter: unknown }).puter = undefined;
    expect(new PuterProvider().isAvailable).toBe(false);
  });

  it('throws ProviderUnavailableError from complete when the SDK is missing', async () => {
    (window as unknown as { puter: unknown }).puter = undefined;

    await expect(new PuterProvider().complete({ messages: MESSAGES })).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
  });

  it('reports available once the SDK exposes ai.chat', () => {
    (window as unknown as { puter: unknown }).puter = { ai: { chat: vi.fn() } };
    expect(new PuterProvider().isAvailable).toBe(true);
  });

  it('accumulates streamed chunks into the full response', async () => {
    const chat = vi.fn(async () => {
      async function* gen() {
        yield { text: 'foo' };
        yield { text: 'bar' };
      }
      return gen();
    });
    (window as unknown as { puter: unknown }).puter = { ai: { chat } };

    await expect(new PuterProvider().complete({ messages: MESSAGES })).resolves.toBe('foobar');
  });

  it('handles the non-iterable response shape', async () => {
    const chat = vi.fn(async () => ({ message: { content: 'direct' }, toString: (): string => 'direct' }));
    (window as unknown as { puter: unknown }).puter = { ai: { chat } };

    await expect(new PuterProvider().complete({ messages: MESSAGES })).resolves.toBe('direct');
  });

  it('joins array-shaped message content', async () => {
    const chat = vi.fn(async () => ({
      message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      toString: (): string => '',
    }));
    (window as unknown as { puter: unknown }).puter = { ai: { chat } };

    await expect(new PuterProvider().complete({ messages: MESSAGES })).resolves.toBe('ab');
  });
});

describe('registry', () => {
  it('defaults to openrouter and memoises the instance', () => {
    expect(getProvider().id).toBe('openrouter');
    expect(getProvider()).toBe(getProvider());
  });

  it('returns the requested provider explicitly', () => {
    expect(getProvider('puter').id).toBe('puter');
    expect(getProvider('openrouter').id).toBe('openrouter');
  });

  it('lists every registered provider', () => {
    expect(listProviders().map((p) => p.id)).toEqual(['openrouter', 'puter']);
  });

  it('builds a fresh instance after reset', () => {
    const first = getProvider();
    resetProviderRegistry();
    expect(getProvider()).not.toBe(first);
  });
});

describe('describeAIError', () => {
  it('returns an empty string for a user-initiated abort', () => {
    expect(describeAIError(new ProviderAbortedError('cancelled', 'openrouter'))).toBe('');
  });

  it('includes the retry window for rate limits', () => {
    const message = describeAIError(new ProviderRateLimitError('limited', 'openrouter', 42));
    expect(message).toContain('42s');
  });

  it('passes through provider messages', () => {
    expect(describeAIError(new ProviderAuthError('Bad key', 'openrouter'))).toBe('Bad key');
  });

  it('handles non-Error values without throwing', () => {
    expect(describeAIError('string failure')).toBe('AI request failed');
    expect(describeAIError(null)).toBe('AI request failed');
  });
});
