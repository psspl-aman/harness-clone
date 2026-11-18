# AgentForge

A local-first harness in which specialised AI coding agents (Planner, Developer, Reviewer, Tester, Fixer, Documenter) work together. They can build a new project from scratch or work on an existing one. Work comes from a requirement chat or from tickets pulled in from a PMS tool over MCP.

AgentForge is single-user and has no login of its own. Everything runs on your machine: a Node daemon holds the state in SQLite, and a Next.js web app talks to it over REST and a WebSocket.

> **Status:** Phases 1–2 (Foundation, Projects) are complete. See [docs/PHASES.md](docs/PHASES.md) for the roadmap and what each phase delivers.

## Requirements

- Node.js ≥ 22 (developed on 24)
- pnpm 10 (`corepack enable`)
- A C/C++ toolchain, for `better-sqlite3` (prebuilt binaries cover most platforms)

## Quick start

```bash
pnpm install
pnpm dev            # daemon on :4317 and web app on :4318, run in parallel
```

Then open <http://localhost:4318>.

You can also run each side on its own:

```bash
pnpm dev:daemon     # Fastify daemon (tsx watch)
pnpm dev:web        # Next.js dev server
```

The daemon creates its data directory on first start. It applies database migrations automatically.

## Projects and GitHub

- **New project from scratch.** Choose a local folder (AgentForge creates it and runs `git init`) or a GitHub repository (create a new one or pick an existing one). Then add stack preferences, per-role agent engines and an initial requirement.
- **Attach an existing project.** Choose a local folder or a GitHub repository to clone.
  - If a local folder isn't a git repository yet, AgentForge can initialise one. Its initial commit never includes `.env*`, `*.pem` or `*.key` files.
  - Attaching never deletes or rewrites your files. Removing a project from AgentForge leaves the folder untouched.
- **Onboarding analysis** runs automatically on every new project. It detects:
  - languages, frameworks, package manager and monorepo layout
  - install, run, build, test and lint commands
  - folder structure
  - conventions
  - env files (by name only; their values are never read)
  - git state

  You can confirm or edit the detected commands on the project page. The results are also saved to project memory.

- **GitHub** is connected under _Integrations_, in one of two ways:
  - Paste a personal access token with the `repo` scope (add `read:org` for organisations).
  - Reuse the login of an installed and logged-in `gh` CLI with one click.

  The token is stored encrypted (AES-256-GCM) under `AGENTFORGE_HOME`. When cloning, it is passed to git through environment variables, so it never appears in `.git/config` or in process arguments.

Clones go to `<workspace folder>/<owner>/<repo>`. The workspace folder defaults to `~/.agentforge/workspaces` and can be changed in Settings.

## Configuration

Copy `.env.example` to `.env` if you need to change any of these defaults.

| Variable                              | Default                                       | Purpose                                                    |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `AGENTFORGE_HOME`                     | `~/.agentforge`                               | SQLite DB, attachments, logs, managed workspaces           |
| `AGENTFORGE_HOST` / `AGENTFORGE_PORT` | `127.0.0.1` / `4317`                          | Daemon bind address                                        |
| `AGENTFORGE_WEB_PORT`                 | `4318`                                        | Used to build the default CORS/WebSocket origin allow-list |
| `AGENTFORGE_ALLOWED_ORIGINS`          | `http://localhost:4318,http://127.0.0.1:4318` | Comma-separated origins that may call the daemon           |
| `NEXT_PUBLIC_AGENTFORGE_DAEMON_URL`   | `http://127.0.0.1:4317`                       | Where the browser finds the daemon                         |

The daemon refuses requests whose `Host` is not a loopback name. This protects against DNS rebinding. It also refuses browser requests from origins outside the allow-list, which protects against CSRF. Non-browser clients such as `curl` work normally.

## Scripts

| Command                     | What it does                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm test`                 | Unit and integration tests (Vitest) for `shared` and `daemon`                                |
| `pnpm test:e2e`             | Playwright end-to-end tests against an isolated daemon (throwaway data dir, ports 4417/4418) |
| `pnpm typecheck`            | Strict TypeScript across all packages                                                        |
| `pnpm lint` / `pnpm format` | ESLint (typescript-eslint + react-hooks) / Prettier                                          |
| `pnpm build`                | Bundles the daemon with tsup and builds the web app with `next build`                        |
| `pnpm db:generate`          | Generates a SQL migration after editing `apps/daemon/src/db/schema.ts`                       |

**Browser for E2E.** Playwright needs a matching Chromium. Install it with `pnpm exec playwright install chromium`, or use the Google Chrome you already have: `PW_CHANNEL=chrome pnpm test:e2e`.

## Repository layout

```
apps/
  daemon/    Fastify daemon: REST + WebSocket, SQLite (Drizzle), event bus, services
  web/       Next.js App Router UI: Tailwind v4, shadcn/ui, TanStack Query, Zustand, Motion
packages/
  shared/    Zod contracts shared by both: enums, task state machine, settings, events, WS protocol
e2e/         Playwright specs
docs/        Architecture and phase tracker
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together and [docs/API.md](docs/API.md) for the daemon's REST API.
