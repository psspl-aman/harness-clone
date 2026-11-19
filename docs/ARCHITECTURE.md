# AgentForge architecture

## Overview

```
Browser (Next.js app, :4318)
  │  REST (TanStack Query)          WebSocket /ws (LiveClient)
  ▼                                   ▲
AgentForge daemon (Fastify, :4317) ───┘
  ├─ http/security   loopback-Host + Origin guard, CORS
  ├─ routes/*        thin handlers that validate input and call services
  ├─ services/*      domain logic (settings, projects, … one per module)
  ├─ events/bus      typed in-process EventBus with a replay ring buffer
  ├─ ws/gateway      topic subscriptions, replay, backpressure, heartbeats
  └─ db/             Drizzle schema + SQL migrations on SQLite (WAL, FK on)
```

Every state change goes through a service. The service writes to SQLite and then emits a typed event on the bus. The gateway forwards each event to the browsers that are subscribed to one of its topics. The browser never polls; it updates its TanStack Query cache from these events.

## Shared contracts (`packages/shared`)

These are the single source of truth for every type that crosses the process boundary:

- **`enums.ts`**: task statuses, agent roles, engine ids, auth statuses, error kinds, and other enums.
- **`task-state.ts`**: the task state machine (`canTransition`, `assertTransition`, `statusProgress`).
  - Pipeline: `DRAFT → APPROVED → QUEUED → IN_DEVELOPMENT → IN_REVIEW → IN_TESTING → DOCUMENTING → DONE`, with a `FIXING` loop from review or testing.
  - Any queued or active task may pause (`PAUSED_QUOTA`, `PAUSED_AUTH`, `PAUSED_MANUAL`), fail, escalate to `NEEDS_HUMAN`, or be cancelled.
  - A paused task can resume only to the step it paused from (`resumeToStatus`).
- **`settings.ts`**: the `AppSettings` Zod schema, its defaults, and `deepMerge` for partial updates.
- **`events.ts`**: the `EventPayloads` map (event type → Zod payload schema), plus topic helpers.
- **`ws.ts`**: the WebSocket client and server message protocol.

The package ships as TypeScript source. `tsx` and Vitest consume it directly, Next.js consumes it through `transpilePackages`, and tsup bundles it into the daemon build.

## Events and the WebSocket protocol

Every event carries the same fields:

```
{ seq, epoch, type, topics[], ts, payload }
```

- `seq` is monotonic within one daemon process.
- `epoch` changes each time the daemon restarts.
- Topics are `global`, `project:<id>`, `task:<id>`, `run:<id>` and `terminal:<id>`.

| Client → server                         | Server → client                                         |
| --------------------------------------- | ------------------------------------------------------- |
| `subscribe {topics, sinceSeq?, epoch?}` | `hello {connectionId, epoch, seq, version}`             |
| `unsubscribe {topics}`                  | `subscribed {topics, replayed, replayTruncated}`        |
| `ping {t}`                              | `event {event}` · `pong` · `lagged {dropped}` · `error` |

**Reconnecting.** On reconnect the client re-subscribes with its last `seq` and `epoch`. The daemon replays the missed events from a 2,000-event ring buffer. Three conditions mean replay can't be trusted: the buffer was truncated, the epoch changed, or a `lagged` notice arrived. In any of those cases the client invalidates all its queries and refetches.

**Backpressure.** When a socket's send buffer goes over 4 MB, the daemon drops events for that client rather than buffering without bound. It sends a single `lagged` notice once the buffer drains.

**Heartbeats.** The daemon pings every 30 s and terminates clients that don't answer.

## Data model

`apps/daemon/src/db/schema.ts` defines every table in the spec's data model: projects, project_settings, requirements, plans, tasks (with task_status_history), task_dependencies, subtasks, agent_runs, run_events, reviews, review_comments, test_results, errors, checkpoints, engines, engine_sessions, usage_records, mcp_servers, pms_connections, pms_mappings, memory_entries, documents, terminal_sessions and settings.

Conventions:

- Ids are time-sortable strings with a prefix (`prj_…`, `tsk_…`).
- Timestamps are epoch milliseconds.
- JSON columns are typed with `$type<>()`.
- Foreign keys cascade from the project down.

Migrations live in `apps/daemon/drizzle/` and run at startup.

## Projects (Phase 2)

