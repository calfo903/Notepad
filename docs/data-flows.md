# Data flows

What leaves the user's device, where it goes, and how long it is kept. Derived
from the code, not from intent — every URL below appears in `server/` or `src/`.

## Outbound destinations

| Destination | Called from | Data sent | Purpose |
| --- | --- | --- | --- |
| `https://openrouter.ai/api/v1/chat/completions` | `server/chatHandler.ts` | Conversation messages, up to 2,000 chars of note content, model id, `max_tokens`, temperature | AI completion |
| `https://accounts.google.com/gsi/client` | `src/services/auth/googleGsi.ts` (browser) | None directly; loads Google's sign-in script | Google Sign-In UI |
| `https://www.googleapis.com/oauth2/v3/certs` | `server/googleAuth.ts` | None; fetches public keys | Verifies the ID token signature |
| Neon Postgres (`DATABASE_URL`) | `server/db/client.ts` | Notes, folders, derived search text, audit events | Persistence and sync |
| Puter.js (`window.puter.ai.chat`) | `src/services/ai/puterProvider.ts` (browser) | Conversation messages and note context | AI completion — **only when `VITE_AI_PROVIDER=puter`** |

Nothing else is contacted. There is no analytics, telemetry or error-reporting
endpoint in the codebase.

## The Puter divergence

This matters more than it looks. With `VITE_AI_PROVIDER=openrouter` (the
default), note content goes **browser → our Edge Function → OpenRouter**, so it
passes through the prompt guard, the rate limiter, the token budget and the
request log.

With `VITE_AI_PROVIDER=puter`, the browser calls Puter directly. Note content
**never touches our servers**, which means none of those controls apply — no
guard hardening, no budget, no log, no rate limit. That is a materially different
risk profile and a different third party receiving the data. Do not treat the two
providers as interchangeable from a privacy standpoint.

## What the AI provider receives

Per request, after `hardenMessages` (`server/promptGuard.ts`):

- The application guard prompt (~700 chars, static, contains no user data).
- Any client-supplied `system` messages, neutralised and capped at 1,200 chars.
- Note content, capped at 2,000 chars, wrapped in per-request nonce-delimited
  untrusted markers.
- Conversation turns, neutralised.

**Not** sent: session cookies, the user's email or Google `sub`, the API key
(server-held only), or any other note than the one currently open.

There is no PII redaction. If a user pastes credentials, medical information or a
client's confidential text into a note and asks the assistant about it, that text
goes to the provider. See the "open items" section below.

## What is stored

| Store | Contents | Retention |
| --- | --- | --- |
| Browser `localStorage` | Notes, folders, UI preferences | Until the user clears it or deletes the account |
| Postgres `notes`, `folders` | Note content, derived `search_text`, tombstones | Until deletion. Account deletion is a hard delete. |
| Postgres `auth_events` | Pseudonymisable subject id, event name, IP, user agent, timestamp | 1 year (`AUTH_EVENT_RETENTION_MS`), pruned opportunistically on sign-in |
| Application logs (stdout) | `traceId`, hashed principal, model, prompt version, token counts, latency, status, error code | Per hosting-platform configuration |

### What logs deliberately do not contain

`server/aiLog.ts` records one structured line per request. Prompt text,
completions and `noteContext` are **not fields on that record**, and a test
asserts the exact key set so adding one fails CI. The principal is a salted
SHA-256 prefix, not the raw Google `sub`; `LOG_SALT` makes the hash
deployment-specific.

## Right to erasure

`DELETE /api/auth/account?confirm=true`:

1. Hard-deletes every note and folder owned by the caller.
2. Writes an `account_deleted` audit event.
3. Pseudonymises the caller's audit rows: `user_id` becomes `deleted:<hash>` and
   `ip` / `user_agent` are set to `NULL`.

The audit timeline survives, because a log that the subject can erase is not a
log, but the personal data in it does not. The hash is not reversible from the
table alone — recovering the mapping requires the original `sub`, which step 1
removed.

Browser `localStorage` is not reachable from the server, so the client must clear
it locally; this is not yet automated (see open items).

## Agreements and classification — not yet done

Recorded here so the gap is visible rather than implied:

- **No DPA or no-training agreement** is referenced anywhere. OpenRouter routes to
  many underlying providers, each with its own terms.
- **No privacy policy or terms of service** exist in this repository.
- **Data residency** depends on the Neon and Vercel region configuration, which is
  deployment state, not code.
- **No regulatory classification** has been recorded (EU AI Act tier, SOC 2 scope).
- **No position on output ownership** or model licence terms.

## Open items

| Item | Status |
| --- | --- |
| PII detection before sending note content to a provider | Not implemented |
| Per-note "exclude from AI" flag | Not implemented |
| Clearing `localStorage` as part of account deletion | Not implemented |
| Privacy policy / ToS | Not written |
| DPA with OpenRouter (and Puter, if that provider is enabled) | Not in place |
| Encryption at rest for the Postgres instance | Unverified — deployment configuration |
