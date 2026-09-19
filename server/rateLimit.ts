/**
 * In-memory sliding token bucket.
 *
 * Scope: a single Edge isolate / Node process. It is a real limiter for the
 * common case (one deployment region, burst abuse from a single client) but it
 * is NOT globally consistent \u2014 two isolates hold independent buckets. For
 * multi-region enforcement swap `RateLimiter` for a Redis/Upstash-backed
 * implementation behind the same interface; nothing else changes.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiterOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly sweepIntervalMs: number;
  readonly now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private lastSweep: number;

  constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new RangeError('capacity must be a positive finite number');
    }
    if (!Number.isFinite(options.refillPerSecond) || options.refillPerSecond <= 0) {
      throw new RangeError('refillPerSecond must be a positive finite number');
    }

    this.capacity = options.capacity;
    this.refillPerSecond = options.refillPerSecond;
    this.sweepIntervalMs = options.sweepIntervalMs;
    this.now = options.now ?? (() => Date.now());
    this.lastSweep = this.now();
  }

  /**
   * Consume one token for `key`. Refill is computed lazily from elapsed time,
   * so there is no per-key timer and no background work between requests.
   */
  consume(key: string, cost = 1): RateLimitDecision {
    if (!Number.isInteger(cost) || cost <= 0) {
      throw new RangeError('cost must be a positive integer');
    }

    const timestamp = this.now();
    this.sweep(timestamp);

    const existing = this.buckets.get(key);
    const elapsedSeconds = existing ? Math.max(0, (timestamp - existing.updatedAt) / 1_000) : 0;

    const refilled = existing
      ? Math.min(this.capacity, existing.tokens + elapsedSeconds * this.refillPerSecond)
      : this.capacity;

    const allowed = refilled >= cost;
    const tokens = allowed ? refilled - cost : refilled;

    this.buckets.set(key, { tokens, updatedAt: timestamp });

    const deficit = allowed ? 0 : cost - refilled;
    const retryAfterSeconds = allowed ? 0 : Math.ceil(deficit / this.refillPerSecond);

    return {
      allowed,
      remaining: Math.max(0, Math.floor(tokens)),
      limit: this.capacity,
      retryAfterSeconds,
    };
  }

  /**
   * Evict buckets that have refilled to capacity. Without this the map grows
   * without bound under a rotating-IP attack and leaks memory on a long-lived
   * isolate.
   */
  private sweep(timestamp: number): void {
    if (timestamp - this.lastSweep < this.sweepIntervalMs) return;
    this.lastSweep = timestamp;

    const refillWindowMs = (this.capacity / this.refillPerSecond) * 1_000;

    for (const [key, bucket] of this.buckets) {
      if (timestamp - bucket.updatedAt >= refillWindowMs) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys. Exposed for tests and observability. */
  get size(): number {
    return this.buckets.size;
  }

  clear(): void {
    this.buckets.clear();
  }
}

/**
 * Extract the client IP. Vercel sets `x-real-ip`; `x-forwarded-for` carries the
 * chain with the originating client first. Falls back to a shared bucket so an
 * unidentifiable client is limited rather than exempt.
 */
export function clientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

function readInt(name: string | undefined, fallback: number): number {
  const parsed = name === undefined ? Number.NaN : Number.parseInt(name, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the limiter from environment, defaulting to 20 requests per minute with
 * a burst of 20. Shared module-level instance so the Edge function reuses
 * buckets across warm invocations.
 */
export function createLimiterFromEnv(
  env: Record<string, string | undefined> = process.env
): RateLimiter {
  return new RateLimiter({
    capacity: readInt(env.AI_RATE_LIMIT_CAPACITY, 20),
    refillPerSecond: readInt(env.AI_RATE_LIMIT_PER_MINUTE, 20) / 60,
    sweepIntervalMs: 30_000,
  });
}
