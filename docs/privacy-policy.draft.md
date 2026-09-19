# Privacy notice — DRAFT

> **Status: draft, not legal advice.** The technical statements below were
> derived from this repository and are accurate as of the current commit. The
> legal framing has **not** been reviewed by counsel and must not be published
> as-is. A published privacy notice carries obligations this document cannot
> discharge on its own: a named controller, a contact address, lawful-basis
> determinations per processing activity, and jurisdiction-specific disclosures.
> Those are absent deliberately rather than invented.
>
> See `docs/subprocessors.md` for the third parties, and `docs/data-flows.md`
> for what each one receives.

## What this application is

NoteFlow AI is a note-taking application with an AI writing assistant. Notes are
stored in your browser and, when you sign in, synced to a database so they follow
you between devices.

## What is collected

**When you use the app without signing in**

Nothing is collected server-side beyond what the AI assistant needs to answer
you, and the request metadata needed to keep the service running. Notes stay in
your browser's local storage.

**When you sign in with Google**

- Your Google subject identifier — an opaque id, not your email address.
- Sign-in events: the event name, your IP address, your browser's user agent, and
  a timestamp.

**When you use the AI assistant**

- The messages you send it.
- Up to 2,000 characters of the note you have open, unless you have excluded that
  note from AI (see "Controls" below).
- Enough metadata to bill and rate-limit the request.

## What is deliberately not collected

- No analytics or usage telemetry. There is no tracking SDK in the codebase.
- No error reporting to a third party.
- No advertising identifiers.
- No email address, unless you put one in a note.

Request logs record token counts, latency, model and a salted hash of your
identifier. **They do not record what you wrote or what the model replied.** A
test enforces the exact field list on that log record, so adding content to it
fails the build.

## Where data goes

The AI assistant's answers come from a third-party model provider. When you ask
it about a note, that note's content is sent to that provider.

The provider list and what each receives is in `docs/subprocessors.md`.

**There is no automated scanning of your notes for personal data.** If you write
a password, a card number or a client's confidential information into a note and
ask the assistant about it, that text goes to the provider. The application warns
you when it detects something that looks like a secret, and you can exclude a note
from AI entirely — but the decision is yours, not automatic.

## How long data is kept

| Data | Retention |
| --- | --- |
| Notes and folders | Until you delete them, or until you delete your account |
| Sign-in audit events | 1 year, then pruned |
| Request logs | Whatever the hosting platform is configured for |
| Browser local storage | Until you clear it or delete your account |

## Deleting your account

`Settings → Delete account` (or `DELETE /api/auth/account?confirm=true`) does the
following:

1. Hard-deletes every note and folder you own. There is no soft delete and no
   recovery.
2. Writes a record that the account was deleted.
3. Replaces your identifier in the remaining audit rows with an irreversible
   hash, and removes the IP address and user agent.

The audit record survives because a log that the person it describes can erase is
not a log. The personal data in it does not.

**One gap:** the application cannot clear your browser's local storage from the
server. To remove local copies, clear the site's data in your browser. This is
noted in `docs/data-flows.md` as an open item.

## Your controls

- **Exclude a note from AI.** A toggle in the AI panel stops that note's content
  from being sent, per note. Your messages still go; the note does not.
- **Sensitive-content warning.** The panel warns before you send a note that
  appears to contain a key, token, card number or email address.
- **Stay signed out.** Notes then never leave your browser except when you
  explicitly use the AI assistant.
- **Choose your provider.** `VITE_AI_PROVIDER` selects which AI backend is used.
  Note that the `puter` option sends content from your browser directly and
  bypasses this application's safety controls — see `docs/subprocessors.md`.

## Security measures

- Prompts sent to the model are wrapped in per-request nonce-delimited markers so
  text inside a note cannot be interpreted as an instruction.
- Model output is sanitised before it is rendered, using DOMPurify with an
  explicit deny list.
- Sessions are signed HS256 tokens; the verification pins the algorithm, so a
  forged `alg` header is rejected.
- Tenant isolation is enforced by a composite primary key on `(user_id, note_id)`
  at the database layer, not by filtering in application code.
- Every AI request is bounded by a per-account daily token budget.

## Open items

Not resolved, listed here so the gaps are visible:

- No data processing agreement is recorded with any subprocessor.
- No lawful-basis analysis has been performed.
- No data residency guarantee; region is deployment configuration.
- No regulatory classification (EU AI Act tier, SOC 2 scope) has been recorded.
- Encryption at rest for the database is deployment configuration and has not
  been verified from this repository.
