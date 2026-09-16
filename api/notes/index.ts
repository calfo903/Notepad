import { handleListNotes } from '../../server/syncHandler';

/** GET /api/notes — full snapshot for the signed-in user. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleListNotes;
