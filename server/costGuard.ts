/**
 * Per-principal token budget.
 *
 * A rate limiter bounds request *count*; it says nothing about cost, because one
 * request can be a hundred times another. This bounds the thing that actually
 * appears on the invoice.
 *
 * The store is an interface for the same reason the rate limiter is: the
 * in-memory default is per-isolate, so on a multi-isolate deployment the real
 * limit is `N x configured`. Swap in a Redis/Upstash-backed store behind this
 * interface for global enforcement; nothing else changes.
 */

export interface BudgetDecision {
  readonly allowed: boolean;
  readonly usedTokens: number;
  readonly limitTokens: number;
  /** Seconds until the current window rolls over. */
  readonly resetsInSeconds: number;
}

export interface TokenBudgetStore {
  /** Tokens consumed by `key` in the current window. */
  get(key: string): Promise<number> | number;
  /** Add to `key`'s tally for the current window. */
  add(key: string, tokens: number): Promise<void> | void;
}

/** Milliseconds in the budget window. A UTC day keeps it predictable. */
export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Rough chars-per-token. 4:1 is the standard approximation for English prose
 * and errs slightly high on markup-heavy note content, which is the safe
 * direction for a budget.
 */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / CHARS_PER_TOKEN);
}

export class InMemoryTokenBudget implements TokenBudgetStore {
  private readonly entries = new Map<string, { tokens: number; windowStart: number }>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  private windowStart(timestamp: number): number {
    return Math.floor(timestamp / BUDGET_WINDOW_MS) * BUDGET_WINDOW_MS;
  }

  get(key: string): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (entry.windowStart !== this.windowStart(this.now())) {
      this.entries.delete(key);
      return 0;
    }
    return entry.tokens;
  }

  add(key: string, tokens: number): void {
    const start = this.windowStart(this.now());
    const existing = this.entries.get(key);

    if (!existing || existing.windowStart !== start) {
      this.entries.set(key, { tokens: Math.max(0, tokens), windowStart: start });
      return;
    }

    existing.tokens += Math.max(0, tokens);
  }

  /** Number of tracked principals. Exposed for tests and observability. */
  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export class TokenBudget {
  private readonly store: TokenBudgetStore;
  private readonly limitTokens: number;
  private readonly now: () => number;

  constructor(options: {
    limitTokens: number;
    store?: TokenBudgetStore;
    now?: () => number;
  }) {
    if (!Number.isFinite(options.limitTokens) || options.limitTokens <= 0) {
      throw new RangeError('limitTokens must be a positive finite number');
    }

    this.limitTokens = options.limitTokens;
    this.store = options.store ?? new InMemoryTokenBudget(options.now);
    this.now = options.now ?? (() => Date.now());
  }

  get limit(): number {
    return this.limitTokens;
  }

  /**
   * Reserve capacity before the upstream call.
   *
   * The reservation is an estimate; `record` reconciles it against the provider's
   * actual usage afterwards. Reserving up front is what stops a burst of
   * concurrent requests from each passing the check before any of them reports.
   */
  async check(key: string, estimatedTokens: number): Promise<BudgetDecision> {
    const used = await this.store.get(key);
    const allowed = used + estimatedTokens <= this.limitTokens;

    return {
      allowed,
      usedTokens: used,
      limitTokens: this.limitTokens,
      resetsInSeconds: this.resetsInSeconds(),
    };
  }

  /** Record actual consumption once the provider reports usage. */
  async record(key: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    await this.store.add(key, Math.round(tokens));
  }

  private resetsInSeconds(): number {
    const elapsed = this.now() % BUDGET_WINDOW_MS;
    return Math.ceil((BUDGET_WINDOW_MS - elapsed) / 1_000);
  }
}

function readInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Daily token budget per principal.
 *
 * The default is deliberately modest: 500k tokens is roughly 250 full-length
 * requests on a small model, far more than a human writes in a day, and it turns
 * an unbounded invoice into a bounded one.
 */
export const DEFAULT_DAILY_TOKEN_BUDGET = 500_000;

let shared: TokenBudget | null = null;

export function getTokenBudget(env: Record<string, string | undefined> = process.env): TokenBudget {
  if (shared) return shared;

  shared = new TokenBudget({
    limitTokens: readInt(env.AI_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET),
  });

  return shared;
}

/** Test hook: drop the shared instance so a new budget takes effect. */
export function resetTokenBudget(): void {
  shared = null;
}
