# Notepad

A note-taking application built with React 19, Vite 7 and Tailwind CSS 4, with an
AI assistant, Google sign-in and cross-device note sync.

## Features

- Create, edit, and delete notes, with pin, archive and trash
- Folder organization
- Rich text editor with formatting
- AI assistant, pluggable between OpenRouter and Puter.js (OpenRouter by default)
- Google sign-in with an HS256 session cookie
- Cross-device note sync against Postgres, with per-row last-write-wins
- Fuzzy note search (pg_trgm trigram + substring)
- Account deletion and an append-only sign-in audit log
- Search and filter, dark mode, HTML export
- Output sanitization with DOMPurify

## Getting Started

```bash
npm ci
cp .env.example .env.local
npm run dev
```

`.env.local` is gitignored and required for anything server-side. Without it the
app still runs as a local-only notepad, but sign-in, sync, search and the AI
assistant all report themselves unconfigured rather than failing quietly.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full variable list, the endpoint
map, how to run the tests, and the migrations.

## Tech Stack

- React 19, Vite 7, TypeScript, Tailwind CSS 4
- Vercel Edge Functions (`api/`) for the server; the same handlers are mounted as
  Vite middleware in development, so there is one implementation and two hosts
- Drizzle ORM over Neon Postgres; PGlite for tests
- `jose` for JWT verification and session tokens, `zod` for validation,
  DOMPurify for sanitization

## License

MIT
