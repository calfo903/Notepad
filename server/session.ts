import { jwtVerify, SignJWT } from 'jose';
import { AuthError, type GoogleProfile } from './googleAuth';

/**
 * Application session.
 *
 * We do not re-verify the Google ID token on every request: it expires in an
 * hour, which would silently log users out mid-session. Instead the verified
 * profile is exchanged for our own HS256 session token, stored in an HttpOnly
 * cookie so page script (and any XSS in this editor) cannot read it.
 */

export const SESSION_COOKIE = 'nf_session';

/** 7 days. Short enough to bound a stolen cookie, long enough to be useful. */
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const MIN_SECRET_BYTES = 32;

export interface SessionUser {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

function secretKey(env: Record<string, string | undefined>): Uint8Array {
  const secret = env.SESSION_SECRET?.trim();

  if (!secret) {
    throw new AuthError(
      500,
      'AUTH_NOT_CONFIGURED',
      'SESSION_SECRET is not configured on this deployment.'
    );
  }

  const bytes = new TextEncoder().encode(secret);
  // HS256 with a short key is brute-forceable; refuse rather than degrade.
  if (bytes.byteLength < MIN_SECRET_BYTES) {
    throw new AuthError(
      500,
      'AUTH_NOT_CONFIGURED',
      `SESSION_SECRET must be at least ${MIN_SECRET_BYTES} bytes.`
    );
  }

  return bytes;
}

export async function createSessionToken(
  profile: GoogleProfile,
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1_000);

  return new SignJWT({
    email: profile.email,
    name: profile.name,
    picture: profile.picture,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(profile.sub)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_TTL_SECONDS)
    .setIssuer('noteflow')
    .setAudience('noteflow-web')
    .sign(secretKey(env));
}

/** Read and verify the session cookie. Returns null when absent or invalid. */
export async function readSession(
  request: Request,
  env: Record<string, string | undefined> = process.env
): Promise<SessionUser | null> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      issuer: 'noteflow',
      audience: 'noteflow-web',
      algorithms: ['HS256'],
    });

    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;

    return {
      sub: payload.sub,
      email: payload.email,
      name: typeof payload.name === 'string' ? payload.name : payload.email,
      picture: typeof payload.picture === 'string' ? payload.picture : null,
    };
  } catch {
    // Expired, tampered, or signed with a rotated secret. Treat as signed out
    // rather than erroring: the client will simply show the sign-in button.
    return null;
  }
}

/** Minimal cookie parser; Edge has no built-in one. */
export function parseCookies(header: string | null): Record<string, string> {
  const jar: Record<string, string> = {};
  if (!header) return jar;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;

    const name = part.slice(0, eq).trim();
    if (name.length === 0) continue;
    jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }

  return jar;
}

export function sessionCookieHeader(token: string, secure = true): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter((part) => part.length > 0)
    .join('; ');
}

export function clearSessionCookieHeader(secure = true): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter((part) => part.length > 0)
    .join('; ');
}

/** Whether the request arrived over TLS. Used to decide the Secure flag. */
export function isSecureRequest(request: Request): boolean {
  const forwardedProto = request.headers.get('x-forwarded-proto');
  if (forwardedProto) return forwardedProto.split(',')[0].trim() === 'https';
  return new URL(request.url).protocol === 'https:';
}
