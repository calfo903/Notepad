import { handleChat } from '../server/chatHandler';

/**
 * Vercel Edge Function entry point for POST /api/chat.
 *
 * Edge runtime keeps the key out of the Node cold-start path and gives sub-50ms
 * TLS handshakes for the streaming connection. `dynamic` prevents Vercel from
 * pre-rendering this route at build time.
 */
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default handleChat;
