/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  readonly VITE_API_BASE_URL: string;
  /** Which AI adapter the client resolves. Defaults to `openrouter`. */
  readonly VITE_AI_PROVIDER?: 'openrouter' | 'puter';
  /** Optional OpenRouter model id; the backend enforces its own allowlist. */
  readonly VITE_AI_MODEL?: string;
  /**
   * Google OAuth *client* ID (ends in `.apps.googleusercontent.com`).
   * Public by design — it identifies the app, it is not a secret.
   */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