- **`services/fs.ts`.** A directory browser built on the daemon, because a browser can't read local paths itself. It also runs the project path safety checks (`check(path, mode)`).
- **`services/git.ts`.** Helpers built on `simple-git`:
  - `initRepo` creates the repository and makes an initial commit, so later phases can branch into worktrees.
  - `ensureSafeGitignore` adds secret-file patterns to `.gitignore`. As a second safety net, any secret-looking file that still gets staged is removed before the commit.
- **`services/github.ts`.** Uses Octokit to:
  - connect with a personal access token, or import the token from an installed `gh` CLI
  - list repositories and owners
  - create repositories
  - clone, passing the token as an `http.extraheader` through `GIT_CONFIG_*` environment variables
- **`services/secrets.ts`.** Encrypts values with AES-256-GCM, using the secret's name as associated data. The key lives in `AGENTFORGE_HOME/secret.key` with mode 0600.
- **`services/onboarding/analyzer.ts`.** A deterministic analysis with no LLM involved, which produces the `OnboardingReport`.
  - `ProjectService.runOnboarding` runs it in the background and emits `project.onboarding` and `project.updated` events.
  - It fills in only commands the user hasn't set.
  - It replaces the project memory entries that came from earlier onboarding runs.
  - Analyses interrupted by a daemon restart resume on boot.
  - Shutdown waits for any analysis still running before closing the database.

## Engines (Phase 3)

```
EngineRegistry ── AgentEngineAdapter (interface from the spec)
   │                 └─ CliAdapter (shared run loop)
   │                      ├─ ClaudeCodeAdapter   ├─ CodexAdapter
   │                      ├─ GeminiCliAdapter    ├─ AntigravityAdapter
   │                      └─ CustomCliAdapter (UI-configured template + parser)
   ├─ health loop (settings.health.engineCheckIntervalSec) → engine.updated / engine.status_changed
   ├─ per-engine FIFO concurrency gate (settings.concurrency.maxRunsPerEngine)
   └─ TerminalService (node-pty) for login flows
```

- **`engines/types.ts`:** the `AgentEngineAdapter` contract from the spec:
  - `detectInstalled`, `getAuthStatus`, `startLogin`, `logout`
  - `run(input, onEvent)`, `parseUsage`, `classifyError`
- **`engines/cli-adapter.ts`:** the run loop shared by every CLI adapter.
  - Spawns without a shell, using `execa`, and parses stdout line by line into normalised `AgentEvent`s: `session`, `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `rate_limit`, `error` and `log`.
  - Keeps a tail of stderr and supports cancellation (`AbortSignal`) and timeouts.
  - Turns the outcome into an `AgentRunResult`, with a classified `EngineError` when the run fails.
- **`engines/errors.ts`:** classifies failures as `AUTH_EXPIRED`, `QUOTA_EXPIRED`, `RATE_LIMIT`, `NETWORK`, `TOOL_ERROR` or `UNKNOWN`. `parseResetAt` extracts reset times from text: epoch suffixes, ISO timestamps, relative durations ("in 2h 5m") and clock times ("resets 3pm").
- **Run outcomes update engine status.** A quota or rate-limit failure marks the engine `QUOTA_EXHAUSTED` with `resetAt`, and auth probes don't clear that state until `resetAt` has passed. An auth failure marks it `EXPIRED`. Every status change is also written to `engine_sessions`. Phase 6 builds automatic pause and resume on top of this.
- **Status for the UI:** each engine's latest state is kept in the `engines` row (status, account, models, usage windows). `toInfo` adds the adapter's static metadata to make `EngineInfo`.
- **`services/terminals.ts`:** node-pty sessions.
  - Output is batched every 16 ms and sent as _transient_ `terminal.output` bus events, which skip the replay buffer.
  - Each session keeps 256 KB of scrollback, which late viewers load from `GET /api/terminals/:id`.
  - Input and resize arrive over REST.
  - Terminals are killed on daemon shutdown.
- **Fixtures** live in `apps/daemon/test/fixtures/engines`:
  - Claude Code and Antigravity streams were recorded from real runs and sanitized.
  - Codex and Gemini streams were built from their published event contracts, because those CLIs aren't installed on the development machine.
  - Tests drive real subprocesses through a fake CLI (`test/fake-cli.ts`) that replays a fixture and records argv, stdin, cwd and env.

## Requirement chat and Planner (Phase 4)

- **`services/planner/service.ts`, `PlannerService`:**
  - Stores chat messages in `requirements`: kind `message`, `questions`, `plan` or `error`, and status `running`, `done`, `failed` or `cancelled`.
  - Editing a message creates a new version linked through `supersedesId`.
  - Allows at most one planner run per project, with cancellation.
  - Resolves the planner engine from the project's role engines, falling back to the global default.
  - Extracts `@file` and `#TASK-KEY` references, checking them against `git ls-files` and the existing task keys.
  - Plans the wizard's requirement automatically when onboarding reports done or failed.
