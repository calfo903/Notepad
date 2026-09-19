# AI usage policy

What the assistant is, what it is allowed to do, and what it is not. This is the
document to hand to a reviewer who asks "how do you control the model?" — every
claim here points at code.

## Scope

The assistant writes, edits, improves, summarises, translates and brainstorms
note content. It is a writing tool. It is not a research assistant, not a
retrieval system over the user's notes, and not an agent.

## Capabilities the application does not grant

This matters more than the guard prompt does, because it is enforced structurally
rather than by asking politely.

- **No tools.** The request body contains no `tools` key. The model cannot call a
  function, so it cannot read other notes, write to the database, or fetch a URL,
  regardless of what the prompt says.
- **No retrieval.** Only the currently open note is sent, capped at 2,000
  characters. There is no vector store and no search over the user's corpus.
- **No cross-note access.** Tenant isolation is a composite primary key on
  `(user_id, note_id)` in `server/db/schema.ts`. A request cannot name another
  user's note.
- **No arbitrary models.** The client's model id is checked against
  `OPENROUTER_ALLOWED_MODELS`; an unknown id returns `403 MODEL_NOT_ALLOWED`.

## Prompt construction

Order is the security property. See `server/promptGuard.ts`.

1. The guard prompt is always message zero. Client input cannot displace it.
2. Application-supplied system text (persona, preferences) is appended after it,
   neutralised and capped at 1,200 characters.
3. Note content is wrapped in `<<<UNTRUSTED_{nonce}>>>` markers, where the nonce
   is 8 random bytes per request. The delimiter alphabet is stripped from all
   input, so a closing marker inside user text cannot close the block early.
4. User and assistant turns follow, neutralised.

Control characters and ANSI escapes are removed from everything entering the
prompt.

## Output handling

Model output is **not trusted**. `src/components/AIPanel.tsx` runs it through
`renderInlineMarkdown` and then `sanitizeHtml` (DOMPurify with an explicit
`FORBID_TAGS` / `FORBID_ATTRS` list) before it reaches `dangerouslySetInnerHTML`.
Content the user chooses to insert into a note goes through the same path.

## Disclosure

A first-use banner in the AI panel states that a model is involved, names the
provider, and says the output may be inaccurate. Each assistant message carries
the provider name, so attribution survives a screenshot. See
`src/components/AiDisclosure.tsx`.

## Cost and abuse controls

| Control | Where | Effect |
| --- | --- | --- |
| Per-account daily token budget | `server/costGuard.ts` | `429 BUDGET_EXCEEDED` once exceeded |
| Always-set `max_tokens` | `server/chatHandler.ts` | 2,048 default, 8,192 hard cap |
| Aggregate input ceiling | `server/schema.ts` | 400,000 characters across all messages |
| Rate limit | `server/rateLimit.ts` | Token bucket per IP, or per account when signed in |
| Circuit breaker | `server/circuitBreaker.ts` | `503 PROVIDER_CIRCUIT_OPEN` after 5 consecutive upstream failures |

## Quality assurance

`server/eval/cases.ts` holds 15 cases across 8 categories — system override,
injection planted in note content, forged delimiters, role smuggling, guard leak,
nonce probing, control characters, and benign requests that must still work.

`npm run eval` scores them against the real `hardenMessages` with no network
access, so it runs on every relevant pull request. `npm run eval:live` scores
actual provider output and requires an API key.

The live tier is what tells you whether a *model* obeys the guard. It has not
been run as part of this work; the deterministic tier passing means the prompt is
well-formed, not that the model complies.

## Prohibited use

Users may not use the assistant to generate content that is unlawful, or to
process personal data they have no right to process. Enforcement is currently
**terms-of-service only** — there is no output classifier and no automated
moderation in this codebase. Stating that plainly is better than implying a
control that does not exist.
