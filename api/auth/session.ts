import { handleSession } from '../../server/authHandler';

/** GET /api/auth/session — current session, or 401 when signed out. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleSession;
