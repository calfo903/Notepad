# Subprocessors

Third parties that receive user data, and what each one gets. Derived from the
code and deployment configuration in this repository — see
[data-flows.md](data-flows.md) for the request-level detail.

> **The DPA links below are the vendors' standard locations and have not been
> individually verified for this deployment.** Confirming each one, and that the
> agreement covers your use, is an open item. See `docs/data-flows.md` →
> "Agreements and classification".

## Active by default

### OpenRouter — AI inference

- **Receives:** conversation messages, up to 2,000 characters of note content,
  model id, `max_tokens`, temperature, and the `HTTP-Referer` / `X-Title`
  attribution headers.
- **Does not receive:** session cookies, the Google `sub`, or the user's email.
- **Why it matters:** OpenRouter is a *router*. It forwards to whichever upstream
  provider serves the requested model, so a request may traverse an additional
  party you did not choose. Each upstream has its own retention and training
  terms. Restricting `OPENROUTER_ALLOWED_MODELS` is the only lever this
  application has over that.
- **Terms:** `openrouter.ai/terms`, `openrouter.ai/privacy`

### Google Identity Services — authentication

- **Receives:** nothing sent by this application directly. The browser loads
  `accounts.google.com/gsi/client` and Google issues an ID token.
- **Server-side:** `www.googleapis.com/oauth2/v3/certs` is fetched to verify the
  token signature. No user data is transmitted.
- **Terms:** `cloud.google.com/terms/data-processing-terms`

### Neon — Postgres

- **Receives:** notes, folders, derived `search_text`, and `auth_events`
  (subject id, event, IP, user agent, timestamp).
- **Region:** whatever the Neon project is configured to. Not enforced by code.
- **Terms:** `neon.com/privacy`, `neon.com/dpa`

### Vercel — hosting and Edge runtime

- **Receives:** everything that transits the application, including request and
  response bodies at the platform layer, and the `ai.request` log lines written
  to stdout.
- **Terms:** `vercel.com/legal/dpa`

## Conditional

### Puter — AI inference (only when `VITE_AI_PROVIDER=puter`)

- **Receives:** conversation messages and note content, **sent directly from the
  user's browser**.
- **Critical difference:** this path bypasses this application's Edge Functions
  entirely. The prompt guard, the token budget, the rate limiter and the request
  log all sit in those functions, so none of them apply. If you enable Puter you
  are accepting a different control set, not just a different vendor.
- **Terms:** `puter.com/terms`

## Not used

Confirmed absent from the codebase, so they are not subprocessors even though a
note-taking app might be expected to use them:

- No analytics or product-telemetry SDK.
- No error-reporting service. No Sentry, no Datadog, no Rollbar.
- No advertising or marketing pixels.
- No email provider — there is no email in the product.
- No CDN for user content.

## Change control

Adding a subprocessor is a change to this file, to `docs/data-flows.md`, and —
if it receives user data — to the privacy notice. A dependency that phones home
is a subprocessor whether or not anyone wrote code to call it, so dependency
additions should be reviewed against this list.
