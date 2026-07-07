export interface PuterAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface PuterAIChatOptions {
  stream?: boolean;
}

export interface PuterAIResponse {
  message?: {
    content: string | Array<{ type: string; text?: string }>;
  };
  toString(): string;
}

export interface PuterAIStreamChunk {
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
