/**
 * Structured logging for AI interactions.
 *
 * One JSON line per request, written to stdout so any log shipper can consume it
 * without a bespoke integration. The design constraint is that this must never
 * become the place note content leaks: prompts, completions and `noteContext`
 * are not fields on this record and there is no code path that adds them.
 *
 * Principal identifiers are salted hashes rather than raw Google `sub` values,
 * so logs can be correlated per user without becoming a copy of the user table.
 * The salt means the hash is not reversible from the log alone, and rotating it
 * breaks correlation across the rotation — which is the point.
 */

export interface AiLogEntry {
  readonly traceId: string;
  /** Hashed principal, or `anon`. */
  readonly principal: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly stream: boolean;
  readonly inputChars: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly latencyMs: number;
  readonly status: number;
  /** Present only on failure. A stable code, never an upstream message. */
  readonly errorCode?: string;
}

/** Bump when the guard text changes; makes a regression attributable. */
export const PROMPT_VERSION = 'guard.v1';

/**
 * Per-deployment salt. When unset a fixed value is used so local logs are still
 * stable; production should set LOG_SALT so hashes cannot be precomputed.
 */
function logSalt(env: Record<string, string | undefined> = process.env): string {
  return env.LOG_SALT?.trim() || 'noteflow-local-development-salt';
}

/** Stable, non-reversible-per-log identifier for a principal. */
export async function hashPrincipal(
  identifier: string,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const bytes = new TextEncoder().encode(`${logSalt(env)}:${identifier}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function createTraceId(): string {
  return crypto.randomUUID();
}

/**
 * Emit one structured log line.
 *
 * Serialisation is defensive: a throwing getter or a circular value must not
 * take the request down, so a failure to log degrades to a marker rather than
 * propagating.
 */
export function logAiInteraction(
  entry: AiLogEntry,
  // Structured logs go to stdout by design; this is the one sanctioned console use.
  // eslint-disable-next-line no-console
  sink: (line: string) => void = (line) => console.log(line)
): void {
  try {
    sink(JSON.stringify({ event: 'ai.request', ...entry }));
  } catch {
    sink(JSON.stringify({ event: 'ai.request', traceId: entry.traceId, errorCode: 'LOG_SERIALISATION_FAILED' }));
  }
}

/**
 * Redact a value for safe inclusion in a log.
 *
 * Exists so future fields have an obvious safe path. It truncates hard and
 * strips anything that looks like a delimiter or control sequence, so even a
 * field that should never have been logged cannot carry a payload.
 */
export function redact(value: string, maxChars = 200): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maxChars);
}
