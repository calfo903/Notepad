// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  backoffDelay,
} from './circuitBreaker';
import { parseFallbackModels } from './schema';
import { handleChat } from './chatHandler';
import { resetTokenBudget } from './costGuard';
import { resetUpstreamBreaker } from './circuitBreaker';

describe('CircuitBreaker', () => {
  it('starts closed and admits calls', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.currentState).toBe('closed');
    expect(() => breaker.enter()).not.toThrow();
  });

  it('stays closed below the failure threshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.fail();
    breaker.fail();

    expect(breaker.currentState).toBe('closed');
    expect(() => breaker.enter()).not.toThrow();
  });

  it('opens at the threshold and rejects immediately', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    breaker.fail();
    breaker.fail();

    expect(breaker.currentState).toBe('open');
    expect(() => breaker.enter()).toThrow(CircuitOpenError);
  });

  it('clears the failure count on success', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.fail();
    breaker.succeed();
    breaker.fail();

    expect(breaker.currentState).toBe('closed');
  });

  it('becomes half-open once the cooldown elapses', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => now });

    breaker.fail();
    expect(breaker.currentState).toBe('open');

    now = 1_000;
    expect(breaker.currentState).toBe('half-open');
  });

  it('admits exactly one probe in half-open and refuses the rest', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => now });

    breaker.fail();
    now = 1_000;

    expect(() => breaker.enter()).not.toThrow();
    expect(() => breaker.enter()).toThrow(CircuitOpenError);
  });

  it('closes on a successful probe', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: () => now });

    breaker.fail();
    now = 1_000;
    breaker.enter();
    breaker.succeed();

    expect(breaker.currentState).toBe('closed');
    expect(() => breaker.enter()).not.toThrow();
  });

  it('reopens immediately on a failed probe rather than waiting for the threshold', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1_000, now: () => now });

    // Trip it deliberately, then wait out the cooldown.
    for (let i = 0; i < 5; i += 1) breaker.fail();
    now = 1_000;

    breaker.enter();
    breaker.fail();

    expect(breaker.currentState).toBe('open');
  });

  it('rejects invalid configuration', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0 })).toThrow(RangeError);
    expect(() => new CircuitBreaker({ cooldownMs: -1 })).toThrow(RangeError);
  });

  it('reset restores a closed breaker', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.fail();
    expect(breaker.currentState).toBe('open');

    breaker.reset();
    expect(breaker.currentState).toBe('closed');
  });

  it('has defaults that fail fast rather than after a long outage', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(5);
    expect(DEFAULT_COOLDOWN_MS).toBe(30_000);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially with the attempt number', () => {
    // random() === 1 takes the ceiling of the jitter range.
    expect(backoffDelay(0, 100, () => 1)).toBe(100);
    expect(backoffDelay(1, 100, () => 1)).toBe(200);
    expect(backoffDelay(2, 100, () => 1)).toBe(400);
  });

  it('applies full jitter so retries do not synchronise', () => {
    expect(backoffDelay(3, 100, () => 0)).toBe(0);
    expect(backoffDelay(3, 100, () => 0.5)).toBe(400);
  });

  it('never returns a negative delay for a negative attempt', () => {
    expect(backoffDelay(-5, 100, () => 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('parseFallbackModels', () => {
  const env = {
    OPENROUTER_ALLOWED_MODELS: 'openai/gpt-4o-mini,openai/gpt-4o,anthropic/claude-3.5-haiku',
  };

  it('returns nothing when unset', () => {
    expect(parseFallbackModels('openai/gpt-4o-mini', {})).toEqual([]);
  });

  it('drops the primary so it is not listed twice', () => {
    expect(
      parseFallbackModels('openai/gpt-4o-mini', {
        ...env,
        OPENROUTER_FALLBACK_MODELS: 'openai/gpt-4o-mini,openai/gpt-4o',
      })
    ).toEqual(['openai/gpt-4o']);
  });

  it('refuses a fallback outside the allowlist', () => {
    // A failover path must not become a route to an unapproved model.
    expect(
      parseFallbackModels('openai/gpt-4o-mini', {
        ...env,
        OPENROUTER_FALLBACK_MODELS: 'openai/gpt-4o,openai/o3-pro-expensive',
      })
    ).toEqual(['openai/gpt-4o']);
  });

  it('de-duplicates and trims', () => {
    expect(
      parseFallbackModels('openai/gpt-4o-mini', {
        ...env,
        OPENROUTER_FALLBACK_MODELS: ' openai/gpt-4o , openai/gpt-4o ,,',
      })
    ).toEqual(['openai/gpt-4o']);
  });

  it('is case-insensitive, matching how the allowlist is parsed', () => {
    expect(
      parseFallbackModels('openai/gpt-4o-mini', {
        ...env,
        OPENROUTER_FALLBACK_MODELS: 'OpenAI/GPT-4o',
      })
    ).toEqual(['openai/gpt-4o']);
  });
});

describe('handleChat — retry and circuit breaking', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test-key-not-a-real-secret';
    process.env.REQUIRE_AUTH_FOR_AI = 'false';
    resetTokenBudget();
    resetUpstreamBreaker();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.REQUIRE_AUTH_FOR_AI;
    delete process.env.OPENROUTER_FALLBACK_MODELS;
    resetTokenBudget();
    resetUpstreamBreaker();
  });

  const body = { messages: [{ role: 'user', content: 'hi' }], stream: false };

  function request(): Request {
    return new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function ok(): Response {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('retries a 503 and succeeds on the second attempt', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', spy);

    const response = await handleChat(request());

    expect(response.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure and succeeds on the second attempt', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', spy);

    expect((await handleChat(request())).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 — that is our mistake, not a transient failure', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(new Response('bad', { status: 400 }));
    vi.stubGlobal('fetch', spy);

    const response = await handleChat(request());

    expect(response.status).toBe(502);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up after the bounded number of attempts', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', spy);

    await handleChat(request());

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('opens the circuit after repeated failures and then fails fast', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', spy);

    // Default threshold is 5; each request makes 2 attempts, so three requests
    // record 6 failures and trip it.
    await handleChat(request());
    await handleChat(request());
    await handleChat(request());

    const callsBefore = spy.mock.calls.length;
    const response = await handleChat(request());

    expect(response.status).toBe(503);
    const parsed = (await response.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe('PROVIDER_CIRCUIT_OPEN');
    expect(response.headers.get('retry-after')).not.toBeNull();
    // Failed fast: no further upstream call was made.
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('closes the circuit again once the provider recovers', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(new Response('down', { status: 500 }));
    vi.stubGlobal('fetch', spy);

    await handleChat(request());
    await handleChat(request());
    await handleChat(request());
    expect((await handleChat(request())).status).toBe(503);

    // Simulate the cooldown elapsing and the provider recovering.
    resetUpstreamBreaker();
    spy.mockResolvedValue(ok());

    expect((await handleChat(request())).status).toBe(200);
  });

  it('sends the fallback model list when configured', async () => {
    process.env.OPENROUTER_FALLBACK_MODELS = 'openai/gpt-4o,anthropic/claude-3.5-haiku';
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(ok());
    vi.stubGlobal('fetch', spy);

    await handleChat(request());

    const sent = JSON.parse(spy.mock.calls[0][1]?.body as string) as {
      model: string;
      models?: string[];
    };
    expect(sent.models?.[0]).toBe(sent.model);
    expect(sent.models).toContain('openai/gpt-4o');
  });

  it('omits the fallback list when none is configured', async () => {
    const spy = vi
      .fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response('unused'))
      .mockResolvedValue(ok());
    vi.stubGlobal('fetch', spy);

    await handleChat(request());

    const sent = JSON.parse(spy.mock.calls[0][1]?.body as string) as { models?: unknown };
    expect(sent.models).toBeUndefined();
  });
});