- **`services/planner/prompt.ts`:** builds the prompt from the project, the onboarding summary, project memory (pinned first, within `memory.maxPromptChars`), the current plan and tasks, the last 12 messages, references and attachments, the engines it may suggest, the planning rules and a strict JSON output contract per mode:
  - `generate_plan`: plan or questions
  - `add_to_plan`: tasks or questions
  - `discuss`: reply
  - `regenerate_plan`: plan
  - `regenerate_task`: task
- **`services/planner/parse.ts`:**
  - Pulls the JSON out of the reply (prefers the last fenced block, otherwise the first balanced object, aware of strings).
  - Validates it with `PlannerOutputSchema` (in `@agentforge/shared`; enums tolerate case).
  - Checks the dependency graph (`validatePlannerGraph`): duplicate refs, unknown refs or keys, self-dependencies and cycles.
  - Returns readable errors, which become the retry prompt.
- **`services/tasks.ts`, `TaskService`:** owns plans and tasks.
  - **Keys** come from the project slug (`todo-app` gives `TA-1`).
  - **Planner output** is created with refs resolved to task ids. A dependency may also name an existing task key.
  - **Status changes** go through `assertTransition`, and each one is written to `task_status_history`.
  - **Dependencies** are cycle-checked.
  - **Split:** dependents wait for every part.
  - **Merge:** content is combined and dependents are re-pointed.
  - **Reorder** and subtasks.
  - **Plan status:** a plan is `APPROVED` once it has no draft tasks left.
  - **New plans:** a new plan version supersedes the previous _draft_ plan and drops its draft tasks. Approved plans and tasks are kept.
- **`services/runs.ts`, `RunRecorder`:** every agent run gets a row in `agent_runs` (prompt, engine, session, tokens, cost, result). Its events go to `run_events`, with streamed text deltas coalesced and inserts batched, and its usage to `usage_records`. Live `run.event` and `run.finished` events go to `run:<id>` and `project:<id>`. The Phase 5 pipeline reuses it.
- **Restarts:** runs and planner messages left running by a restart are marked failed when the daemon boots.

## Orchestrator (Phase 5)

- **`services/orchestrator/orchestrator.ts`, `Orchestrator`:**
  - **Scheduler.** `tick()` runs on task and settings events (debounced) and every 3 s. It re-enters safely. Each tick, per project:
    1. `promote`: APPROVED or BLOCKED tasks go to QUEUED once every dependency is DONE. Otherwise they become BLOCKED with "Waiting for …" or "Dependency … failed". Skipped while the project is paused.
    2. `recover`: active tasks with no driver (after a restart) resume at their current step.
    3. `startQueued`: starts tasks by priority, then order, up to the project limit (`project_settings.max_concurrent_tasks`, or `concurrency.maxTasksPerProject`).
  - **Drivers.** One per running task, looping on the task's status:
    - `develop`: creates the worktree (merging unmerged dependency branches in PR mode), runs the developer, and commits.
    - `review`: the reviewer returns `ReviewOutputSchema` JSON; the verdict and comments are saved.
    - `test`: the tester returns `TestOutputSchema` JSON, then `runProjectChecks` runs install, build and test; a test result is saved.
    - `fix`: guarded by `maxFixLoops`. Sources are review, tests or human.
    - `document`: the documenter returns `DocOutputSchema` JSON, and the report and memory are written.
    - `finalize`: merges or opens the PR, serialised per project.
  - **`runRole`.** Records each run through `RunRecorder`. It:
    - commits after code-writing roles (secret files dropped) and stores per-run files and diff
    - validates JSON outputs, retrying with error feedback (in the same session when supported)
    - retries transient failures once
    - pauses on QUOTA_EXPIRED or RATE_LIMIT (`resumeAt` comes from the engine error) and on AUTH_EXPIRED
    - delivers steering messages by aborting the current run and resuming the session with your note
  - **State.** Pipeline state lives in `tasks.pipeline_state`: base commit, fix source, active role/engine/run, sessions per role, notes, last review/test ids, awaiting-merge-review flag, conflict links and merge commit. All of it is in the database, so a restart loses nothing but the in-flight run, and that step is re-run.
