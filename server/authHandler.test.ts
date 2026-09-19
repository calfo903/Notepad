// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createGoogleLoginHandler,
  handleLogout,
  handleSession,
} from './authHandler';
import { AuthError, type GoogleProfile, type VerifiedToken } from './googleAuth';
import { SESSION_COOKIE } from './session';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const SECRET = 'test-secret-value-that-is-long-enough-for-hs256';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const CSRF = 'csrf-token-0123456789';

const PROFILE: GoogleProfile = Object.freeze({
  sub: 'google-sub-12345',
  email: 'user@example.com',
  emailVerified: true,
  name: 'Test User',
  picture: null,
});

const VERIFIED: VerifiedToken = { profile: PROFILE, payload: { sub: PROFILE.sub } };

/** Verifier stub: the real crypto path is covered exhaustively in googleAuth.test. */
function loginHandler(verify?: (token: string, nonce: string) => Promise<VerifiedToken>) {
  return createGoogleLoginHandler({ verify: verify ?? (async () => VERIFIED) });
}

function loginRequest(
  body: unknown,
  init: { ip?: string; cookie?: string; method?: string } = {}
): Request {
  const method = init.method ?? 'POST';
  const headers = new Headers({ 'content-type': 'application/json' });
  if (init.ip) headers.set('x-forwarded-for', init.ip);
  if (init.cookie) headers.set('cookie', init.cookie);

  return new Request('https://app.test/api/auth/google', {
    method,
    headers,
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

const VALID_BODY = { credential: 'header.payload.signature-value-long-enough', nonce: NONCE, csrfToken: CSRF };
const CSRF_COOKIE = `g_csrf_token=${CSRF}`;

function sessionRequest(cookie: string | null): Request {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new Request('https://app.test/api/auth/session', { headers });
}

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.SESSION_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.SESSION_SECRET;
});

describe('POST /api/auth/google', () => {
  it('rejects GET with 405', async () => {
    const response = await loginHandler()(loginRequest({}, { method: 'GET', ip: '20.0.0.1' }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('fails loudly with 503 when GOOGLE_CLIENT_ID is unset', async () => {
    delete process.env.GOOGLE_CLIENT_ID;

    const response = await loginHandler()(loginRequest(VALID_BODY, { ip: '20.0.0.2', cookie: CSRF_COOKIE }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(503);
    expect(body.error.code).toBe('AUTH_NOT_CONFIGURED');
  });

  it('returns 400 for malformed JSON', async () => {
    const response = await loginHandler()(
      loginRequest('{broken', { ip: '20.0.0.3', cookie: CSRF_COOKIE })
    );

    expect(response.status).toBe(400);
  });

  it('rejects a nonce shorter than the minimum', async () => {
    const response = await loginHandler()(
      loginRequest({ ...VALID_BODY, nonce: 'short' }, { ip: '20.0.0.4', cookie: CSRF_COOKIE })
    );
    const body = (await response.json()) as { error: { code: string; details: unknown[] } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).not.toHaveLength(0);
  });

  it('rejects a missing CSRF cookie', async () => {
    const response = await loginHandler()(loginRequest(VALID_BODY, { ip: '20.0.0.5' }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(body.error.code).toBe('CSRF_MISMATCH');
  });

  it('rejects a CSRF body value that does not match the cookie', async () => {
    const response = await loginHandler()(
      loginRequest(VALID_BODY, { ip: '20.0.0.6', cookie: 'g_csrf_token=some-other-value' })
    );

    expect(response.status).toBe(403);
  });

  it('issues an HttpOnly session cookie on success', async () => {
    const response = await loginHandler()(
      loginRequest(VALID_BODY, { ip: '20.0.0.7', cookie: CSRF_COOKIE })
    );
    const body = (await response.json()) as { user: Record<string, unknown> };
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(response.status).toBe(200);
    expect(body.user.email).toBe('user@example.com');
    expect(body.user.sub).toBe('google-sub-12345');
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('passes the verifier error through with its status and code', async () => {
    const handler = loginHandler(async () => {
      throw new AuthError(401, 'NONCE_MISMATCH', 'ID token nonce does not match this sign-in attempt.');
    });

    const response = await handler(loginRequest(VALID_BODY, { ip: '20.0.0.8', cookie: CSRF_COOKIE }));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('NONCE_MISMATCH');
  });

  it('never leaks the credential or session secret in the response', async () => {
    const response = await loginHandler()(
      loginRequest(VALID_BODY, { ip: '20.0.0.9', cookie: CSRF_COOKIE })
    );
    const text = await response.text();

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(VALID_BODY.credential);
  });

  it('rate limits repeated sign-in attempts', async () => {
    const handler = loginHandler();
    let lastStatus = 0;

    for (let i = 0; i < 11; i += 1) {
      const response = await handler(loginRequest(VALID_BODY, { ip: '20.0.0.10', cookie: CSRF_COOKIE }));
      lastStatus = response.status;
      await response.text();
    }

    expect(lastStatus).toBe(429);
  });
});

describe('login -> session round trip', () => {
  it('produces a cookie that the session endpoint accepts', async () => {
    const login = await loginHandler()(
      loginRequest(VALID_BODY, { ip: '20.0.0.11', cookie: CSRF_COOKIE })
    );
    const setCookie = login.headers.get('set-cookie') ?? '';
    const token = setCookie.split(';')[0];

    const session = await handleSession(sessionRequest(token));
    const body = (await session.json()) as { user: Record<string, unknown> };

    expect(session.status).toBe(200);
    expect(body.user.email).toBe('user@example.com');
    expect(body.user.sub).toBe('google-sub-12345');
  });
});

describe('GET /api/auth/session', () => {
  it('returns 401 when signed out', async () => {
    const response = await handleSession(sessionRequest(null));
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('NOT_SIGNED_IN');
  });

  it('returns 401 for a cookie that fails verification', async () => {
    const response = await handleSession(sessionRequest(`${SESSION_COOKIE}=forged.token.value`));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const response = await handleLogout(
      new Request('https://app.test/api/auth/logout', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=something` },
      })
    );
    const body = (await response.json()) as { signedOut: boolean };

    expect(response.status).toBe(200);
    expect(body.signedOut).toBe(true);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('is idempotent when already signed out', async () => {
    const response = await handleLogout(
      new Request('https://app.test/api/auth/logout', { method: 'POST' })
    );
    const body = (await response.json()) as { signedOut: boolean };

    expect(response.status).toBe(200);
    expect(body.signedOut).toBe(false);
  });

  it('rejects GET with 405', async () => {
    const response = await handleLogout(
      new Request('https://app.test/api/auth/logout', { method: 'GET' })
    );
    expect(response.status).toBe(405);
  });
});