interface PuterAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PuterAIChatOptions {
  stream?: boolean;
}

interface PuterAIResponse {
  message?: {
    content: string | Array<{ type: string; text?: string }>;
  };
  toString(): string;
}

interface PuterAIStreamChunk {
  text?: string;
}

interface PuterAI {
  chat(
    messages: PuterAIMessage[],
    options?: PuterAIChatOptions
  ): Promise<PuterAIResponse | AsyncIterable<PuterAIStreamChunk>>;
}

interface Puter {
  ai: PuterAI;
}

declare global {
  interface Window {
    puter?: Puter;
  }
}

export {};