- **`services/orchestrator/git-ops.ts`:**
  - `ensureWorktree` (reused if it already exists), `mergeBranchesInto`, `commitAll` (never secrets), and `diff` (numstat, name-status and patch).
  - `mergeIntoWorking`: a normal merge in the checkout if the working branch is checked out and clean. Uncommitted changes give `dirty`. Otherwise `merge-tree --write-tree`, then `commit-tree`, then `update-ref`. A conflict reports the paths.
- **`services/orchestrator/verify.ts`:** runs the project's install, build and test commands through a shell in the worktree (15-minute timeout each, tail of the output kept).
- **`services/orchestrator/prompts.ts`:** one prompt builder per role. Each has a `# Role: …` header, a shared context block (project, memory, task, completed dependencies, your messages), worktree rules, and a strict JSON contract for the reviewer, tester and documenter.
- **State-machine additions:**
  - DOCUMENTING or NEEDS_HUMAN → BLOCKED (merge conflict handed off)
  - BLOCKED → DONE (merged through the conflict-resolution task)
  - NEEDS_HUMAN → DONE (merge approved)
  - FAILED or NEEDS_HUMAN → the step being retried

## Web app

- **Providers:** `next-themes` (light, dark or system), TanStack Query, `TooltipProvider`, `LiveProvider` (owns the WebSocket and maps events to cache updates and toasts), and Sonner toasts.
- **Shell:**
  - A collapsible sidebar (⌘B) with a live connection pill.
  - A top bar with the ⌘K command palette and the theme switch.
  - "g then key" navigation (`g p` for Projects, `g s` for Settings).
  - An animated banner whenever the daemon is unreachable.
- **Pages:**
  - New-project wizard (`/projects/new`): one flow for starting from scratch and one for attaching an existing project. It has a side stepper, validates each step, checks paths live, and lets you connect GitHub without leaving the wizard.
  - Project page (`/projects/[id]`): live onboarding status, editable commands showing where each was detected, stack, conventions, structure, git state, env file names, requirements, per-role engine overrides, and removal with a typed confirmation.
  - Integrations: connect GitHub.
  - Agents & Accounts (`/agents`): one card per engine.
    - Status pill (with a reset countdown when a limit is hit), version and account.
    - Usage-window bars.
    - Install command and guide when the engine isn't installed.
    - Login dialog with an embedded xterm, and a test-run dialog that streams live events.
    - Configuration: enabled, default model, executable override, API key, logout.
    - Custom CLI engine editor.
  - A global engine banner for expired sessions or exhausted usage on engines that default roles use.
  - Project workspace (`/projects/[id]`): the requirement chat on the left (collapsible; a tab on narrow screens), with **Plan & Tasks** and **Overview** tabs.
    - The chat shows markdown messages, clarifying-question cards with clickable answers, plan cards, error cards with Try again, a live "Planner is working" bubble streaming tool steps, and a composer with intent, `@`/`#` autocomplete, attachments and editing.
    - Plan & Tasks shows the plan summary and List, Board and Graph views, with multi-select approve and merge, plus a task drawer that autosaves edits and handles dependencies, subtasks, engines, traceability, history, split, regenerate and delete.
    - **Pipeline UI:**
      - a build bar with run counts and Pause / Resume building, plus live agent activity
      - a progress bar on each task row and card: active role, cost, fix loops, pause countdown, blocked reason, PR link
      - in the task drawer: a step tracker, context-sensitive controls (pause, resume, cancel, retry, approve-merge, request changes, message the agent), and Activity (runs with streamed logs), Changes (diff viewer), Review & tests and Report tabs
  - Projects dashboard: cards show source, stack, task progress, run status, an error badge and last activity.
  - Settings: a draft-and-diff form that sends only changed fields, validates client-side with the shared schema, and picks up changes made elsewhere live.
