/**
 * Redis-backed token bucket for globally consistent rate limiting.
 *
 * The in-memory limiter in `rateLimit.ts` is per-isolate, so a deployment with N
 * warm isolates effectively allows `N x configured` requests. This closes that
 * gap by keeping the bucket in Redis, where every isolate reads the same state.
 *
 * Uses the Upstash REST API rather than a TCP client: Edge Functions have no raw
 * sockets, and a `fetch` to Redis works on Vercel, Cloudflare and Node alike.
 *
 * **Failure mode is a deliberate choice.** If Redis is unreachable the limiter
 * falls back to the local bucket and logs an alert, so a Redis outage degrades
 * enforcement instead of taking the product down. Set `RATE_LIMIT_FAIL_OPEN=false`
 * to fail closed instead — appropriate when the rate limit is load-bearing for
 * cost, at the price of an outage whenever Redis is down.
 */

import { RateLimiter, type RateLimitDecision } from './rateLimit';
import { emitAlert } from './alerting';

/** Keyed array returned by the Lua script: `[allowed, tokens * 1000]`. */
type ScriptReply = [number, number];

/**
 * Token bucket in one round trip.
 *
 * Done in Lua rather than a read-modify-write from the client because two
 * concurrent requests would otherwise both read the same token count and both
 * succeed — which is exactly the race this exists to prevent.
 */
const TOKEN_BUCKET_LUA = `
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill   = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local cost     = tonumber(ARGV[4])
local ttl      = tonumber(ARGV[5])

local stored = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(stored[1])
local ts     = tonumber(stored[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
end

redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', key, ttl)

-- Scaled to integers: Redis returns Lua floats as strings and precision is lost
-- in transit. Three decimal places of a token is more than enough.
return { allowed, math.floor(tokens * 1000) }
`;

export interface RedisRateLimiterOptions {
  readonly url: string;
  readonly token: string;
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Fail open (degrade to local) or fail closed (deny) when Redis is unreachable. */
  readonly failOpen: boolean;
  /** Local limiter used as the fallback. */
  readonly fallback: RateLimiter;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

export class RedisRateLimiter {
  private readonly options: RedisRateLimiterOptions;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  /** Stops the alert firing on every single request during an outage. */
  private degradedSince: number | undefined;

  constructor(options: RedisRateLimiterOptions) {
    if (!options.url) throw new RangeError('url is required');
    if (!options.token) throw new RangeError('token is required');

    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Keys are prefixed so this limiter can share a database with other state. */
  static keyFor(bucketKey: string): string {
    return `noteflow:rl:${bucketKey}`;
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    // failOpen and fallback are read inside `degrade`, from this.options, so
    // they are deliberately not destructured here.
    const { capacity, refillPerSecond } = this.options;

    try {
      const reply = await this.eval(key, cost);
      this.clearDegraded();

      const allowed = reply[0] === 1;
      const tokens = reply[1] / 1_000;
      const deficit = allowed ? 0 : cost - tokens;

      return {
        allowed,
        remaining: Math.max(0, Math.floor(tokens)),
        limit: capacity,
        retryAfterSeconds: allowed ? 0 : Math.ceil(deficit / refillPerSecond),
      };
    } catch (error) {
      return this.degrade(key, cost, error);
    }
  }

  private async eval(key: string, cost: number): Promise<ScriptReply> {
    const { url, token, capacity, refillPerSecond } = this.options;

    // Long enough to outlive a full refill of an idle bucket, so cold keys do not
    // accumulate forever.
    const ttlSeconds = Math.ceil((capacity / refillPerSecond) * 2) + 60;

    const response = await this.fetchImpl(`${url.replace(/\/$/, '')}/eval`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        script: TOKEN_BUCKET_LUA,
        keys: [RedisRateLimiter.keyFor(key)],
        args: [
          String(capacity),
          String(refillPerSecond),
          String(this.now()),
          String(cost),
          String(ttlSeconds),
        ],
      }),
      // A limiter that waits longer than the request it is protecting is worse
      // than no limiter at all.
      signal: AbortSignal.timeout(1_000),
    });

    if (!response.ok) {
      throw new Error(`redis ${response.status}: ${(await response.text()).slice(0, 160)}`);
    }

    const payload = (await response.json()) as { result?: unknown; error?: string };
    if (payload.error) throw new Error(`redis: ${payload.error}`);

    const result = payload.result;
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error(`unexpected redis reply: ${JSON.stringify(result)}`);
    }

    return [Number(result[0]), Number(result[1])];
  }

  private degrade(key: string, cost: number, error: unknown): RateLimitDecision {
    const message = error instanceof Error ? error.message : String(error);

    // Alert once per outage rather than once per request.
    if (this.degradedSince === undefined) {
      this.degradedSince = this.now();
      emitAlert('rate_limit_store_unavailable', {
        message: 'Falling back to isolate-local rate limiting.',
        reason: message,
        failOpen: this.options.failOpen,
      });
    }

    if (!this.options.failOpen) {
      return {
        allowed: false,
        remaining: 0,
        limit: this.options.capacity,
        // Do not claim a specific recovery time; the store, not the bucket, is
        // what is unavailable.
        retryAfterSeconds: 30,
      };
    }

    return this.options.fallback.consume(key, cost);
  }

  private clearDegraded(): void {
    if (this.degradedSince === undefined) return;

    emitAlert('rate_limit_store_recovered', {
      message: 'Redis rate limiting restored.',
      degradedForMs: this.now() - this.degradedSince,
    });
    this.degradedSince = undefined;
  }
}

export interface ResolvedLimiter {
  readonly limiter: RedisRateLimiter | undefined;
  readonly local: RateLimiter;
  /** One call site so the choice between backends lives in exactly one place. */
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
}

/**
 * Build whichever limiter the environment supports.
 *
 * With `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set, limits are
 * global. Without them the behaviour is unchanged from before this existed —
 * isolate-local — so adding the variables is an opt-in upgrade, not a migration.
 */
export function createRateLimiter(
  local: RateLimiter,
  env: Record<string, string | undefined> = process.env
): ResolvedLimiter {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();

  if (!url || !token) {
    return {
      limiter: undefined,
      local,
      consume: async (key, cost = 1) => local.consume(key, cost),
    };
  }

  const limiter = new RedisRateLimiter({
    url,
    token,
    capacity: Number(env.AI_RATE_LIMIT_CAPACITY ?? 20),
    refillPerSecond: Number(env.AI_RATE_LIMIT_PER_MINUTE ?? 20) / 60,
    // Fail open by default: an availability control should not become an
    // availability incident. Opt out explicitly if the limit guards spend.
    failOpen: env.RATE_LIMIT_FAIL_OPEN !== 'false',
    fallback: local,
  });

  return {
    limiter,
    local,
    consume: (key, cost = 1) => limiter.consume(key, cost),
  };
}
