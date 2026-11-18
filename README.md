# AgentForge

A local-first harness in which specialised AI coding agents (Planner, Developer, Reviewer, Tester, Fixer, Documenter) work together. They can build a new project from scratch or work on an existing one. Work comes from a requirement chat or from tickets pulled in from a PMS tool over MCP.

AgentForge is single-user and has no login of its own. Everything runs on your machine: a Node daemon holds the state in SQLite, and a Next.js web app talks to it over REST and a WebSocket.

> **Status:** Phases 1–4 (Foundation, Projects, Engines, Requirement Chat & Planner) are complete. See [docs/PHASES.md](docs/PHASES.md) for the roadmap and what each phase delivers.

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

## Agent engines

Open **Agents & Accounts** to see each supported agent CLI: whether it's installed, its version, and whether you're signed in. That page is also where you log in, test an engine, and configure it.

| Engine       | Detected as                                                                                 | Headless mode used                                                  | Sign-in check                              |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Claude Code  | `claude` on PATH, `~/.claude/local/claude`, or the newest VS Code / Cursor extension binary | `claude -p --output-format stream-json --verbose` (prompt on stdin) | `claude auth status --json`                |
| OpenAI Codex | `codex`                                                                                     | `codex exec --json … -` (prompt on stdin)                           | `codex login status`                       |
| Gemini CLI   | `gemini`                                                                                    | `gemini -o stream-json --approval-mode … -p`                        | API key, or a cached Google sign-in        |
| Antigravity  | `agy` (not the `antigravity` IDE launcher)                                                  | `agy -p … --output-format stream-json --mode …`                     | `agy models` (also lists available models) |
| Custom CLI   | any executable                                                                              | argument template + text or JSON-lines parser, configured in the UI | optional auth-check command                |

- **Login** runs the CLI's own login command in an embedded terminal (xterm.js + node-pty). AgentForge never sees your credentials; they stay with the CLI.
- **API keys** are an alternative for Claude Code, Codex, Gemini and custom CLIs. They're stored encrypted and passed to the CLI only through its environment (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `GEMINI_API_KEY`, or the variable you configure).
- **Health checks** run every _Settings → Engine health check interval_. Status changes stream to the UI live. When an engine your default roles depend on has expired or hit its usage limit, a banner appears with a Re-login link or a reset countdown.
- **Usage windows** come from Claude Code's rate-limit events: how much of the 5-hour and 7-day windows you've used, and when each resets.
- **Test** sends one read-only prompt ("Reply with exactly: OK") in a scratch folder and streams the result. It uses a small amount of usage.
- **Permission profiles** decide what an agent run may do. Runs use `readonly` (read and inspect git only), `edit` (file edits), or `full` (edits plus shell commands). Each profile is mapped onto each CLI's own permission flags.

## Requirement chat and planning

Each project opens as a workspace: the **requirement chat** is on the left, and the **Plan & Tasks** and **Overview** tabs are on the right.

- **Writing a message.** Choose **Plan** (draft a new plan), **Add tasks** (extend the current plan) or **Discuss** (talk, without creating tasks).
  - Type `@` to reference files and `#` to reference tasks.
  - Attach files by picking, pasting or dragging them in.
  - Attachments are stored in `<project>/.agentforge/attachments/`. That folder is kept out of git through `.git/info/exclude`, so none of your tracked files change.
- **The Planner** runs read-only on the planner engine (Settings → Default engines → Planner).
  - It sees the project, the analysed codebase, project memory, the current plan, the recent conversation and your references.
  - It may ask clarifying questions first. Click a suggested answer, or tick **No questions** to make it plan with stated assumptions.
  - It must return strict JSON. The output is validated with Zod and the task graph is checked for unknown dependencies and cycles. If anything is wrong, the exact errors go back to the model, in the same CLI session where the engine supports resuming, for up to 3 attempts.
  - The requirement from the new-project wizard is planned automatically once the project has been analysed.
- **The approval gate.** Plans and tasks arrive as **Draft**. In the task drawer you can edit any field: title, description, type, priority, complexity, acceptance criteria, affected areas, dependencies, subtasks and per-role engines. You can also:
  - reorder tasks by dragging (list view), approve or unapprove them by dragging (board view), and see dependencies in the graph view
  - split a task, or merge several (multi-select)
  - regenerate a task, or the whole draft plan, with extra instructions
  - approve tasks one by one or with **Approve all**

  Every status change is recorded, and every task links back to the requirement version that produced it.

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
