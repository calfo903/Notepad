import { handleDeleteAccount } from '../../server/accountHandler';

/** DELETE /api/auth/account?confirm=true — permanently delete the caller's notes and folders. */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleDeleteAccount;
