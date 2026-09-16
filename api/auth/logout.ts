import { handleLogout } from '../../server/authHandler';

/** POST /api/auth/logout — clear the session cookie. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleLogout;
