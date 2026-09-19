import {
  chatRequestSchema,
  resolveModel,
  ModelNotAllowedError,
  DEFAULT_MAX_TOKENS,
  HARD_MAX_TOKENS,
} from './schema';
import { estimateTokens, getTokenBudget } from './costGuard';
import { parseUsage, UsageScanner, type TokenUsage } from './usage';
import {
  PROMPT_VERSION,
  createTraceId,
  hashPrincipal,
  logAiInteraction,
} from './aiLog';
import {
  CircuitBreaker,
  CircuitOpenError,
  backoffDelay,
  delay,
  getUpstreamBreaker,
} from './circuitBreaker';
import { parseFallbackModels } from './schema';
import { errorResponse } from './http';
import { hardenMessages } from './promptGuard';
import { clientIp, createLimiterFromEnv } from './rateLimit';
import { readSession, type SessionUser } from './session';
import { AuthError } from './googleAuth';

/**
 * Provider-agnostic chat endpoint.
 *
 * Written against Web standards only (Request/Response/fetch/Streams) so the
 * same module runs as a Vercel Edge Function and inside the Vite dev server.
 * The API key is read from the environment on every request and never appears
 * in a response, a log line, or the client bundle.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Base for jittered exponential backoff between upstream attempts. */
const RETRY_BASE_MS = 250;

const limiter = createLimiterFromEnv();

interface CombinedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

