import { handleGoogleLogin } from '../../server/authHandler';

/** POST /api/auth/google — exchange a Google ID token for a session cookie. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleGoogleLogin;
