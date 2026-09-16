import { z } from 'zod';
import {
  AuthError,
  createGoogleTokenVerifier,
  type GoogleProfile,
  type VerifiedToken,
} from './googleAuth';
import {
  clearSessionCookieHeader,
  createSessionToken,
  isSecureRequest,
  readSession,
  parseCookies,
  sessionCookieHeader,
  SESSION_COOKIE,
  type SessionUser,
} from './session';
import { errorResponse, jsonResponse, readJsonBody } from './http';
import { clientIp, RateLimiter } from './rateLimit';
import { getDatabase } from './db/client';
import { tryRecordAuthEvent } from './accountHandler';

/**
 * Authentication endpoints.
 *
 * Trust model: the browser supplies a Google ID token and a nonce it generated.
 * Nothing from that token is believed until the signature is verified against
 * Google's JWKS, and the nonce must match so the token cannot be replayed from
 * another session.
 */

const CSRF_COOKIE = 'g_csrf_token';

const loginSchema = z.object({
  credential: z.string().min(32).max(8_192),
  nonce: z.string().min(16).max(128),
  /** Double-submit of the CSRF cookie, per Google's Sign in with Google guidance. */
  csrfToken: z.string().min(8).max(128),
});

/** Login attempts are far rarer than chat calls, so the bucket is much tighter. */
const loginLimiter = new RateLimiter({
  capacity: 10,
  refillPerSecond: 10 / 60,
  sweepIntervalMs: 30_000,
});

function publicUser(user: SessionUser): Record<string, unknown> {
  return { sub: user.sub, email: user.email, name: user.name, picture: user.picture };
}

function methodGuard(request: Request, allowed: string): Response | null {
  if (request.method === allowed) return null;
  return errorResponse(405, 'METHOD_NOT_ALLOWED', `Only ${allowed} is accepted.`, undefined, {
    Allow: allowed,
  });
}

/** Verifier cache: the JWKS fetcher must be reused so Google's key cache holds. */
const verifierCache = new Map<string, (idToken: string, nonce: string) => Promise<VerifiedToken>>();

function defaultVerifier(clientId: string) {
  const cached = verifierCache.get(clientId);
  if (cached) return cached;

  const created = createGoogleTokenVerifier({ clientId });
  verifierCache.set(clientId, created);
  return created;
}

export interface GoogleLoginDeps {
  /** Injectable token verifier. Production uses Google's remote JWKS. */
  readonly verify?: (idToken: string, nonce: string) => Promise<VerifiedToken>;
}

/**
 * POST /api/auth/google — exchange a Google ID token for a session cookie.
 *
 * Built as a factory so the verifier can be injected; the default export wires
 * the real Google JWKS.
 */
export function createGoogleLoginHandler(deps: GoogleLoginDeps = {}) {
  return async function handleGoogleLogin(request: Request): Promise<Response> {
    const denied = methodGuard(request, 'POST');
    if (denied) return denied;

    const decision = loginLimiter.consume(`login:${clientIp(request)}`);
    if (!decision.allowed) {
      return errorResponse(
        429,
        'RATE_LIMITED',
        `Too many sign-in attempts. Try again in ${decision.retryAfterSeconds}s.`,
        undefined,
        { 'retry-after': String(decision.retryAfterSeconds) }
      );
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      console.error('[auth] GOOGLE_CLIENT_ID is not configured');
      return errorResponse(
        503,
        'AUTH_NOT_CONFIGURED',
        'Google sign-in is not configured on this deployment. Set GOOGLE_CLIENT_ID.'
      );
    }

    const body = await readJsonBody(request);
    if (body === null) {
      return errorResponse(400, 'INVALID_JSON', 'Request body is not valid JSON.');
    }

    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        400,
        'VALIDATION_FAILED',
        'Sign-in payload failed schema validation.',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
      );
    }

    // Double-submit CSRF check: the value must appear both in the cookie the page
    // set and in the body this request sent.
    const csrfCookie = parseCookies(request.headers.get('cookie'))[CSRF_COOKIE];
    if (!csrfCookie || csrfCookie !== parsed.data.csrfToken) {
      return errorResponse(
        403,
        'CSRF_MISMATCH',
        'Sign-in CSRF token does not match the session cookie.'
      );
    }

    let profile: GoogleProfile;
    try {
      const verify = deps.verify ?? defaultVerifier(clientId);
      const verified = await verify(parsed.data.credential, parsed.data.nonce);
      profile = verified.profile;
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
      throw err;
    }

    let token: string;
    try {
      token = await createSessionToken(profile);
    } catch (err) {
      if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
      throw err;
    }

    // Audit the sign-in. Best-effort: a deployment without DATABASE_URL has no
    // audit table, and that must not block anyone from signing in.
    await tryRecordAuthEvent({
      db: getDatabase,
      userId: profile.sub,
      event: 'sign_in',
      request,
    });

    return jsonResponse(
      200,
      {
        user: {
          sub: profile.sub,
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
        },
      },
      { 'set-cookie': sessionCookieHeader(token, isSecureRequest(request)) }
    );
  };
}

export const handleGoogleLogin = createGoogleLoginHandler();

/** GET /api/auth/session — current session, or 401 when signed out. */
export async function handleSession(request: Request): Promise<Response> {
  const denied = methodGuard(request, 'GET');
  if (denied) return denied;

  let user: SessionUser | null;
  try {
    user = await readSession(request);
  } catch (err) {
    if (err instanceof AuthError) return errorResponse(err.status, err.code, err.message);
    throw err;
  }

  if (!user) {
    return errorResponse(401, 'NOT_SIGNED_IN', 'No active session.');
  }

  return jsonResponse(200, { user: publicUser(user) });
}

/** POST /api/auth/logout — clear the session cookie. */
export async function handleLogout(request: Request): Promise<Response> {
  const denied = methodGuard(request, 'POST');
  if (denied) return denied;

  // Clearing a cookie the client does not have is harmless, so this needs no
  // session lookup and cannot be used to probe who is signed in.
  const hadSession = Boolean(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]);

  // Audit only when the cookie actually verifies. The response still reveals
  // nothing about who it was, so the no-probe property above is preserved.
  if (hadSession) {
    try {
      const user = await readSession(request);
      if (user) {
        await tryRecordAuthEvent({
          db: getDatabase,
          userId: user.sub,
          event: 'sign_out',
          request,
        });
      }
    } catch {
      // An expired or forged cookie simply clears without an audit entry.
    }
  }

  return jsonResponse(
    200,
    { signedOut: hadSession },
    { 'set-cookie': clearSessionCookieHeader(isSecureRequest(request)) }
  );
}
