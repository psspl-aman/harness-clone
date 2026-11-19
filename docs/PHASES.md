# Build phases

| #   | Phase                                                                                                                            | Status  |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | **Foundation**: monorepo, DB schema and migrations, event bus, WebSocket, UI shell, settings                                     | ✅ Done |
| 2   | **Projects**: scratch (local and GitHub) and attaching existing projects, onboarding analysis, directory browser                 | ✅ Done |
| 3   | **Engines**: adapter interface; Claude Code, Codex, Gemini/Antigravity and custom adapters; install detection; login PTY; status | ✅ Done |
| 4   | **Requirement Chat + Planner**: plan and task generation (Zod-validated JSON with retry), editing, approval gate                 | ✅ Done |
| 5   | **Orchestrator**: Dev → Review → Test → Fix → Document; worktrees, concurrency, fix loops, merge or PR                           | ✅ Done |
| 6   | **Usage & Quota**: analytics, checkpoints, auto-pause and auto-resume, engine fallback                                           | ✅ Done |
| 7   | **Run & Terminal**: run panel, preview, xterm/node-pty terminals, error matchers, "Fix with agent"                               | ⏳ Next |
| 8   | **PMS via MCP**: MCP servers, PMS connections, mapping, sync, write-back                                                         | —       |
| 9   | **Memory & Docs**: memory service and editor, task reports, Docs tab, export                                                     | —       |
| 10  | **Polish & Hardening**: safety guards, more E2E coverage, UX polish                                                              | —       |

## Phase 1: what was verified

- **Unit and integration (Vitest, 36 tests):**
  ⏳ Next
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

## Phase 3: what was verified

- **Unit and integration (Vitest, 116 tests in total):**
  - Error classification and reset-time parsing, including epoch suffixes, ISO timestamps, relative durations and clock times. Bare numbers aren't mistaken for times.
  - Every adapter driven through a real subprocess (a fake CLI replaying fixtures). The tests check:
    - exact argv, with prompts going through stdin or argv as designed
    - permission-profile mapping and resume flags
    - parsed events, session id, final text, and usage and cost
    - classified failures with `resetAt`
    - auth probes: active, expired, logged out and unknown
    - API keys passed through the environment
    - version detection
    - cancellation, timeout, a missing binary, and stderr classification
  - Registry over HTTP:
    - status history and events, settings validation
    - API keys encrypted and never returned
    - a test run streaming over the bus and recording usage
    - quota exhaustion persisting until reset
    - the per-engine concurrency limit
    - custom engine create, edit and delete, and protection of built-ins
    - login in a real PTY with scrollback and a refresh on exit
    - logout, both supported and unsupported
  - Terminals: interactive input, resize, scrollback, kill and remove, transient output, and a rejected bad cwd.
- **E2E (Playwright, 14 tests in total):**
  - engine status cards
  - a test run streaming into the dialog, with usage windows
  - login through the embedded xterm
  - the global banner for an expired session, then Re-login, then recovery
  - adding a custom CLI engine and choosing it as a default role engine in Settings
- **Against the real CLIs on the development machine:**
  - Claude Code 2.1.327 was detected inside the VS Code extension, with the right account, plan and session expiry.
  - Antigravity 1.5.11 was detected and listed 6 models.
  - Codex and Gemini CLI correctly show _Not installed_.
  - Real test prompts succeeded through Claude Code (about $0.0045 each) and Antigravity, with sessions, usage and Claude's 5-hour and 7-day windows captured.
  - The production bundle boots, detects engines and runs PTYs.
- **Not yet verified against real binaries:** Codex and Gemini CLI. Their adapters follow the published contracts (Codex `exec_events.rs` and gemini-cli `output/types.ts`). Re-record those fixtures once the CLIs are installed. Specific unknowns:
  - Codex: whether `resume` works with exec-level flags placed before it, and the `sandbox_workspace_write.network_access` override used by the `full` profile.
  - Gemini CLI: the cached-OAuth file path.

## Phase 4: what was verified

