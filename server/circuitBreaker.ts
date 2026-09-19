/**
 * Circuit breaker.
 *
 * Without one, a dead upstream turns every request into a full timeout: users
 * wait 60s to be told it failed, and each waiting request holds an isolate. The
 * breaker converts that into an immediate, honest failure and gives the upstream
 * room to recover.
 *
 * Three states:
 *   closed    — requests flow; consecutive failures are counted
 *   open      — requests are rejected immediately until the cooldown elapses
 *   half-open — a single probe is allowed through; success closes, failure reopens
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures that trip the breaker. */
  readonly failureThreshold: number;
  /** How long the breaker stays open before probing, in ms. */
  readonly cooldownMs: number;
  readonly now?: () => number;
}

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Circuit is open; retry in ${Math.ceil(retryAfterMs / 1_000)}s.`);
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, CircuitOpenError.prototype);
  }
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;

  constructor(options: Partial<BreakerOptions> = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());

    if (this.failureThreshold < 1) throw new RangeError('failureThreshold must be at least 1');
    if (this.cooldownMs < 0) throw new RangeError('cooldownMs must not be negative');
  }

  get currentState(): BreakerState {
    // An open breaker whose cooldown has elapsed is half-open, so reads reflect
    // the state the next request will actually see.
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      return 'half-open';
    }
    return this.state;
  }

  /**
   * Claim permission to make a call.
   *
   * Throws CircuitOpenError while open. In half-open, exactly one probe is
   * admitted; concurrent callers are refused rather than all being let through,
   * which is what would otherwise stampede a recovering upstream.
   */
  enter(): void {
    const state = this.currentState;

    if (state === 'closed') return;

    if (state === 'half-open') {
      if (this.probeInFlight) throw new CircuitOpenError(this.cooldownMs);
      this.probeInFlight = true;
      return;
    }

    throw new CircuitOpenError(this.cooldownMs - (this.now() - this.openedAt));
  }

  /** Record a successful call. Closes the breaker and clears the failure count. */
  succeed(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  /** Record a failed call. Trips the breaker once the threshold is reached. */
  fail(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;

    if (this.state === 'half-open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  /** Reset to closed. Exposed for tests and manual recovery. */
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.openedAt = 0;
  }
}

/**
 * Jittered exponential backoff.
 *
 * Full jitter — a random value in [0, base * 2^attempt] — because synchronised
 * retries from many clients are what turn a brownout into an outage.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  random: () => number = Math.random
): number {
  const ceiling = baseMs * 2 ** Math.max(0, attempt);
  return Math.round(random() * ceiling);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shared: CircuitBreaker | null = null;

export function getUpstreamBreaker(): CircuitBreaker {
  if (shared) return shared;
  shared = new CircuitBreaker();
  return shared;
}

/** Test hook. */
export function resetUpstreamBreaker(): void {
  shared = null;
}
