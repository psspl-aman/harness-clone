# Build phases

| #   | Phase                                                                                                                            | Status  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Foundation**: monorepo, DB schema and migrations, event bus, WebSocket, UI shell, settings                                     | ✅ Done |
| 2   | **Projects**: scratch (local and GitHub) and attaching existing projects, onboarding analysis, directory browser                 | ⏳ Next |
| 3   | **Engines**: adapter interface; Claude Code, Codex, Gemini/Antigravity and custom adapters; install detection; login PTY; status | —       |
| 4   | **Requirement Chat + Planner**: plan and task generation (Zod-validated JSON with retry), editing, approval gate                 | —       |
| 5   | **Orchestrator**: Dev → Review → Test → Fix → Document; worktrees, concurrency, fix loops, merge or PR                           | —       |
| 6   | **Usage & Quota**: analytics, checkpoints, auto-pause and auto-resume, engine fallback                                           | —       |
| 7   | **Run & Terminal**: run panel, preview, xterm/node-pty terminals, error matchers, "Fix with agent"                               | —       |
| 8   | **PMS via MCP**: MCP servers, PMS connections, mapping, sync, write-back                                                         | —       |
| 9   | **Memory & Docs**: memory service and editor, task reports, Docs tab, export                                                     | —       |
| 10  | **Polish & Hardening**: safety guards, more E2E coverage, UX polish                                                              | —       |

## Phase 1: what was verified

- **Unit and integration (Vitest, 36 tests):**
  - task state machine transitions and progress
  - settings schema, deep merge and validation
  - event bus sequencing, validation, listener isolation, and ring-buffer replay and truncation
  - REST API: health, system, settings GET/PATCH, validation errors, JSON 404s
  - local-only guard: rejects foreign `Host` and `Origin` headers
  - migrations create every table, with foreign keys and cascades enforced
  - WebSocket: topic filtering, live push from HTTP changes, replay after reconnect, epoch-change detection, ping, protocol errors, and rejecting foreign origins
- **E2E (Playwright, 5 tests, against an isolated daemon):**
  - the shell connects live and shows the empty dashboard
  - ⌘K navigation and `g` shortcuts
  - settings validate, save and persist across a reload
  - changes made from another client stream into the open page
  - dark mode
- **Manual checks:**
  - visual review of light and dark themes, project cards and the command palette
  - the daemon-offline banner appears when the daemon is killed
  - after a restart the app reconnects and refetches with no user action

## Phase 2: what was verified

- **Unit and integration (Vitest, 65 tests in total):**
  - Onboarding analyzer fixtures:
    - pnpm Next.js monorepo, where frameworks are found in the workspace packages
    - the npm placeholder test script is ignored
    - Django via Poetry, Go with Gin, an empty folder, and a git repo whose remote credentials get redacted
    - `.env` values never appear in the report
  - Directory browser and path safety: refuses `/`, your home folder, system folders, AgentForge's own data folder, non-empty folders for scratch projects, and duplicate projects.
  - Project lifecycle:
    - scratch projects get `git init`, a secret-safe `.gitignore` and an initial commit
    - attaching a non-git folder initialises git without committing `.env`, `.env.production` or `*.pem`
    - detected commands, stack and memory entries are stored
    - commands the user edited survive a re-analysis
    - removing a project leaves its files on disk
  - Secrets: values round-trip, ciphertext never contains the plaintext, the key file is mode 0600, and tampering or moving a value to another name is detected.
  - GitHub, against a fake API with real `git clone` from local bare repos:
    - connect, status and disconnect, with the token absent from both the DB and API responses
    - bad token rejected; import from the `gh` CLI
    - repo and owner listing
    - creating an org repo and cloning it; attaching an existing repo, cloned beside an occupied folder
    - clean 404 and 422 errors
- **E2E (Playwright, 9 tests in total):**
  - the scratch wizard end to end, including the folder picker
  - attaching a non-git folder, confirming and editing commands, then removing the project
  - the wizard blocking invalid locations
  - the Integrations page
- **Manual checks:**
  - attached this repository read-only; the analyzer found the pnpm monorepo, Next.js, Fastify, Drizzle and React, plus all five commands
  - screenshots of the wizard, folder picker and project page in light and dark themes
  - the production daemon bundle (`node dist/main.js`) boots and applies migrations
- **Not covered:** a live GitHub round-trip. The `gh` CLI on this machine isn't logged in, so GitHub is covered by the fake-API tests only.
