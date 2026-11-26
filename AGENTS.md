# Contributor & agent guide

AI Harness is a pnpm monorepo:

- `apps/daemon` — Fastify + SQLite (Drizzle) backend
- `apps/web` — Next.js UI
- `packages/shared` — types/helpers shared by both

Requires **Node ≥ 22** and **pnpm 10.20.0** (pinned in `package.json`). These rules are the
single source of truth for both humans and AI agents working in this repo. Keep it that way —
don't duplicate them elsewhere; link here instead.

## 1. Cross-platform first (Windows / Linux / macOS)

Every change must work on all three OSes, and flows must be designed with that in mind from the
start — not patched for one OS afterward.

- Spawn and resolve binaries through the helpers in `apps/daemon/src/lib/platform.ts`
  (`which`, `ptyCommand`, `shellCommand`, `pathExts`) — never hardcode a POSIX path, a bash
  invocation, or a `#!/usr/bin/env` shebang script.
- Use `node:path` (`join`, `sep`) instead of hardcoded `/` separators; don't assume Unix file
  modes/permissions (`chmod` is a no-op on Windows).
- When removing temp dirs, pass `{ recursive: true, force: true, maxRetries, retryDelay }` —
  Windows releases child-process handles asynchronously and otherwise throws `EPERM`.
- Remember npm CLI shims are `.cmd` on Windows (they run as `cmd.exe → node`): kill the whole
  process tree, not just the direct child, when cancelling.

## 2. Git workflow — `dev` is the top branch

Never commit directly to `dev`.

1. Pull the latest `dev`.
2. Create a new branch off it (`feat/…`, `fix/…`).
3. Push your work to that branch.
4. Open a PR into `dev` and merge it there.

## 3. Before you open a PR

- Adapt your machine to the repo, not the other way around: use the pinned pnpm/Node versions
  and don't rewrite `pnpm-lock.yaml` to suit your setup.
- Run `pnpm -r typecheck` and the relevant package tests (`pnpm --filter @ai-harness/daemon test`,
  etc.); keep them green on your OS.
- Never commit secrets or local runtime data (the `~/.ai-harness` home, `.env`, `*.db`).
- Schema change? Edit `apps/daemon/src/db/schema.ts`, then run `pnpm db:generate`; keep migrations
  additive so a running daemon keeps working.

> This is a demo/presentation project — favor a simple, working app over production-grade
> hardening. Don't over-engineer security or edge cases.
