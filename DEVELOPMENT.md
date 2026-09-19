# Development

Setup, local environment, and the non-obvious things that will otherwise cost
you an afternoon. Every claim here was verified against a running server or a
passing test, not inferred.

## Bootstrap

```bash
npm ci
cp .env.example .env.local   # then fill in the values, see below
npm run dev -- --host 0.0.0.0
```

`npm ci` works: `package-lock.json` is committed and in sync. Use it rather than
`npm install` so the dependency set matches CI.

## Environment

`.env.local` is gitignored (`.gitignore:21`) and is **not** committed. If it goes
missing, recreate it with at least:

| Variable | Used by | Notes |
| --- | --- | --- |
| `VITE_GOOGLE_CLIENT_ID` | browser | Opens the sign-in UI. Inlined into the bundle at build time. |
| `GOOGLE_CLIENT_ID` | Edge Functions | Must equal the above exactly — the server checks the ID token's `aud` claim against it. A mismatch rejects every sign-in with 401. |
| `SESSION_SECRET` | Edge Functions | Signs the session cookie (HS256). Minimum 32 bytes; `server/session.ts` refuses to start auth below that. |
| `DATABASE_URL` | Edge Functions | Pooled Postgres. Without it, sync/search/history/deletion all return 503 and the app stays local-only. |
| `OPENROUTER_API_KEY` | `api/chat.ts` | Required when `VITE_AI_PROVIDER=openrouter` (the default). |

Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Never commit a real value. `.env.example` is the only committed example and must
stay empty.

## The dev-server env bridge

`vite.config.ts` calls `loadServerEnv(mode)` before constructing the plugins.

Vite only exposes `VITE_`-prefixed variables to `import.meta.env` on the client.
The Edge handlers are mounted as connect middleware and run in Node, reading bare
`process.env`, which Vite never populates from `.env` files. Without that bridge
every server-side secret reads as `undefined` and you get
`503 AUTH_NOT_CONFIGURED` from `/api/auth/google` even with a correct
`.env.local`. The dev server log will say `[auth] GOOGLE_CLIENT_ID is not
configured`.

Real environment variables win over file values, so a deploy-time value can never
be masked by a stale local file.

## Where sign-in appears in the UI

`src/components/Sidebar.tsx:201` renders `<AccountPanel>` in the sidebar footer.
It is invisible in two situations, which reads like a bug:

- **Collapsed sidebar.** The footer is wrapped in `{(!collapsed || isMobile) && …}`
  (`Sidebar.tsx:191`) and the aside narrows to `w-16`.
- **Mobile.** The sidebar is translated off-screen until `state.showMobileMenu`
  is true (`App.tsx:162`).

## Endpoints

| Route | File |
| --- | --- |
| `POST /api/chat` | `server/chatHandler.ts` |
| `POST /api/auth/google` | `server/authHandler.ts` |
| `GET /api/auth/session` | `server/authHandler.ts` |
| `POST /api/auth/logout` | `server/authHandler.ts` |
| `GET /api/auth/events` | `server/accountHandler.ts` |
| `DELETE /api/auth/account?confirm=true` | `server/accountHandler.ts` |
| `GET /api/notes` | `server/syncHandler.ts` |
| `POST /api/notes/sync` | `server/syncHandler.ts` |
| `GET /api/notes/search?q=…` | `server/accountHandler.ts` |

`API_ROUTES` in `vite.config.ts` mirrors the `api/` filesystem layout. Add new
routes to both or they will work on Vercel and 404 locally.

## Tests

```bash
npx vitest run          # 310 tests / 14 files
npx tsc --noEmit        # vitest does NOT typecheck; run this separately
npm run lint
```

CI runs `vitest run --coverage`, so `@vitest/coverage-v8` must stay a
devDependency even though nothing imports it.

`server/*.test.ts` must begin with `// @vitest-environment node`. Under jsdom,
`jose` rejects the HS256 key with *"Key for the HS256 algorithm must be one of
…"* because the `Uint8Array` comes from a different realm. The fix belongs in the
test file, not in `session.ts`.

### PGlite

Tests run real SQL against PGlite (a WASM Postgres) — no mocks, and no Postgres
binary is required. Two things that are not obvious:

- **Contrib extensions must be registered in the constructor.**
  `new PGlite({ extensions: { pg_trgm } })`. Issuing only
  `CREATE EXTENSION pg_trgm` fails with `extension "pg_trgm" is not available`,
  because PGlite has not unpacked the extension into its in-memory filesystem.
  See `server/db/testDatabase.ts`.
