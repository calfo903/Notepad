/**
 * AI provider contract.
 *
 * `useAI` depends on this interface only. Adding a provider means implementing
 * it and registering it in `registry.ts`; no component or hook changes.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[];
  /** Cancellation; providers must stop yielding and reject with ProviderAbortedError. */
  readonly signal?: AbortSignal;
  /** Current note body, forwarded for context. Never trusted by the backend. */
  readonly noteContext?: string;
}

export type ProviderId = 'openrouter' | 'puter';

/**
 * Base class for every provider failure. Callers can `catch (e)` and switch on
 * `e instanceof` to distinguish "retry later" from "your key is wrong" without
 * string-matching messages.
 */
export abstract class AIProviderError extends Error {
  readonly providerId: ProviderId;
  readonly detail: unknown;
  /** True when a retry with the same input could plausibly succeed. */
  abstract readonly retryable: boolean;

  constructor(message: string, providerId: ProviderId, detail?: unknown) {
    super(message);
    this.name = new.target.name;
    this.providerId = providerId;
    this.detail = detail;
    // Restores the prototype chain for classes extending built-ins under ES5 emit.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ProviderUnavailableError extends AIProviderError {
  readonly retryable = false;
}

export class ProviderAuthError extends AIProviderError {
  readonly retryable = false;
}

export class ProviderRateLimitError extends AIProviderError {
  readonly retryable = true;
  readonly retryAfterSeconds: number;

  constructor(message: string, providerId: ProviderId, retryAfterSeconds = 0, detail?: unknown) {
    super(message, providerId, detail);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ProviderValidationError extends AIProviderError {
  readonly retryable = false;
}

export class ProviderUpstreamError extends AIProviderError {
  readonly retryable = true;
}

export class ProviderAbortedError extends AIProviderError {
  readonly retryable = false;
}

export interface AIProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** False when a hard prerequisite is missing (SDK not loaded, no endpoint). */
  readonly isAvailable: boolean;
  /** Single-shot completion. Returns the full response text. */
  complete(request: ChatRequest): Promise<string>;
  /** Streaming completion. Yields text deltas in arrival order. */
  stream(request: ChatRequest): AsyncIterable<string>;
}
