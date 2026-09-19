import { describe, it, expect } from 'vitest';
import { parseEventBlock, parseSSEStream, extractDelta, SSE_DONE } from '../services/ai/sse';

const encoder = new TextEncoder();

async function* chunks(parts: readonly string[]): AsyncGenerator<Uint8Array, void, undefined> {
  for (const part of parts) yield encoder.encode(part);
}

async function collect(gen: AsyncGenerator<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe('parseEventBlock', () => {
  it('reads event and data fields', () => {
    expect(parseEventBlock('event: error\ndata: {"a":1}')).toEqual({
      event: 'error',
      data: '{"a":1}',
    });
  });

  it('defaults the event name to message', () => {
    expect(parseEventBlock('data: hello')).toEqual({ event: 'message', data: 'hello' });
  });

  it('joins multi-line data with newlines', () => {
    expect(parseEventBlock('data: line1\ndata: line2')).toEqual({
      event: 'message',
      data: 'line1\nline2',
    });
  });

  it('strips exactly one leading space after the colon', () => {
    expect(parseEventBlock('data:  two spaces')).toEqual({ event: 'message', data: ' two spaces' });
  });

  it('ignores comment lines and blank lines', () => {
    expect(parseEventBlock(': heartbeat\n\ndata: real')).toEqual({ event: 'message', data: 'real' });
  });

  it('returns null when there is no data field', () => {
    expect(parseEventBlock('event: ping')).toBeNull();
  });
});

describe('parseSSEStream', () => {
  it('emits one event per blank-line boundary', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks(['data: a\n\ndata: b\n\n']))) {
      events.push(event);
    }

    expect(events).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  it('reassembles an event split across three chunks', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks(['data: {"cho', 'ices":[{"delta":{"con', 'tent":"x"}}]}\n\n']))) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(JSON.parse((events[0] as { data: string }).data)).toEqual({
      choices: [{ delta: { content: 'x' } }],
    });
  });

  it('handles two events arriving in a single chunk', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks(['data: a\n\ndata: b\n\n']))) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
  });

  it('normalises CRLF boundaries', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks(['data: a\r\n\r\ndata: b\r\n\r\n']))) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
  });

  it('flushes a trailing event with no final blank line', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks(['data: tail']))) {
      events.push(event);
    }
    expect(events).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('surfaces the terminator sentinel verbatim', async () => {
    const events: unknown[] = [];
    for await (const event of parseSSEStream(chunks([`data: ${SSE_DONE}\n\n`]))) {
      events.push(event);
    }
    expect((events[0] as { data: string }).data).toBe(SSE_DONE);
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(chunks([]))).toEqual([]);
  });
});

describe('extractDelta', () => {
  it('reads a streaming delta', () => {
    expect(extractDelta({ choices: [{ delta: { content: 'hi' } }] })).toBe('hi');
  });

  it('returns empty string for a role-only delta', () => {
    expect(extractDelta({ choices: [{ delta: { role: 'assistant' } }] })).toBe('');
  });

  it('falls back to the non-streaming message shape', () => {
    expect(extractDelta({ choices: [{ message: { content: 'full' } }] })).toBe('full');
  });

  it('tolerates usage trailers and malformed payloads', () => {
    expect(extractDelta({ usage: { total_tokens: 5 } })).toBe('');
    expect(extractDelta({ choices: [] })).toBe('');
    expect(extractDelta(null)).toBe('');
    expect(extractDelta('nope')).toBe('');
    expect(extractDelta(undefined)).toBe('');
  });
});
