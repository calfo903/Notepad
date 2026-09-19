import {
  AIProvider,
  AIProviderError,
  ChatRequest,
  ProviderAbortedError,
  ProviderAuthError,
  ProviderId,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderUpstreamError,
  ProviderValidationError,
} from './types';
import { extractDelta, parseSSEStream, SSE_DONE } from './sse';

/**
 * Client adapter for the OpenRouter-backed Edge Function.
 *
 * The browser talks only to `/api/chat` on its own origin. It never sees the
 * provider key, never contacts openrouter.ai directly, and therefore cannot be
 * induced to leak credentials by a compromised page or extension.
 */

const ENDPOINT = '/api/chat';

/** Bound on note context per request; mirrors the backend's schema limit. */
const MAX_NOTE_CONTEXT = 2_000;

interface ApiErrorEnvelope {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
  };
}

function toProviderError(
  status: number,
  envelope: ApiErrorEnvelope | null,
  headers: Headers,
  providerId: ProviderId
): AIProviderError {
  const code = envelope?.error?.code ?? 'UNKNOWN';
  const message = envelope?.error?.message ?? `AI request failed with status ${status}`;

  switch (status) {
    case 401:
    case 403:
      return new ProviderAuthError(message, providerId, { code });
    case 429: {
      const retryAfter = Number.parseInt(headers.get('retry-after') ?? '0', 10);
      return new ProviderRateLimitError(
        message,
        providerId,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
        { code }
      );
    }
    case 400:
    case 422:
      return new ProviderValidationError(message, providerId, { code });
    case 499:
      return new ProviderAbortedError(message, providerId, { code });
    case 503:
      return new ProviderUnavailableError(message, providerId, { code });
    default:
      return new ProviderUpstreamError(message, providerId, { code });
  }
}

async function readErrorEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const text = await response.text();
    if (text.length === 0) return null;
    return JSON.parse(text) as ApiErrorEnvelope;
  } catch {
    return null;
  }
}

/** Adapt a Fetch body into the async iterable the SSE parser consumes. */
async function* byteChunks(response: Response): AsyncGenerator<Uint8Array, void, undefined> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ProviderAbortedError('Request was cancelled.', 'openrouter');
}

export class OpenRouterProvider implements AIProvider {
  readonly id: ProviderId = 'openrouter';
  readonly label = 'NoteFlow AI';

  private readonly model: string | undefined;

  constructor(model?: string) {
    this.model = model && model.length > 0 ? model : undefined;
  }

  /** Always available: the endpoint is same-origin and requires no client secret. */
  get isAvailable(): boolean {
    return typeof window !== 'undefined';
  }

  private async send(request: ChatRequest, stream: boolean): Promise<Response> {
    assertNotAborted(request.signal);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: request.signal,
        body: JSON.stringify({
          messages: request.messages,
          stream,
          // Body field, not a header: header values cannot contain newlines, and
          // note bodies are inherently multi-line.
          ...(request.noteContext
            ? { noteContext: request.noteContext.slice(0, MAX_NOTE_CONTEXT) }
            : {}),
          ...(this.model === undefined ? {} : { model: this.model }),
        }),
      });
    } catch (err) {
      if (request.signal?.aborted) {
        throw new ProviderAbortedError('Request was cancelled.', this.id, err);
      }
      throw new ProviderUnavailableError(
        'Could not reach the AI service. Check your connection.',
        this.id,
        err
      );
    }

    if (!response.ok) {
      throw toProviderError(response.status, await readErrorEnvelope(response), response.headers, this.id);
    }

    return response;
  }

  async complete(request: ChatRequest): Promise<string> {
    const response = await this.send(request, false);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new ProviderUpstreamError('AI service returned an unreadable response.', this.id, err);
    }

    const content = (payload as { content?: unknown } | null)?.content;
    return typeof content === 'string' ? content : '';
  }

  async *stream(request: ChatRequest): AsyncGenerator<string, void, undefined> {
    const response = await this.send(request, true);

    const contentType = response.headers.get('content-type') ?? '';

    // Backend degrades to JSON when the provider refuses to stream.
    if (!contentType.includes('text/event-stream')) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (err) {
        throw new ProviderUpstreamError('AI service returned an unreadable response.', this.id, err);
      }
      const content = (payload as { content?: unknown } | null)?.content;
      if (typeof content === 'string' && content.length > 0) yield content;
      return;
    }

    for await (const event of parseSSEStream(byteChunks(response))) {
      assertNotAborted(request.signal);

      if (event.event === 'error') {
        let envelope: ApiErrorEnvelope | null = null;
        try {
          envelope = JSON.parse(event.data) as ApiErrorEnvelope;
        } catch {
          envelope = null;
        }
        throw new ProviderUpstreamError(
          envelope?.error?.message ?? 'The AI response was interrupted.',
          this.id,
          envelope
        );
      }

      if (event.data === SSE_DONE) return;

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // Keep-alive comment or partial frame; skipping is correct per spec.
        continue;
      }

      const delta = extractDelta(payload);
      if (delta.length > 0) yield delta;
    }
  }
}