/** Link an external abort to a timeout without relying on AbortSignal.any. */
function combinedSignal(external: AbortSignal | null, timeoutMs: number): CombinedSignal {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new Error(`Upstream request exceeded ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort(external?.reason ?? new Error('Client aborted'));
  };

  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * Relay an upstream SSE body to the client. A TransformStream is used rather
 * than a direct body passthrough so a mid-stream upstream failure is converted
 * into a well-formed `event: error` the client can surface instead of a
 * silently truncated response.
 */
/**
 * Relay the upstream SSE body to the client while tapping it for usage.
 *
 * Bytes are forwarded verbatim — the tap is read-only, so a malformed usage
 * frame can never corrupt the response the user sees.
 */
function relaySSE(
  upstreamBody: ReadableStream<Uint8Array>,
  onUsage?: (usage: TokenUsage) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const reader = upstreamBody.getReader();
  const scanner = new UsageScanner();

  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        const usage = scanner.push(value);
        if (usage) onUsage?.(usage);

        await writer.write(value);
      }

      const trailing = scanner.end();
      if (trailing) onUsage?.(trailing);

      await writer.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upstream stream terminated unexpectedly';
      const frame = `event: error\ndata: ${JSON.stringify({
        error: { code: 'UPSTREAM_STREAM_ERROR', message },
      })}\n\n`;

      try {
        await writer.write(encoder.encode(frame));
        await writer.close();
      } catch {
        // Client already disconnected; nothing to notify.
      }
    }
  })();

  return transform.readable;
}

function extractCompletionText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';

  const message = (choices[0] as { message?: unknown } | null)?.message;
  if (typeof message !== 'object' || message === null) return '';

  const content = (message as { content?: unknown }).content;

  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string'
          ? ((part as { text: string }).text)
          : ''
      )
      .join('');
  }

  return '';
}

function upstreamStatusToCode(status: number): { code: string; status: number } {
  if (status === 401 || status === 403) return { code: 'UPSTREAM_AUTH_FAILED', status: 502 };
  if (status === 429) return { code: 'UPSTREAM_RATE_LIMITED', status: 429 };
  if (status >= 500) return { code: 'UPSTREAM_UNAVAILABLE', status: 502 };
  return { code: 'UPSTREAM_REJECTED', status: 502 };
}

/**
 * Outcome metadata, threaded through the handler so every return path can be
 * logged without each one having to remember to.
 */
interface RequestMeta {
  principal?: string;
  model?: string;
  stream?: boolean;
  inputChars?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  errorCode?: string;
}

/**
 * Public entry point: assigns a trace id, times the request, logs one structured
 * line, and stamps the trace id onto the response so a user report can be tied
 * to a log entry.
 *
 * Logging wraps rather than lives inside the handler so an unexpected throw
 * still produces a record.
 */
export async function handleChat(request: Request): Promise<Response> {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const meta: RequestMeta = {};

  let response: Response;
  try {
    response = await handleChatInternal(request, traceId, meta);
  } catch (err) {
    meta.errorCode = 'INTERNAL';
    // The original message goes to the operator, not the client.
    console.error('[api/chat] unhandled error:', err instanceof Error ? err.message : err);
    response = errorResponse(500, 'INTERNAL', 'Unexpected error handling the request.');
  }

  logAiInteraction({
    traceId,
    principal: meta.principal ?? 'anon',
    model: meta.model ?? 'unknown',
    promptVersion: PROMPT_VERSION,
    stream: meta.stream ?? false,
    inputChars: meta.inputChars ?? 0,
    inputTokens: meta.inputTokens ?? null,
    outputTokens: meta.outputTokens ?? null,
    totalTokens: meta.totalTokens ?? null,
    latencyMs: Date.now() - startedAt,
    status: response.status,
    ...(meta.errorCode === undefined ? {} : { errorCode: meta.errorCode }),
  });

  response.headers.set('x-trace-id', traceId);
  return response;
}

type UpstreamAttempt =
  | { readonly kind: 'ok'; readonly response: Response }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unreachable'; readonly message: string }
  | { readonly kind: 'open'; readonly retryAfterMs: number };

/**
 * Call the provider with one bounded retry.
 *
 * Retries only what can plausibly succeed on a second try: a network failure or
 * a 5xx/429. A 4xx is the client's or our own mistake and retrying it just
 * doubles the bill. Nothing is retried once a stream has begun, because the
 * caller cannot un-see the bytes already delivered.
 */
async function callUpstream(
  payload: unknown,
  apiKey: string,
  traceId: string,
  signal: AbortSignal,
  breaker: CircuitBreaker,
  attempts = 2,
  sleep: (ms: number) => Promise<void> = delay,
  random: () => number = Math.random
): Promise<UpstreamAttempt> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      breaker.enter();
    } catch (err) {
      if (err instanceof CircuitOpenError) return { kind: 'open', retryAfterMs: err.retryAfterMs };
      throw err;
    }

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          // OpenRouter attribution headers; site is optional but improves routing.
          'HTTP-Referer': process.env.APP_BASE_URL ?? 'https://noteflow.local',
          'X-Title': 'NoteFlow AI',
          // Correlates our log line with the provider's own request record.
          'X-Request-Id': traceId,
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (response.ok) {
        breaker.succeed();
        return { kind: 'ok', response };
      }

      // 5xx and 429 are transient; anything else is a permanent rejection.
      const retryable = response.status >= 500 || response.status === 429;
      breaker.fail();

      if (!retryable || attempt === attempts - 1) return { kind: 'ok', response };

      await sleep(backoffDelay(attempt, RETRY_BASE_MS, random));
    } catch (err) {
      if (signal.aborted) return { kind: 'aborted' };

      breaker.fail();
      const message = err instanceof Error ? err.message : 'Upstream request failed';

      if (attempt === attempts - 1) return { kind: 'unreachable', message };
      await sleep(backoffDelay(attempt, RETRY_BASE_MS, random));
    }
  }

  // Unreachable: the loop always returns on its final iteration.
  return { kind: 'unreachable', message: 'Upstream attempts exhausted' };
}

async function handleChatInternal(
  request: Request,
  traceId: string,
  meta: RequestMeta
): Promise<Response> {
  /** errorResponse wrapper that records the code for the log line. */
  const fail = (
    status: number,
    code: string,
    message: string,
    details?: unknown,
    headers: Record<string, string> = {}
  ): Response => {
    meta.errorCode = code;
    return errorResponse(status, code, message, details, headers);
  };

  if (request.method !== 'POST') {
    return fail(405, 'METHOD_NOT_ALLOWED', 'Only POST is accepted.', undefined, {
      Allow: 'POST',
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    // Fail loudly. There is deliberately no embedded fallback key.
    console.error('[api/chat] OPENROUTER_API_KEY is not configured');
    return fail(
      503,
      'PROVIDER_NOT_CONFIGURED',
      'The AI provider is not configured on this deployment. Set OPENROUTER_API_KEY.'
    );
  }

  // Authenticated users are limited per account, so a shared NAT or a mobile
  // carrier IP cannot let one person exhaust everyone else's quota.
  let user: SessionUser | null = null;
  try {
    user = await readSession(request);
  } catch (err) {
    if (err instanceof AuthError) return fail(err.status, err.code, err.message);
    throw err;
  }

  // Secure by default. Anonymous AI use is keyed by IP, which a rotating
  // attacker trivially multiplies, so it must be opted into explicitly rather
  // than being the state a forgotten env var leaves you in.
  if (!user && process.env.REQUIRE_AUTH_FOR_AI !== 'false') {
    return fail(401, 'AUTH_REQUIRED', 'Sign in to use the AI assistant.', undefined, {
      'www-authenticate': 'Cookie',
    });
  }

  // Hashed so the log can be correlated per user without holding identifiers.
  meta.principal = user ? await hashPrincipal(user.sub) : 'anon';

  const bucketKey = user ? `user:${user.sub}` : `ip:${clientIp(request)}`;
  const decision = limiter.consume(bucketKey);
  const limitHeaders: Record<string, string> = {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(decision.remaining),
    'x-ratelimit-scope': user ? 'user' : 'ip',
  };

  if (!decision.allowed) {
    return fail(
      429,
      'RATE_LIMITED',
      `Too many AI requests. Try again in ${decision.retryAfterSeconds}s.`,
      undefined,
      { ...limitHeaders, 'retry-after': String(decision.retryAfterSeconds) }
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, 'INVALID_JSON', 'Request body is not valid JSON.', undefined, limitHeaders);
  }

  const parsed = chatRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      400,
      'VALIDATION_FAILED',
      'Request body failed schema validation.',
      parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
      limitHeaders
    );
  }

  const body = parsed.data;

  let model: string;
  try {
    model = resolveModel(body.model);
  } catch (err) {
    if (err instanceof ModelNotAllowedError) {
      return fail(403, 'MODEL_NOT_ALLOWED', err.message, undefined, limitHeaders);
    }
    throw err;
  }

  const messages = hardenMessages(body.messages, body.noteContext);

  meta.model = model;
  meta.stream = body.stream;
  meta.inputChars = messages.reduce((sum, message) => sum + message.content.length, 0);

  // Output length is always set server-side. Omitting it defers to the provider
  // default, which is not a control we own.
  const maxTokens = Math.min(body.maxTokens ?? DEFAULT_MAX_TOKENS, HARD_MAX_TOKENS);

  const upstreamPayload = {
    model,
    // OpenRouter routes to the first available model in `models` when the
    // primary is unavailable, so an outage on one model does not take the
    // feature down. See DEVELOPMENT.md for the caveat on this parameter.
    ...(() => {
      const fallbacks = parseFallbackModels(model);
      return fallbacks.length > 0 ? { models: [model, ...fallbacks] } : {};
    })(),
    messages,
    stream: body.stream,
    ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
    max_tokens: maxTokens,
    // Without this the provider reports no usage on streamed calls, and cost
    // accounting would be blind for the majority of traffic.
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
  };

  // Reserve against the daily token budget before spending. The estimate covers
  // input plus the worst-case output; `record` reconciles it afterwards.
  const breaker = getUpstreamBreaker();
  const budget = getTokenBudget();
  const estimatedInput = estimateTokens(meta.inputChars);
  const budgetDecision = await budget.check(bucketKey, estimatedInput + maxTokens);

  if (!budgetDecision.allowed) {
    return fail(
      429,
      'BUDGET_EXCEEDED',
      `Daily AI token budget exhausted. Resets in ${Math.ceil(budgetDecision.resetsInSeconds / 3600)}h.`,
      undefined,
      {
        ...limitHeaders,
        'retry-after': String(budgetDecision.resetsInSeconds),
        'x-tokenbudget-limit': String(budgetDecision.limitTokens),
        'x-tokenbudget-used': String(budgetDecision.usedTokens),
      }
    );
  }

  /** Record real usage against the budget, once, whichever path reports it. */
  let usageRecorded = false;
  const recordUsage = (usage: TokenUsage): void => {
    if (usageRecorded) return;
    usageRecorded = true;

    meta.inputTokens = usage.promptTokens;
    meta.outputTokens = usage.completionTokens;
    meta.totalTokens = usage.totalTokens;

    void budget.record(bucketKey, usage.totalTokens);
  };

  const linked = combinedSignal(request.signal, UPSTREAM_TIMEOUT_MS);

  const attempt = await callUpstream(upstreamPayload, apiKey, traceId, linked.signal, breaker);

  if (attempt.kind === 'open') {
    linked.dispose();
    return fail(
      503,
      'PROVIDER_CIRCUIT_OPEN',
      'The AI provider is temporarily unavailable. Try again shortly.',
      undefined,
      { ...limitHeaders, 'retry-after': String(Math.ceil(attempt.retryAfterMs / 1_000)) }
    );
  }

  if (attempt.kind === 'aborted') {
    linked.dispose();
    return fail(499, 'CLIENT_ABORTED', 'Request was cancelled.', undefined, limitHeaders);
  }

  if (attempt.kind === 'unreachable') {
    linked.dispose();
    console.error('[api/chat] upstream fetch failed:', attempt.message);
    return fail(502, 'UPSTREAM_UNREACHABLE', 'Could not reach the AI provider.', undefined, limitHeaders);
  }

  const upstream = attempt.response;

  if (!upstream.ok) {
    linked.dispose();
    const mapped = upstreamStatusToCode(upstream.status);
    let detail = `Provider returned ${upstream.status}`;
    try {
      const text = await upstream.text();
      const json: unknown = text.length > 0 ? JSON.parse(text) : null;
      const nested = (json as { error?: { message?: unknown } } | null)?.error?.message;
      if (typeof nested === 'string' && nested.length > 0) detail = nested;
    } catch {
      // Non-JSON upstream error body; the status line is sufficient.
    }

    return fail(mapped.status, mapped.code, detail, undefined, limitHeaders);
  }

  if (body.stream && upstream.body !== null) {
    const contentType = upstream.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // Dispose the timeout once streaming starts: total stream duration is
      // bounded by the client's own abort, not by our connect timeout.
      linked.dispose();

      return new Response(relaySSE(upstream.body, recordUsage), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...limitHeaders,
        },
      });
    }

    // Provider ignored stream:true; degrade to a single JSON payload.
    try {
      const payload: unknown = await upstream.json();
      linked.dispose();
      const usage = parseUsage(payload);
      if (usage) recordUsage(usage);
      return new Response(JSON.stringify({ content: extractCompletionText(payload), model }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', ...limitHeaders },
      });
    } catch {
      linked.dispose();
      return fail(502, 'UPSTREAM_MALFORMED', 'Provider returned an unreadable response.', undefined, limitHeaders);
    }
  }

  try {
    const payload: unknown = await upstream.json();
    linked.dispose();
    const usage = parseUsage(payload);
    if (usage) recordUsage(usage);
    return new Response(JSON.stringify({ content: extractCompletionText(payload), model }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', ...limitHeaders },
    });
  } catch {
    linked.dispose();
    return fail(502, 'UPSTREAM_MALFORMED', 'Provider returned an unreadable response.', undefined, limitHeaders);
  }
}
