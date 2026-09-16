// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { createGoogleTokenVerifier, AuthError } from './googleAuth';
import { createGoogleKeyFixture, mintGoogleIdToken, type GoogleKeyFixture } from './googleTokenFixture';
import { generateKeyPair } from 'jose';

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

let fixture: GoogleKeyFixture;

beforeAll(async () => {
  fixture = await createGoogleKeyFixture();
});

function verifier() {
  return createGoogleTokenVerifier({ clientId: CLIENT_ID, jwks: fixture.publicJwk });
}

describe('createGoogleTokenVerifier', () => {
  it('rejects an empty client id at construction', async () => {
    await expect(async () => createGoogleTokenVerifier({ clientId: '  ' })).rejects.toThrow(AuthError);
    expect(() => createGoogleTokenVerifier({ clientId: '' })).toThrowError(
      expect.objectContaining({ code: 'AUTH_NOT_CONFIGURED' })
    );
  });

  it('accepts a correctly signed token with matching claims', async () => {
    const token = await mintGoogleIdToken(fixture, { clientId: CLIENT_ID, nonce: NONCE });

    const { profile } = await verifier()(token, NONCE);

    expect(profile.sub).toBe('google-sub-12345');
    expect(profile.email).toBe('user@example.com');
    expect(profile.emailVerified).toBe(true);
    expect(profile.name).toBe('Test User');
    expect(profile.picture).toBeNull();
  });

  it('accepts the alternate issuer form', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      issuer: 'accounts.google.com',
    });

    await expect(verifier()(token, NONCE)).resolves.toBeDefined();
  });

  it('preserves the picture claim when present', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      picture: 'https://lh3.googleusercontent.com/a/photo',
    });

    const { profile } = await verifier()(token, NONCE);
    expect(profile.picture).toBe('https://lh3.googleusercontent.com/a/photo');
  });
});

describe('signature and algorithm', () => {
  it('rejects a token signed by a different RSA key', async () => {
    const attacker = await generateKeyPair('RS256', { modulusLength: 2048 });
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      signingKey: attacker.privateKey,
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token whose signature was tampered with', async () => {
    const token = await mintGoogleIdToken(fixture, { clientId: CLIENT_ID, nonce: NONCE });
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.AAAA${token.slice(token.lastIndexOf('.') + 5)}`;

    await expect(verifier()(forged, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a payload modified without re-signing', async () => {
    const token = await mintGoogleIdToken(fixture, { clientId: CLIENT_ID, nonce: NONCE });
    const [header, , signature] = token.split('.');
    const swappedEmail = Buffer.from(
      JSON.stringify({ sub: 'attacker', email: 'attacker@evil.test', email_verified: true, aud: CLIENT_ID, iss: 'https://accounts.google.com', nonce: NONCE })
    ).toString('base64url');

    await expect(verifier()(`${header}.${swappedEmail}.${signature}`, NONCE)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects alg:none', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      algorithm: 'none',
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects an HS256 token, blocking algorithm confusion', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      algorithm: 'HS256',
      signingKey: new TextEncoder().encode('x'.repeat(48)),
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects malformed input before touching the network', async () => {
    await expect(verifier()('not-a-jwt', NONCE)).rejects.toMatchObject({ code: 'MALFORMED_TOKEN' });
    await expect(verifier()('a.b', NONCE)).rejects.toMatchObject({ code: 'MALFORMED_TOKEN' });
    await expect(verifier()('', NONCE)).rejects.toMatchObject({ code: 'MALFORMED_TOKEN' });
  });
});

describe('claim validation', () => {
  it('rejects a token issued for a different client', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      audience: 'some-other-client.apps.googleusercontent.com',
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token from an untrusted issuer', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      issuer: 'https://accounts.google.com.evil.test',
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects an expired token', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      expiresIn: '-1h',
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token older than the max token age even if unexpired', async () => {
    // Issued 2 hours ago, still valid for another hour: fresh-token replay guard.
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      issuedAt: Math.floor(Date.now() / 1_000) - 7_200,
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token whose nonce does not match this sign-in attempt', async () => {
    const token = await mintGoogleIdToken(fixture, { clientId: CLIENT_ID, nonce: NONCE });

    await expect(verifier()(token, 'ffffffffffffffffffffffffffffffff')).rejects.toMatchObject({
      code: 'NONCE_MISMATCH',
    });
  });

  it('rejects an unverified email address', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      emailVerified: false,
    });

    await expect(verifier()(token, NONCE)).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('rejects a token with no sub claim', async () => {
    const token = await mintGoogleIdToken(fixture, { clientId: CLIENT_ID, nonce: NONCE, sub: '' });

    await expect(verifier()(token, NONCE)).rejects.toThrow(AuthError);
  });

  it('falls back to the email when the name claim is absent', async () => {
    const token = await mintGoogleIdToken(fixture, {
      clientId: CLIENT_ID,
      nonce: NONCE,
      name: '',
      email: 'fallback@example.com',
    });

    const { profile } = await verifier()(token, NONCE);
    expect(profile.name).toBe('fallback@example.com');
  });
});