import { z } from 'zod';

/**
 * Request contract for POST /api/chat.
 *
 * This is the trust boundary. The browser is hostile: every field is bounded so
 * a client cannot inflate token spend, smuggle an unexpected model, or submit a
 * payload the upstream provider would reject with a confusing 4xx.
 */

export const chatRoleSchema = z.enum(['system', 'user', 'assistant']);

export const chatMessageSchema = z.object({
  role: chatRoleSchema,
  // 32k chars ≈ 8k tokens; note context is truncated to 2k upstream anyway.
  content: z.string().min(1).max(32_000),
});

/**
 * Aggregate ceiling on everything the client can put into a prompt.
 *
 * Per-field caps alone are not a cost control: 64 messages x 32k chars admits
 * ~2M characters, and only the upstream model's context window would stop it.
 * 400k chars is ~100k tokens, which fits every allowlisted model's window while
 * bounding what a single request can bill.
 */
export const MAX_TOTAL_INPUT_CHARS = 400_000;

/**
 * Output length is capped server-side rather than left to the client.
 *
 * Omitting `max_tokens` hands the decision to the provider default, which an
 * attacker cannot be relied upon to respect. The client may ask for less.
 */
export const DEFAULT_MAX_TOKENS = 2_048;
export const HARD_MAX_TOKENS = 8_192;

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(64),
  model: z
    .string()
    // OpenRouter ids look like `openai/gpt-4o-mini` or `anthropic/claude-3.5-sonnet`.
    .regex(/^[a-z0-9][a-z0-9._-]{0,127}\/[a-z0-9][a-z0-9._:-]{0,127}$/i)
    .optional(),
  stream: z.boolean().default(true),
  /**
   * Current note body, forwarded for model context. Bounded here so an
   * oversized payload is rejected before it is ever concatenated into a prompt.
   * It is always treated as untrusted data by the prompt guard.
   */
  noteContext: z.string().max(8_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(HARD_MAX_TOKENS).optional(),
}).refine(
  (body) => {
    const total = body.messages.reduce((sum, message) => sum + message.content.length, 0);
    return total + (body.noteContext?.length ?? 0) <= MAX_TOTAL_INPUT_CHARS;
  },
  {
    message: `Combined prompt exceeds ${MAX_TOTAL_INPUT_CHARS} characters.`,
    path: ['messages'],
  }
);

export type ChatRequestBody = z.output<typeof chatRequestSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;

/**
 * Models a client may request. Anything outside this list is rejected rather
 * than forwarded, so a modified client cannot silently spend on a premium model.
 * Override with a comma-separated `OPENROUTER_ALLOWED_MODELS`.
 */
const DEFAULT_ALLOWED_MODELS: readonly string[] = Object.freeze([
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.5-sonnet',
  'google/gemini-flash-1.5',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-small-3.1-24b-instruct',
]);

export const FALLBACK_MODEL = 'openai/gpt-4o-mini';

function parseAllowlist(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim().length === 0) return DEFAULT_ALLOWED_MODELS;
  return Object.freeze(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
}

export class ModelNotAllowedError extends Error {
  override readonly name = 'ModelNotAllowedError';
  readonly requested: string;

  constructor(requested: string) {
    super(`Model "${requested}" is not enabled for this deployment`);
    this.requested = requested;
  }
}

/**
 * Resolve the model to use, rejecting anything outside the allowlist.
 * `undefined` from the client falls back to the deployment default.
 */
export function resolveModel(
  requested: string | undefined,
  env: Record<string, string | undefined> = process.env
): string {
  const configuredDefault = env.OPENROUTER_MODEL?.trim();
  const allowlist = parseAllowlist(env.OPENROUTER_ALLOWED_MODELS);

  if (!requested) {
    return configuredDefault && configuredDefault.length > 0 ? configuredDefault : FALLBACK_MODEL;
  }

  const normalised = requested.toLowerCase();
  if (!allowlist.includes(normalised)) throw new ModelNotAllowedError(requested);
  return normalised;
}

/**
 * Fallback models for provider-side failover.
 *
 * OpenRouter accepts a `models` array and routes to the first available entry,
 * which gives outage tolerance without a second provider integration or a second
 * API key. The requested model is always first, so this only changes behaviour
 * when the primary is unavailable.
 *
 * Configured as a comma-separated `OPENROUTER_FALLBACK_MODELS`. Entries outside
 * the allowlist are dropped — a failover path must not become a way to reach a
 * model the deployment has not approved.
 */
export function parseFallbackModels(
  primary: string,
  env: Record<string, string | undefined> = process.env
): readonly string[] {
  const allowlist = parseAllowlist(env.OPENROUTER_ALLOWED_MODELS);
  const requested = (env.OPENROUTER_FALLBACK_MODELS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  const approved = requested.filter((entry) => allowlist.includes(entry));
  // De-duplicate and drop the primary itself.
  return [...new Set(approved)].filter((entry) => entry !== primary);
}
