// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleChat } from './chatHandler';
import {
  PROMPT_VERSION,
  createTraceId,
  hashPrincipal,
  logAiInteraction,
  redact,
  type AiLogEntry,
} from './aiLog';

const KEY = 'sk-or-test-key-not-a-real-secret';

function entry(overrides: Partial<AiLogEntry> = {}): AiLogEntry {
  return {
    traceId: 'trace-1',
    principal: 'anon',
    model: 'openai/gpt-4o-mini',
    promptVersion: PROMPT_VERSION,
    stream: false,
    inputChars: 100,
    inputTokens: 25,
    outputTokens: 10,
    totalTokens: 35,
    latencyMs: 120,
    status: 200,
    ...overrides,
  };
}

describe('hashPrincipal', () => {
  it('is stable for the same identifier', async () => {
    expect(await hashPrincipal('sub-1')).toBe(await hashPrincipal('sub-1'));
  });

  it('differs per identifier', async () => {
    expect(await hashPrincipal('sub-1')).not.toBe(await hashPrincipal('sub-2'));
  });

  it('changes when the salt changes, so it is not a global identifier', async () => {
    const unsalted = await hashPrincipal('sub-1', {});
    const salted = await hashPrincipal('sub-1', { LOG_SALT: 'a-real-salt' });

    expect(unsalted).not.toBe(salted);
  });

  it('is a bounded hex string, not the raw identifier', async () => {
    const hashed = await hashPrincipal('109876543210987654321');

    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
    expect(hashed).not.toContain('109876543210987654321');
  });
});

describe('createTraceId', () => {
  it('produces unique, well-formed ids', () => {
    const a = createTraceId();
    const b = createTraceId();

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('logAiInteraction', () => {
  it('emits one parseable JSON line per call', () => {
    const lines: string[] = [];
    logAiInteraction(entry(), (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as AiLogEntry & { event: string };
    expect(parsed.event).toBe('ai.request');
    expect(parsed.traceId).toBe('trace-1');
    expect(parsed.totalTokens).toBe(35);
  });

  it('never carries prompt or completion content', () => {
    const lines: string[] = [];
    logAiInteraction(entry(), (line) => lines.push(line));

    // The record has no field capable of holding content, so assert the shape.
    const keys = Object.keys(JSON.parse(lines[0]) as Record<string, unknown>);
    expect(keys).toEqual([
      'event',
      'traceId',
      'principal',
      'model',
      'promptVersion',
      'stream',
      'inputChars',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'latencyMs',
      'status',
    ]);
  });

  it('degrades to a marker instead of throwing when serialisation fails', () => {
    const lines: string[] = [];
    const cyclic = entry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cyclic as any).self = cyclic;

    expect(() => logAiInteraction(cyclic, (line) => lines.push(line))).not.toThrow();
    expect(JSON.parse(lines[0]).errorCode).toBe('LOG_SERIALISATION_FAILED');
  });
});

describe('redact', () => {
  it('truncates hard', () => {
    expect(redact('x'.repeat(1_000), 10)).toHaveLength(10);
  });

  it('strips control characters', () => {
    expect(redact('a\u0000b\u001fc\u007fd')).toBe('abcd');
  });
});

describe('handleChat — observability', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = KEY;
    process.env.REQUIRE_AUTH_FOR_AI = 'false';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.REQUIRE_AUTH_FOR_AI;
  });

  function jsonUpstream() {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  function request(body: unknown, method = 'POST'): Request {
    const hasBody = method !== 'GET' && method !== 'HEAD';
    return new Request('http://localhost/api/chat', {
      method,
      headers: { 'content-type': 'application/json' },
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });
  }

  it('stamps a trace id on the response', async () => {
    jsonUpstream();
    const response = await handleChat(
      request({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    );

    expect(response.headers.get('x-trace-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stamps a trace id even on a rejected request', async () => {
    const response = await handleChat(request({}, 'GET'));

    expect(response.status).toBe(405);
    expect(response.headers.get('x-trace-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('forwards the trace id to the provider so the two records correlate', async () => {
    const spy = jsonUpstream();
    const response = await handleChat(
      request({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    );

    const sentInit = spy.mock.calls.at(0)?.[1];
    const headers = new Headers(sentInit?.headers as HeadersInit);
    expect(headers.get('x-request-id')).toBe(response.headers.get('x-trace-id'));
  });

  it('logs one structured line with model, tokens and latency', async () => {
    jsonUpstream();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    await handleChat(request({ messages: [{ role: 'user', content: 'hi' }], stream: false }));

    const aiLines = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => parsed?.event === 'ai.request');

    expect(aiLines).toHaveLength(1);
    const record = aiLines[0];
    expect(record.model).toBe('openai/gpt-4o-mini');
    expect(record.totalTokens).toBe(37);
    expect(record.inputTokens).toBe(30);
    expect(record.outputTokens).toBe(7);
    expect(record.status).toBe(200);
    expect(record.promptVersion).toBe(PROMPT_VERSION);
    expect(typeof record.latencyMs).toBe('number');

    logSpy.mockRestore();
  });

  it('records the error code on a rejected request', async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    await handleChat(request({}, 'GET'));

    const record = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((parsed) => parsed.event === 'ai.request');

    expect(record?.status).toBe(405);
    expect(record?.errorCode).toBe('METHOD_NOT_ALLOWED');

    logSpy.mockRestore();
  });

  it('labels an anonymous caller rather than dropping the record', async () => {
    jsonUpstream();
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    await handleChat(request({ messages: [{ role: 'user', content: 'hi' }], stream: false }));

    const record = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((parsed) => parsed.event === 'ai.request');

    expect(record?.principal).toBe('anon');

    logSpy.mockRestore();
  });

  it('still logs when the handler throws unexpectedly', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('boom');
    });
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await handleChat(
      request({ messages: [{ role: 'user', content: 'hi' }], stream: false })
    );

    expect(response.status).toBe(502);
    const record = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((parsed) => parsed.event === 'ai.request');
    expect(record?.errorCode).toBe('UPSTREAM_UNREACHABLE');

    logSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
