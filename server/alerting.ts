/**
 * Alert emission.
 *
 * There is no metrics backend here, and adding one would be a deployment decision
 * rather than a code one. What this does instead is emit a **structured, greppable
 * line** at a level hosting platforms already alert on, so an operator can point
 * Vercel Log Drains, Datadog or a log-based alert at `"event":"alert"` and get
 * notified without this repository knowing which vendor was chosen.
 *
 * The two failure modes of a hand-rolled alerting layer are silence and floods.
 * Silence is worse, so the design errs toward emitting — but every alert name has
 * a cooldown, because an alert that fires on every request during an outage gets
 * muted, and a muted alert is silence with extra steps.
 */

/** Distinct conditions worth waking someone up for. */
export type AlertName =
  /** The upstream provider has failed enough times to trip the breaker. */
  | 'upstream_circuit_open'
  /** A principal exhausted their daily token budget. */
  | 'token_budget_exceeded'
  /** The shared rate-limit store is unreachable. */
  | 'rate_limit_store_unavailable'
  /** The shared rate-limit store came back. */
  | 'rate_limit_store_recovered'
  /** A request was rejected for exceeding the aggregate input ceiling. */
  | 'oversized_request_rejected'
  /** A caller asked for a model outside the allowlist. */
  | 'model_not_allowed';

export interface AlertRecord {
  readonly level: 'error';
  readonly event: 'alert';
  readonly alert: AlertName;
  readonly timestamp: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type AlertSink = (record: AlertRecord) => void;

/** Default cooldown per alert name. Long enough that a storm stays readable. */
export const DEFAULT_ALERT_COOLDOWN_MS = 60_000;

// eslint-disable-next-line no-console
const defaultSink: AlertSink = (record) => console.log(JSON.stringify(record));

let sink: AlertSink = defaultSink;
let cooldownMs = DEFAULT_ALERT_COOLDOWN_MS;
let now: () => number = () => Date.now();
const lastEmitted = new Map<AlertName, number>();

/** Replace the sink. Used by tests and by any log-forwarding integration. */
export function setAlertSink(next: AlertSink): void {
  sink = next;
}

export function configureAlerting(options: {
  cooldownMs?: number;
  now?: () => number;
  sink?: AlertSink;
}): void {
  if (options.cooldownMs !== undefined) cooldownMs = options.cooldownMs;
  if (options.now) now = options.now;
  if (options.sink) sink = options.sink;
}

export function resetAlerting(): void {
  sink = defaultSink;
  cooldownMs = DEFAULT_ALERT_COOLDOWN_MS;
  now = () => Date.now();
  lastEmitted.clear();
}

/**
 * Emit an alert, suppressed if the same name fired within the cooldown.
 *
 * @returns whether a record was actually emitted, so callers can count
 * suppressions without inspecting the sink.
 */
export function emitAlert(
  name: AlertName,
  details: Readonly<Record<string, unknown>> = {}
): boolean {
  const timestamp = now();
  const previous = lastEmitted.get(name);

  if (previous !== undefined && timestamp - previous < cooldownMs) return false;

  lastEmitted.set(name, timestamp);

  const record: AlertRecord = {
    level: 'error',
    event: 'alert',
    alert: name,
    timestamp: new Date(timestamp).toISOString(),
    details,
  };

  try {
    sink(record);
  } catch {
    // A failing sink must never take down the request it is reporting on.
    // Falling back to the default keeps the signal even if the integration broke.
    // The fallback is guarded too: if stdout itself is broken there is nothing
    // left to do, and throwing from an alert path is strictly worse than losing
    // the alert.
    if (sink !== defaultSink) {
      try {
        defaultSink(record);
      } catch {
        // Deliberately swallowed.
      }
    }
  }

  return true;
}

/** Alerts suppressed by cooldown since the last reset. Useful in tests. */
export function alertCooldownState(): ReadonlyMap<AlertName, number> {
  return lastEmitted;
}
