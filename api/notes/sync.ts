import { handleSync } from '../../server/syncHandler';

/** POST /api/notes/sync — push local changes, pull remote changes. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleSync;
