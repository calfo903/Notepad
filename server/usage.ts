/**
 * Provider usage extraction.
 *
 * OpenRouter reports token counts in two shapes: a `usage` object on a normal
 * JSON completion, and a terminal SSE frame with empty `choices` when the request
 * was made with `stream_options: { include_usage: true }`. Both are parsed here
 * so cost accounting has one source of truth.
 */

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Parse a `usage` object. Returns null when absent or unparseable. */
export function parseUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const usage = (raw as { usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const promptTokens = readCount((usage as { prompt_tokens?: unknown }).prompt_tokens);
  const completionTokens = readCount((usage as { completion_tokens?: unknown }).completion_tokens);
  const declared = readCount((usage as { total_tokens?: unknown }).total_tokens);

  if (promptTokens === 0 && completionTokens === 0 && declared === 0) return null;

  return {
    promptTokens,
    completionTokens,
    totalTokens: declared > 0 ? declared : promptTokens + completionTokens,
  };
}

/**
 * Incremental scanner for a byte stream.
 *
 * SSE frames straddle chunk boundaries arbitrarily, so a partial line is held
 * back until the newline arrives. The scanner never buffers more than one
 * unfinished line, so a long stream cannot grow memory without bound.
 */
export class UsageScanner {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private found: TokenUsage | null = null;

  /** Feed a chunk. Returns the usage as soon as it is seen, else null. */
  push(chunk: Uint8Array): TokenUsage | null {
    if (this.found) return this.found;

    this.buffer += this.decoder.decode(chunk, { stream: true });

    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);

      const usage = this.usageFromLine(line);
      if (usage) {
        this.found = usage;
        return usage;
      }

      newline = this.buffer.indexOf('\n');
    }

    return null;
  }

  /** Flush any trailing line that never received a newline. */
  end(): TokenUsage | null {
    if (this.found) return this.found;
    const usage = this.usageFromLine(this.buffer.trim());
    this.buffer = '';
    if (usage) this.found = usage;
    return this.found;
  }

  get result(): TokenUsage | null {
    return this.found;
  }

  private usageFromLine(line: string): TokenUsage | null {
    if (!line.startsWith('data:')) return null;

    const payload = line.slice(5).trim();
    // `[DONE]` is the stream terminator, not JSON.
    if (payload.length === 0 || payload === '[DONE]') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A keep-alive comment or a partial frame; ignore and keep scanning.
      return null;
    }

    return parseUsage(parsed);
  }
}
