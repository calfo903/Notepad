// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  clearSessionCookieHeader,
  createSessionToken,
  isSecureRequest,
  parseCookies,
  readSession,
  sessionCookieHeader,
  SESSION_COOKIE,
} from './session';
import type { GoogleProfile } from './googleAuth';

const SECRET = 'test-secret-value-that-is-long-enough-for-hs256';
const SHORT_SECRET = 'too-short';

const PROFILE: GoogleProfile = Object.freeze({
  sub: 'google-sub-12345',
  email: 'user@example.com',
  emailVerified: true,
  name: 'Test User',
  picture: 'https://example.test/p.jpg',
});

function requestWithCookie(cookie: string | null, url = 'https://app.test/api/auth/session'): Request {
  const headers = new Headers();
  if (cookie !== null) headers.set('cookie', cookie);
  return new Request(url, { headers });
}

describe('parseCookies', () => {
  it('parses a multi-cookie header', () => {
    expect(parseCookies('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('handles values containing = and percent-encoding', () => {
    expect(parseCookies('tok=abc%3D%3D; x=y=z')).toEqual({ tok: 'abc==', x: 'y=z' });
  });

  it('returns an empty object for null, empty and malformed input', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(';;;')).toEqual({});
  });
});

describe('createSessionToken / readSession', () => {
  it('round-trips a verified profile', async () => {
    const token = await createSessionToken(PROFILE, { SESSION_SECRET: SECRET });
    const session = await readSession(requestWithCookie(`${SESSION_COOKIE}=${token}`), {
      SESSION_SECRET: SECRET,
    });

    expect(session).toEqual({
      sub: 'google-sub-12345',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.test/p.jpg',
    });
  });

  it('returns null when the cookie is absent', async () => {
    expect(await readSession(requestWithCookie(null), { SESSION_SECRET: SECRET })).toBeNull();
    expect(await readSession(requestWithCookie('other=1'), { SESSION_SECRET: SECRET })).toBeNull();
  });

  it('returns null for a tampered token rather than throwing', async () => {
    const token = await createSessionToken(PROFILE, { SESSION_SECRET: SECRET });
    const tampered = `${token.slice(0, -4)}AAAA`;

    expect(
      await readSession(requestWithCookie(`${SESSION_COOKIE}=${tampered}`), {
        SESSION_SECRET: SECRET,
      })
    ).toBeNull();
  });

  it('returns null when verified against a different secret', async () => {
    const token = await createSessionToken(PROFILE, { SESSION_SECRET: SECRET });

    expect(
      await readSession(requestWithCookie(`${SESSION_COOKIE}=${token}`), {
        SESSION_SECRET: 'a-completely-different-secret-value-here!!',
      })
    ).toBeNull();
  });

  it('refuses to sign with a missing secret', async () => {
    await expect(createSessionToken(PROFILE, {})).rejects.toMatchObject({
      code: 'AUTH_NOT_CONFIGURED',
    });
  });

  it('refuses to sign with a secret shorter than 32 bytes', async () => {
    await expect(createSessionToken(PROFILE, { SESSION_SECRET: SHORT_SECRET })).rejects.toMatchObject(
      { code: 'AUTH_NOT_CONFIGURED' }
    );
  });
});

describe('cookie attributes', () => {
  it('sets HttpOnly, SameSite=Lax and Secure by default', () => {
    const header = sessionCookieHeader('tok');

    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
    expect(header).toContain('Path=/');
    expect(header.startsWith(`${SESSION_COOKIE}=tok`)).toBe(true);
  });

  it('omits Secure when the request is plain HTTP', () => {
    expect(sessionCookieHeader('tok', false)).not.toContain('Secure');
    expect(clearSessionCookieHeader(false)).not.toContain('Secure');
  });

  it('expires the cookie on clear', () => {
    expect(clearSessionCookieHeader()).toContain('Max-Age=0');
  });
});

describe('isSecureRequest', () => {
  it('reads x-forwarded-proto behind a proxy', () => {
    const headers = new Headers({ 'x-forwarded-proto': 'https' });
    expect(isSecureRequest(new Request('http://internal/api', { headers }))).toBe(true);
  });

  it('takes the first hop of a multi-proxy chain', () => {
    const headers = new Headers({ 'x-forwarded-proto': 'http, https' });
    expect(isSecureRequest(new Request('https://app.test/api', { headers }))).toBe(false);
  });

  it('falls back to the request URL scheme', () => {
    expect(isSecureRequest(new Request('https://app.test/api'))).toBe(true);
    expect(isSecureRequest(new Request('http://app.test/api'))).toBe(false);
  });
});