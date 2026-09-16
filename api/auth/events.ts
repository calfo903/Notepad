import { handleAuthEvents } from '../../server/accountHandler';

/** GET /api/auth/events — the caller's own sign-in audit trail. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleAuthEvents;
