import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * Test fixture that mints real RS256-signed JWTs with a locally generated
 * keypair. This exercises the actual cryptographic verification path in
 * `googleAuth` — signature, issuer, audience, expiry and nonce — rather than
 * standing in for it.
 */

export interface GoogleKeyFixture {
  readonly publicJwk: JWK;
  readonly privateKey: CryptoKey;
  readonly kid: string;
}

export async function createGoogleKeyFixture(): Promise<GoogleKeyFixture> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const kid = 'test-key-1';

  return { publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'RS256' }, privateKey, kid };
}

export interface MintOptions {
  readonly clientId: string;
  readonly nonce: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly algorithm?: 'RS256' | 'HS256' | 'none';
  readonly expiresIn?: string;
  readonly issuedAt?: number;
  readonly sub?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
  readonly picture?: string;
  /** Override the signing key, e.g. to prove an attacker key is rejected. */
  readonly signingKey?: CryptoKey | Uint8Array;
}

/** Build a token shaped like a Google ID token, signed with the fixture key. */
export async function mintGoogleIdToken(
  fixture: GoogleKeyFixture,
  options: MintOptions
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1_000);

  const builder = new SignJWT({
    email: options.email ?? 'user@example.com',
    email_verified: options.emailVerified ?? true,
    name: options.name ?? 'Test User',
    ...(options.picture === undefined ? {} : { picture: options.picture }),
    nonce: options.nonce,
  })
    .setSubject(options.sub ?? 'google-sub-12345')
    .setIssuer(options.issuer ?? 'https://accounts.google.com')
    .setAudience(options.audience ?? options.clientId)
    .setIssuedAt(issuedAt);

  if (options.expiresIn !== undefined) builder.setExpirationTime(options.expiresIn);
  else builder.setExpirationTime(issuedAt + 3_600);

  const algorithm = options.algorithm ?? 'RS256';

  if (algorithm === 'none') {
    // jose refuses alg:none; construct it by hand, exactly as an attacker would.
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: options.sub ?? 'google-sub-12345',
      email: options.email ?? 'user@example.com',
      email_verified: true,
      aud: options.audience ?? options.clientId,
      iss: options.issuer ?? 'https://accounts.google.com',
      nonce: options.nonce,
    })}.`;
  }

  builder.setProtectedHeader({ alg: algorithm, typ: 'JWT', kid: fixture.kid });

  return builder.sign(options.signingKey ?? fixture.privateKey);
}
