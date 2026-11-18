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