- **Booting costs ~1.7s.** Share one instance per file and `TRUNCATE` between
  cases. Per-test instantiation took the sync suite from 4.3s to 26.5s.

PGlite has no connection string, so the dev server can never use it. Live checks
against `npm run dev` can only prove the 401/405/503 paths.

### pg_trgm search

`server/db/accountRepo.ts` searches with `ILIKE` plus
`word_similarity() > 0.4`. The thresholds and the operator choice were measured
in PGlite, not guessed:

| Expression | Result |
| --- | --- |
| `similarity('we discussed the quarterly budget forecast', 'budget')` | **0.163** — under the 0.3 threshold, so the `%` operator matched nothing |
| `'budget' %> 'we discussed … budget …'` | **false**, even for an exact match. The operator is unusable here. |
| `word_similarity('budget', …)` | **1.0** |
| `word_similarity('budgt', …)` | **0.667** — a one-character typo still matches |
| `EXPLAIN … WHERE s ILIKE '%budget%'` (2000 rows) | **Seq Scan** — the GIN index is not used under PGlite |

So: substring matching via `ILIKE` (what a search box implies, and the only form
a GIN trigram index can accelerate on real Postgres), with a fuzzy tier for
typos. The `notes_search_trgm_idx` index is kept for real Postgres but does
nothing measurable under PGlite.

## Migrations

`server/db/migrations/`:

- `0000_init.sql` — `notes`, `folders`. Hand-written.
- `0001_search_and_audit.sql` — `search_text` + GIN index + `auth_events`.
  Hand-written and idempotent.

**Do not run `drizzle-kit generate` to extend these.** `0000_init.sql` was never
recorded in a drizzle journal, so `generate` emits a full `CREATE TABLE` for
`notes` and `folders` that fails against any existing database. Write the next
migration by hand in the same `IF NOT EXISTS` style.

`0001` runs `CREATE EXTENSION IF NOT EXISTS pg_trgm`, which needs a role with
extension privileges on your database.

## Design decisions worth preserving

- **`search_text` is computed client-side.** Edge Functions have no DOM, so a
  server-side HTML stripper would be a regex parser that is wrong in exactly the
  cases that matter. The client already runs DOMPurify.
- **The sync upsert must set `searchText`.** Omitting it from `onConflictDoUpdate`
  leaves an edited note findable by words it no longer contains.
- **Sync deletes are tombstones; account deletion is a hard delete.** A peer
  device only learns a note is gone if the deletion is itself a syncable event.
- **`auth_events` is append-only.** The repository exports no update or delete for
  it, so the trail cannot be rewritten by the code that owns it. Account deletion
  leaves audit rows behind so the deletion itself stays evidenced.
- **Fail loud, not silent.** No `DATABASE_URL` returns 503 with a distinct code
  (`SYNC_NOT_CONFIGURED`, `SEARCH_NOT_CONFIGURED`, `AUTH_EVENTS_NOT_CONFIGURED`,
  `DELETE_NOT_CONFIGURED`) rather than degrading to a sync that quietly persists
  nothing.
- **Per-row last-write-wins on `updated_at`.** Two devices editing the same note
  concurrently lose the older revision. Fixing that needs a CRDT or an operation
  log; it is a known limitation, not an oversight.

## Known gaps

- `src/hooks/useNotesStore.ts` has 0% test coverage. The hydration logic it calls
  (`src/utils/appStateSchema.ts`) is tested; the hook is not.
- The rate limiters are isolate-local, so each Edge isolate has its own bucket.
  A shared store (Upstash/Redis) is the seam that needs filling.
- The editor is still `contentEditable`-based; migrating to ProseMirror or
  Lexical needs interactive visual verification.
- `prettier --check` fails on files that predate this branch.

## Recovering after a workspace reset

The sandbox has been reset mid-session more than once, wiping `node_modules`,
`.env.local`, and the local branch pointer while leaving the working tree intact.
Nothing is actually lost — check before rebuilding:

```bash
git ls-remote --heads origin <branch>          # does the commit still exist upstream?
git fetch origin "+refs/heads/<branch>:refs/remotes/origin/<branch>"
git add -A
git diff --cached --stat FETCH_HEAD            # empty output = byte-identical
git reset --soft FETCH_HEAD                    # restore the pointer, touch no files
```

`git diff FETCH_HEAD` on its own is misleading: files untracked at the reset
commit show up as deletions even though they are present on disk. Stage first,
then diff.

If `node_modules` is gone, `npm ci` restores it. If `.env.local` is gone,
recreate it from the table above — it is gitignored, so no reset will ever bring
it back.
