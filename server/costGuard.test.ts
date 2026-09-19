// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  BUDGET_WINDOW_MS,
  DEFAULT_DAILY_TOKEN_BUDGET,
  InMemoryTokenBudget,
  TokenBudget,
  estimateTokens,
} from './costGuard';
import { UsageScanner, parseUsage } from './usage';

describe('estimateTokens', () => {
  it('rounds up so a budget is never under-reserved', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(-10)).toBe(0);
  });
});

describe('InMemoryTokenBudget', () => {
  it('starts at zero for an unknown key', () => {
    expect(new InMemoryTokenBudget().get('nobody')).toBe(0);
  });

  it('accumulates within a window', () => {
    const store = new InMemoryTokenBudget(() => 0);
    store.add('a', 100);
    store.add('a', 50);
    expect(store.get('a')).toBe(150);
  });

  it('resets when the window rolls over', () => {
    let now = 0;
    const store = new InMemoryTokenBudget(() => now);

    store.add('a', 100);
    expect(store.get('a')).toBe(100);

    now = BUDGET_WINDOW_MS;
    expect(store.get('a')).toBe(0);
  });

  it('ignores negative additions', () => {
    const store = new InMemoryTokenBudget(() => 0);
    store.add('a', 100);
    store.add('a', -500);
    expect(store.get('a')).toBe(100);
  });

  it('keeps principals separate', () => {
    const store = new InMemoryTokenBudget(() => 0);
    store.add('a', 1);
    store.add('b', 2);
    expect(store.get('a')).toBe(1);
    expect(store.get('b')).toBe(2);
    expect(store.size).toBe(2);
  });
});

describe('TokenBudget', () => {
  it('rejects a non-positive limit', () => {
    expect(() => new TokenBudget({ limitTokens: 0 })).toThrow(RangeError);
    expect(() => new TokenBudget({ limitTokens: Number.NaN })).toThrow(RangeError);
  });

  it('allows a request that fits and refuses one that does not', async () => {
    const budget = new TokenBudget({ limitTokens: 1_000, now: () => 0 });

    expect((await budget.check('a', 600)).allowed).toBe(true);
    await budget.record('a', 600);
    expect((await budget.check('a', 600)).allowed).toBe(false);
    expect((await budget.check('a', 400)).allowed).toBe(true);
  });

  it('reports how long until the window resets', async () => {
    const budget = new TokenBudget({ limitTokens: 100, now: () => BUDGET_WINDOW_MS / 2 });
    const decision = await budget.check('a', 10);

    expect(decision.resetsInSeconds).toBeGreaterThan(0);
    expect(decision.resetsInSeconds).toBeLessThanOrEqual(BUDGET_WINDOW_MS / 1_000);
  });

  it('ignores a zero or negative record', async () => {
    const budget = new TokenBudget({ limitTokens: 1_000, now: () => 0 });
    await budget.record('a', 0);
    await budget.record('a', -50);

    expect((await budget.check('a', 1_000)).allowed).toBe(true);
  });

  it('accepts a custom store, which is the Redis seam', async () => {
    const calls: string[] = [];
    const budget = new TokenBudget({
      limitTokens: 10,
      store: {
        get: (key) => {
          calls.push(`get:${key}`);
          return 5;
        },
        add: (key, tokens) => {
          calls.push(`add:${key}:${tokens}`);
        },
      },
    });

    expect((await budget.check('u', 5)).allowed).toBe(true);
    expect((await budget.check('u', 6)).allowed).toBe(false);
    await budget.record('u', 3);

    expect(calls).toEqual(['get:u', 'get:u', 'add:u:3']);
  });

  it('has a default budget that bounds a single day of heavy use', () => {
    // Sanity on the shipped constant: 500k tokens is ~250 full requests, well
    // beyond what a person writes and well below an unbounded invoice.
    expect(DEFAULT_DAILY_TOKEN_BUDGET).toBe(500_000);
  });
});

describe('parseUsage', () => {
  it('reads a standard usage object', () => {
    expect(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it('derives the total when the provider omits it', () => {
    expect(parseUsage({ usage: { prompt_tokens: 10, completion_tokens: 5 } })?.totalTokens).toBe(15);
  });

  it('returns null when there is nothing usable', () => {
    expect(parseUsage({})).toBeNull();
    expect(parseUsage({ usage: null })).toBeNull();
    expect(parseUsage({ usage: {} })).toBeNull();
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage('nope')).toBeNull();
  });

  it('ignores malformed counts rather than producing NaN', () => {
    const usage = parseUsage({ usage: { prompt_tokens: 'ten', completion_tokens: 5 } });
    expect(usage).toEqual({ promptTokens: 0, completionTokens: 5, totalTokens: 5 });
  });
});

describe('UsageScanner', () => {
  const encoder = new TextEncoder();

  it('finds usage in a single well-formed frame', () => {
    const scanner = new UsageScanner();
    const usage = scanner.push(
      encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n')
    );

    expect(usage?.totalTokens).toBe(6);
    expect(scanner.result?.totalTokens).toBe(6);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const scanner = new UsageScanner();
    const frame = 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n';

    expect(scanner.push(encoder.encode(frame.slice(0, 30)))).toBeNull();
    expect(scanner.push(encoder.encode(frame.slice(30, 61)))).toBeNull();

    const usage = scanner.push(encoder.encode(frame.slice(61)));
    expect(usage?.totalTokens).toBe(6);
  });

  it('passes over content deltas and the [DONE] terminator', () => {
    const scanner = new UsageScanner();

    expect(scanner.push(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'))).toBeNull();
    expect(scanner.push(encoder.encode('data: [DONE]\n\n'))).toBeNull();
    expect(scanner.result).toBeNull();
  });

  it('tolerates a malformed frame and keeps scanning', () => {
    const scanner = new UsageScanner();

    expect(scanner.push(encoder.encode('data: {not json\n\n'))).toBeNull();
    const usage = scanner.push(
      encoder.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n')
    );

    expect(usage?.totalTokens).toBe(2);
  });

  it('flushes a trailing frame that never received a newline', () => {
    const scanner = new UsageScanner();
    scanner.push(encoder.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}'));

    expect(scanner.result).toBeNull();
    expect(scanner.end()?.totalTokens).toBe(2);
  });

  it('reports usage once and then short-circuits', () => {
    const scanner = new UsageScanner();
    const frame = 'data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n';

    expect(scanner.push(encoder.encode(frame))?.totalTokens).toBe(2);
    expect(scanner.push(encoder.encode(frame))).toEqual(scanner.result);
  });

  it('ignores SSE comment lines', () => {
    const scanner = new UsageScanner();
    expect(scanner.push(encoder.encode(': keep-alive\n\n'))).toBeNull();
    expect(scanner.result).toBeNull();
  });
});