- **Unit and integration (Vitest, 145 tests in total):**
  - **JSON extraction:** bare JSON, fenced blocks, JSON wrapped in prose, braces inside strings, and the last fenced block taking priority.
  - **Planner output validation:** enum normalisation and defaults, schema errors reported with their paths, unknown, self and duplicate dependencies, cycles, and output types not allowed for the request.
  - **Task service:** keys, resolution of refs and existing keys, edits and validation, dependency cycles, split and merge, approve and unapprove with plan status and history, supersession of draft plans, manual tasks, reorder, subtasks, and locking while an agent is working.
  - **Planner end to end, through a fake Claude CLI:**
    - plan creation with traceability, prompt contents and read-only permissions, and run and usage recording
    - a retry in the same session with the error fed back, and giving up after 3 invalid answers
    - questions, then a plan without questions
    - discussing, and adding to a plan with dependencies on existing keys
    - regenerating a task or the plan
    - a usage-limit failure, one run per project, cancellation, and a missing engine
    - `@file` and `#task` references, an attachment upload that stays out of git, and requirement versioning
    - automatic planning of the wizard's requirement after onboarding
- **E2E (Playwright, 18 tests in total):**
  - chat → a live working bubble → a clarifying question → an answer with "No questions" → a plan
  - editing a task in the drawer (priority, criteria, dependency, subtask), approving one task, then Approve all
  - the board and graph views, including opening a task from the graph
  - discuss mode and `@file` autocomplete
  - the earlier specs, updated for the workspace tabs
- **Real planner run:** Claude Code with haiku planned "a tiny Celsius/Fahrenheit CLI with unit tests" on the first attempt. It produced 5 well-sized tasks (scaffold → core → parser → entry point → README) with a correct dependency chain and 4–7 verifiable criteria each. It took 56s and cost $0.015.

## Phase 5: what was verified

- **Unit and integration (Vitest, 164 tests in total).** The orchestrator suites use real git repos, worktrees and merges, real project commands, and a fake agent CLI that edits files:
  - Dependent tasks are built and merged with no-ff merges. Dependents see completed work, the checkout stays clean, and branches and worktrees are removed. The run, review, test, report and memory records are checked.
  - Secret files the agent creates are never committed.
  - Review feedback reaches the Fixer and the change is re-reviewed. When the Tester claims a pass but the project's own test command fails, the task goes to the Fixer.
  - The fix-loop limit leads to Needs you; retry grants another round.
  - A usage limit pauses the task with the reset time; resume continues the same step. A crashed step is retried once, then fails, and retry continues at that step.
  - Pause, resume and cancel. A steering message resumes the agent's session with your note.
  - The per-project concurrency limit, pause building, and switching an engine mid-run.
  - Merge conflicts produce a conflict-resolution task, which resolves them, merges, and completes the original.
  - Review before merge: request changes, then approve the merge.
  - Uncommitted changes in your checkout block the merge until cleaned. When the working branch isn't checked out, the merge doesn't touch your files.
  - A daemon restart mid-review resumes at the review step.
  - Pull-request mode, against a fake GitHub API and a real bare remote: a push and a PR per task, the report as the PR body, and dependent work stacked on the unmerged branch.
- **E2E (Playwright, 20 tests in total):**
  - plan, approve, then watch live building to Done and the merge into the repo
  - the drawer's Activity, Changes, Review & tests and Report tabs
  - review before merge: request changes, then approve and merge
- **Real pipeline run.** Claude Code with haiku built "greet.js with node:test tests" from an approved one-task plan in about 1 minute, for $0.033 across 4 role runs (each ran once with no retries).
  - The Developer wrote the module, the tests and `package.json`.
  - The Reviewer approved, with 2 comments.
  - The Tester added coverage for untested criteria (11 tests). AgentForge's own `node --test` passed.
  - The Documenter wrote a README.
  - The work merged with `--no-ff` into `main`. The checkout is clean and the tests pass in the repo.

## Phase 6: what was verified

- **Unit and integration (Vitest, 173 tests in total):**
  - A quota pause saves a checkpoint, and at the reset time the scheduler resumes the same CLI session (`--resume` with a "you were interrupted" prompt).
  - Exponential backoff probing when no reset time is known: the wait doubles, then the task resumes and completes.
  - Fallback to a second engine with no pause.
  - A login pause resumes once the engine is active again.
  - No new work starts on an exhausted engine.
  - The usage summary: totals, estimated share, and the day, week, project, engine, role, top-task and task-type breakdowns, plus engine filtering.
  - Cost estimation from the price table.
  - Usage windows against a configured limit (only the last N hours count).
  - Per-project pipeline overrides.
- **E2E (Playwright, 23 tests in total):** the Usage dashboard (table view, measure switch, windows), price-table edits including removal, and project pipeline and fallback settings.
- **Visual check:** the Usage page in light and dark mode against real recorded runs. The meter colours use the fixed status palette, always with an icon and label; the dark-mode set was re-picked after the palette validator flagged two colours that were too similar.
