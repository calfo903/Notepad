import { handleSearchNotes } from '../../server/accountHandler';

/** GET /api/notes/search?q=… — trigram + substring search over the caller's notes. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleSearchNotes;
