import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';

/**
 * Google ID token verification.
 *
 * A Google ID token is a bearer assertion: anyone holding one can claim to be
 * that user. Every claim below is therefore checked cryptographically before any
 * of it is trusted. `sub` is the only stable identifier — `email` can change.
 */

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google signs ID tokens with RS256. Pinning the algorithm blocks `alg` confusion. */
const ALLOWED_ALGORITHMS = ['RS256'] as const;

/** Google publishes both forms depending on the flow. */
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

/** Reject tokens older than this. Google's own expiry is 1 hour. */
const MAX_TOKEN_AGE_SECONDS = 300;

/** Small tolerance for clock skew between Google and this isolate. */
const CLOCK_TOLERANCE_SECONDS = 30;

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface GoogleProfile {
  /** Stable, opaque, per-client user id. The only safe primary key. */
  readonly sub: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly name: string;
  readonly picture: string | null;
}

export interface VerifierOptions {
  readonly clientId: string;
  /** Injectable so tests can verify against a locally generated keypair. */
  readonly jwks?: Parameters<typeof jwtVerify>[1];
  /** Injectable clock for expiry tests. */
  readonly now?: () => Date;
}

export interface VerifiedToken {
  readonly profile: GoogleProfile;
  readonly payload: JWTPayload;
}

function requireString(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AuthError(401, 'INVALID_TOKEN', `ID token is missing the "${claim}" claim.`);
  }
  return value;
}

/**
 * Build a verifier bound to one client id.
 *
 * The JWKS is fetched and cached by `jose` with Google's `cache-control`
 * respected, so keys are refreshed on rotation without a redeploy.
 */
export function createGoogleTokenVerifier(options: VerifierOptions) {
  const clientId = options.clientId.trim();
  if (clientId.length === 0) {
    throw new AuthError(500, 'AUTH_NOT_CONFIGURED', 'GOOGLE_CLIENT_ID is not configured.');
  }

  const key = options.jwks ?? createRemoteJWKSet(new URL(GOOGLE_CERTS_URL));

  return async function verifyGoogleIdToken(
    idToken: string,
    expectedNonce: string
  ): Promise<VerifiedToken> {
    if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
      throw new AuthError(401, 'MALFORMED_TOKEN', 'ID token is not a well-formed JWT.');
    }

    let payload: JWTPayload;
    try {
      const verifyOptions: JWTVerifyOptions = {
        issuer: [...VALID_ISSUERS],
        audience: clientId,
        algorithms: [...ALLOWED_ALGORITHMS],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE_SECONDS,
      };

      const result = await jwtVerify(idToken, key, verifyOptions);
      payload = result.payload;
    } catch (err) {
      // jose throws JWTExpired / JWTClaimValidationFailed / JWSSignatureVerificationFailed.
      // Surface a generic message: the specifics are an oracle for token forging.
      const reason = err instanceof Error ? err.name : 'UnknownError';
      console.warn('[auth] ID token verification failed:', reason);
      throw new AuthError(401, 'INVALID_TOKEN', 'Google ID token failed verification.');
    }

    // Nonce binding. Without it a token captured in transit (or from another
    // tab) can be replayed against this endpoint to hijack the session.
    if (payload.nonce !== expectedNonce) {
      throw new AuthError(401, 'NONCE_MISMATCH', 'ID token nonce does not match this sign-in attempt.');
    }

    const email = requireString(payload, 'email');
    const emailVerified = payload.email_verified;

    // An unverified mailbox must never become an account identity: anyone can
    // register an address they do not control.
    if (emailVerified !== true) {
      throw new AuthError(403, 'EMAIL_NOT_VERIFIED', 'The Google account email is not verified.');
    }

    // Google omits `name` for some accounts, and sends an empty string for
    // others. Treat blank as absent so the UI never renders an empty label.
    const rawName = typeof payload.name === 'string' ? payload.name.trim() : '';
    const rawPicture = typeof payload.picture === 'string' ? payload.picture.trim() : '';

    const profile: GoogleProfile = Object.freeze({
      sub: requireString(payload, 'sub'),
      email,
      emailVerified: true,
      name: rawName.length > 0 ? rawName : email,
      picture: rawPicture.length > 0 ? rawPicture : null,
    });

    return { profile, payload };
  };
}
