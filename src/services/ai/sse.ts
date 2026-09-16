/**
 * Server-Sent Events parser.
 *
 * Streaming decoders hand us arbitrary byte splits: an event may arrive across
 * three chunks, or two events in one. This buffers on the blank-line boundary
 * defined by the SSE spec and never emits a partial event.
 */

export interface SSEEvent {
  readonly event: string;
  readonly data: string;
}

/** Parse one `event: …\ndata: …` block. Returns null for comments/heartbeats. */
export function parseEventBlock(block: string): SSEEvent | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.length === 0 || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // Spec: strip exactly one leading space after the colon.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** Async-iterate byte chunks into complete SSE events. */
export async function* parseSSEStream(
  chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<SSEEvent, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    // Normalise CRLF so a single boundary check suffices.
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const parsed = parseEventBlock(block);
      if (parsed !== null) yield parsed;

      boundary = buffer.indexOf('\n\n');
    }
  }

  // Flush any trailing bytes the stream ended on without a final blank line.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const parsed = parseEventBlock(buffer);
    if (parsed !== null) yield parsed;
  }
}

/** OpenRouter/OpenAI terminator sentinel. */
export const SSE_DONE = '[DONE]';

/**
 * Extract the text delta from an OpenAI-compatible chat completion chunk.
 * Returns '' for role-only deltas, empty-content deltas, and usage trailers.
 */
export function extractDelta(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';

  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';

  const delta = (choices[0] as { delta?: unknown } | null)?.delta;
  if (typeof delta !== 'object' || delta === null) {
    // Non-streaming shape some providers return inside a stream.
    const message = (choices[0] as { message?: unknown })?.message;
    if (typeof message === 'object' && message !== null) {
      const content = (message as { content?: unknown }).content;
      return typeof content === 'string' ? content : '';
    }
    return '';
  }

  const content = (delta as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}
