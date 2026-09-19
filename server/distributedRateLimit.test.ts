// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RedisRateLimiter,
  createRateLimiter,
} from './distributedRateLimit';
import { RateLimiter } from './rateLimit';
import { resetAlerting, setAlertSink, type AlertRecord } from './alerting';

function localLimiter(): RateLimiter {
  return new RateLimiter({ capacity: 5, refillPerSecond: 1, sweepIntervalMs: 30_000 });
}

// The parameter has to accept everything `typeof fetch` accepts, or the mock is
// not assignable to the option it stands in for.
function redisFetcher(result: unknown) {
  return vi.fn(
    async (_input: URL | RequestInfo, _init?: RequestInit): Promise<Response> =>
      new Response(JSON.stringify({ result }), { status: 200 })
  );
}

function makeLimiter(overrides: Partial<ConstructorParameters<typeof RedisRateLimiter>[0]> = {}) {
  return new RedisRateLimiter({
    url: 'https://redis.test',
    token: 'token',
    capacity: 10,
    refillPerSecond: 1,
    failOpen: true,
    fallback: localLimiter(),
    ...overrides,
  });
}

describe('RedisRateLimiter', () => {
  let alerts: AlertRecord[] = [];

  beforeEach(() => {
    resetAlerting();
    alerts = [];
    setAlertSink((record) => alerts.push(record));
  });

  afterEach(() => resetAlerting());

  it('allows a request the script says is allowed', async () => {
    const limiter = makeLimiter({ fetchImpl: redisFetcher([1, 9_000]) });

    const decision = await limiter.consume('user:1');

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(9);
    expect(decision.limit).toBe(10);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it('denies and computes retry-after from the deficit', async () => {
    // 0.5 tokens left, asking for 1, refilling 1/second -> 1 second.
    const limiter = makeLimiter({ fetchImpl: redisFetcher([0, 500]) });

    const decision = await limiter.consume('user:1');

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('namespaces keys so the limiter can share a database', async () => {
    expect(RedisRateLimiter.keyFor('user:42')).toBe('noteflow:rl:user:42');
  });

  it('sends the bucket parameters to the script', async () => {
    const fetchImpl = redisFetcher([1, 10_000]);
    const limiter = makeLimiter({ fetchImpl, capacity: 20, refillPerSecond: 2 });

    await limiter.consume('ip:1.2.3.4');

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as {
      keys: string[];
      args: string[];
    };

    expect(body.keys).toEqual(['noteflow:rl:ip:1.2.3.4']);
    expect(body.args[0]).toBe('20'); // capacity
    expect(body.args[1]).toBe('2'); // refill per second
    expect(body.args[3]).toBe('1'); // cost
  });

  it('caps the Redis call so a slow store cannot outlast the request', async () => {
    const fetchImpl = redisFetcher([1, 10_000]);
    const limiter = makeLimiter({ fetchImpl });

    await limiter.consume('user:1');

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to the local bucket when Redis is down and fail-open is set', async () => {
    const fallback = localLimiter();
    const limiter = makeLimiter({
      fetchImpl: vi.fn(async (): Promise<Response> => new Response('boom', { status: 500 })),
      
      failOpen: true,
      fallback,
    });

    const decision = await limiter.consume('user:1');

    // Local bucket has capacity 5, so this succeeds.
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(5);
    expect(fallback.size).toBe(1);
  });

  it('denies when Redis is down and fail-open is off', async () => {
    const fallback = localLimiter();
    const limiter = makeLimiter({
      fetchImpl: vi.fn(async (): Promise<Response> => new Response('boom', { status: 500 })),
      
      failOpen: false,
      fallback,
    });

    const decision = await limiter.consume('user:1');

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(30);
    // The local bucket must not be consulted, or the operator's choice is a lie.
    expect(fallback.size).toBe(0);
  });

  it('alerts once per outage rather than once per request', async () => {
    const limiter = makeLimiter({
      fetchImpl: vi.fn(async (): Promise<Response> => new Response('boom', { status: 503 })),
    });

    await limiter.consume('user:1');
    await limiter.consume('user:2');
    await limiter.consume('user:3');

    expect(alerts.filter((a) => a.alert === 'rate_limit_store_unavailable')).toHaveLength(1);
  });

  it('alerts on recovery and says how long it was degraded', async () => {
    let clock = 1_000;
    let failing = true;

    const limiter = makeLimiter({
      now: () => clock,
      fetchImpl: vi.fn(
        async (): Promise<Response> =>
          failing
            ? new Response('down', { status: 503 })
            : new Response(JSON.stringify({ result: [1, 10_000] }), { status: 200 })
      ),
    });

    await limiter.consume('user:1');
    expect(alerts.map((a) => a.alert)).toEqual(['rate_limit_store_unavailable']);

    failing = false;
    clock += 5_000;
    await limiter.consume('user:1');

    const recovered = alerts.find((a) => a.alert === 'rate_limit_store_recovered');
    expect(recovered).toBeDefined();
    expect(recovered?.details.degradedForMs).toBe(5_000);
  });

  it('treats a Redis-level error payload as a failure, not a decision', async () => {
    const limiter = makeLimiter({
      fetchImpl: vi.fn(
        async (): Promise<Response> =>
          new Response(JSON.stringify({ error: 'NOSCRIPT' }), { status: 200 })
      ),
    });

    const decision = await limiter.consume('user:1');

    // Fell through to the local bucket, which allows.
    expect(decision.limit).toBe(5);
    expect(alerts[0]?.alert).toBe('rate_limit_store_unavailable');
  });

  it('rejects a malformed reply instead of guessing', async () => {
    const limiter = makeLimiter({ fetchImpl: redisFetcher({ unexpected: true }) });

    const decision = await limiter.consume('user:1');

    expect(decision.limit).toBe(5); // degraded to local
  });

  it('requires a url and token', () => {
    expect(() => makeLimiter({ url: '' })).toThrow(RangeError);
    expect(() => makeLimiter({ token: '' })).toThrow(RangeError);
  });
});

describe('createRateLimiter', () => {
  beforeEach(() => resetAlerting());
  afterEach(() => resetAlerting());

  it('uses the local bucket when no Redis is configured', async () => {
    const local = localLimiter();
    const resolved = createRateLimiter(local, {});

    expect(resolved.limiter).toBeUndefined();

    const decision = await resolved.consume('user:1');
    expect(decision.limit).toBe(5);
    expect(local.size).toBe(1);
  });

  it('uses Redis when both variables are present', async () => {
    const resolved = createRateLimiter(localLimiter(), {
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      AI_RATE_LIMIT_CAPACITY: '3',
    });

    expect(resolved.limiter).toBeInstanceOf(RedisRateLimiter);
  });

  it('ignores a half-configured Redis rather than half-working', () => {
    const resolved = createRateLimiter(localLimiter(), {
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
    });

    expect(resolved.limiter).toBeUndefined();
  });

  it('fails open unless told otherwise', () => {
    const env = {
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    };

    expect(
      (createRateLimiter(localLimiter(), env).limiter as RedisRateLimiter)
    ).toBeInstanceOf(RedisRateLimiter);

    const closed = createRateLimiter(localLimiter(), { ...env, RATE_LIMIT_FAIL_OPEN: 'false' });
    expect(closed.limiter).toBeDefined();
  });
});
