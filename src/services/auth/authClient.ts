/**
 * Client for the authentication endpoints.
 *
 * The session lives in an HttpOnly cookie, so this module never holds a token it
 * could leak. `credentials: 'include'` is required on every call or the cookie
 * is not sent.
 */

export interface AuthUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

export class AuthRequestError extends Error {
  override readonly name = 'AuthRequestError';
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    Object.setPrototypeOf(this, AuthRequestError.prototype);
  }
}

const CSRF_COOKIE = 'g_csrf_token';

interface ApiErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

async function toError(response: Response): Promise<AuthRequestError> {
  let envelope: ApiErrorEnvelope | null = null;
  try {
    const text = await response.text();
    if (text.length > 0) envelope = JSON.parse(text) as ApiErrorEnvelope;
  } catch {
    envelope = null;
  }

  return new AuthRequestError(
    response.status,
    envelope?.error?.code ?? 'UNKNOWN',
    envelope?.error?.message ?? `Request failed with status ${response.status}`
  );
}

/** 32 hex chars from the CSPRNG. Never Math.random for a security value. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Google's double-submit CSRF cookie. Deliberately readable by page script —
 * that is the point. The server requires the same value in the body, which a
 * cross-site form post cannot supply.
 */
export function issueCsrfToken(): string {
  const token = generateNonce();
  document.cookie = `${CSRF_COOKIE}=${token};path=/;SameSite=Lax`;
  return token;
}

export async function exchangeGoogleCredential(
  credential: string,
  nonce: string,
  csrfToken: string
): Promise<AuthUser> {
  const response = await fetch('/api/auth/google', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential, nonce, csrfToken }),
  });

  if (!response.ok) throw await toError(response);

  const payload = (await response.json()) as { user?: AuthUser };
  if (!payload.user) throw new AuthRequestError(502, 'MALFORMED_RESPONSE', 'Sign-in returned no user.');

  return payload.user;
}

/** Returns null when signed out; throws only on a genuine failure. */
export async function fetchSession(): Promise<AuthUser | null> {
  const response = await fetch('/api/auth/session', {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });

  if (response.status === 401) return null;
  if (!response.ok) throw await toError(response);

  const payload = (await response.json()) as { user?: AuthUser };
  return payload.user ?? null;
}

export async function endSession(): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
  });

  if (!response.ok) throw await toError(response);
}
