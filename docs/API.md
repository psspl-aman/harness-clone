# Daemon REST API

The daemon listens on `http://127.0.0.1:4317` by default.

**Formats.** Request and response bodies are JSON. Errors always have the shape `{ "error": { "code", "message", "details?" } }`. Input is validated with the Zod schemas in `@agentforge/shared`.

**Live updates.** These come over the WebSocket at `/ws`. See [ARCHITECTURE.md](ARCHITECTURE.md#events-and-the-websocket-protocol).

## System and settings

| Method | Path            | Description                                                                                |
| ------ | --------------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/health`   | `{ ok, epoch }`                                                                            |
| GET    | `/api/system`   | Version, data directory, database path, workspace folder, uptime and live connection count |
| GET    | `/api/settings` | Current `AppSettings`                                                                      |
| PATCH  | `/api/settings` | Deep-partial update. The result is validated and a `settings.updated` event is emitted     |

## Filesystem

| Method | Path                                         | Description                                                                                                                                      |
| ------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/fs/browse?path=&hidden=0\|1`           | Sub-folders of `path` (defaults to your home folder), plus whether the folder is writable, whether it is a git repo, and how many files it holds |
| POST   | `/api/fs/mkdir`                              | Body `{ parent, name }`. Creates a folder and returns its listing                                                                                |
| GET    | `/api/fs/check?path=&mode=scratch\|existing` | Checks whether `path` can be used as a project root. Returns `ok`, `reason`, `warnings`, `isGitRepo`, `empty` and related fields                 |

## GitHub

| Method | Path                     | Description                                                                                                                       |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/github/status`     | Whether GitHub is connected, the login, granted scopes, how the token was provided, and whether a logged-in `gh` CLI is available |
| POST   | `/api/github/connect`    | Body `{ token }`. Verifies the token with `GET /user`, then stores it encrypted                                                   |
| POST   | `/api/github/import-cli` | Connects using the token from `gh auth token`                                                                                     |
| DELETE | `/api/github/connection` | Forgets the token                                                                                                                 |
| GET    | `/api/github/repos?q=`   | Repositories you can access, most recently updated first, filtered by `q`                                                         |
| GET    | `/api/github/owners`     | Your user account and your organisations                                                                                          |

## Projects

| Method | Path                             | Description                                                                                                                              |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects`                  | Dashboard summaries                                                                                                                      |
| POST   | `/api/projects`                  | Creates a project; the body is a `CreateProjectInput` (shape below). Returns 201 with `ProjectDetail` and starts the onboarding analysis |
| GET    | `/api/projects/:id`              | `ProjectDetail`, including the onboarding report and the per-role engine overrides                                                       |
| PATCH  | `/api/projects/:id`              | `{ name?, description?, stackPreferences?, commands?, roleEngines? }`. Unknown keys are rejected                                         |
| DELETE | `/api/projects/:id`              | Removes the project from AgentForge. Files on disk are untouched                                                                         |
| POST   | `/api/projects/:id/analyze`      | Re-runs the onboarding analysis (202)                                                                                                    |
| GET    | `/api/projects/:id/requirements` | Requirement messages for the project                                                                                                     |

`CreateProjectInput` takes one of two shapes:

```jsonc
// From scratch
{ "mode": "scratch", "name": "Todo", "location":
    { "kind": "local", "parentDir": "/home/me/code", "folderName": "todo" }
  // or { "kind": "github", "repo": { "action": "create", "owner": "me", "name": "todo", "private": true } }
  // or { "kind": "github", "repo": { "action": "existing", "fullName": "me/todo" } }
  , "stackPreferences": "Next.js", "roleEngines": { "reviewer": "codex" }, "initialRequirement": "…" }

// Existing project
{ "mode": "existing", "location": { "kind": "local", "path": "/home/me/app", "initGit": true } }
//                 or { "kind": "github", "fullName": "me/app" }
```

## Engines

The built-in engine ids are `claude-code`, `codex`, `gemini-cli` and `antigravity`. Custom engines use `custom:<slug>`.

| Method | Path                       | Description                                                                                                                                              |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/engines`             | `EngineInfo[]`: install, version, path, auth status, account, models, usage windows and capabilities                                                     |
| POST   | `/api/engines/refresh`     | Re-checks every enabled engine                                                                                                                           |
| GET    | `/api/engines/:id`         | One engine                                                                                                                                               |
| PATCH  | `/api/engines/:id`         | `{ enabled?, binaryPath?, defaultModel? }`                                                                                                               |
| POST   | `/api/engines/:id/refresh` | Re-checks one engine                                                                                                                                     |
| PUT    | `/api/engines/:id/api-key` | Body `{ apiKey }`. Stored encrypted; never returned                                                                                                      |
| DELETE | `/api/engines/:id/api-key` | Removes the stored key                                                                                                                                   |
| POST   | `/api/engines/:id/login`   | Starts the CLI's login in a PTY. Returns `{ terminal, hint }`                                                                                            |
| POST   | `/api/engines/:id/logout`  | Logs out (409 when the CLI has no logout command)                                                                                                        |
| POST   | `/api/engines/:id/test`    | `{ prompt?, model? }`. Starts a read-only test run and returns `{ runId }` (202). Events arrive as `run.event` and `run.finished` on topic `run:<runId>` |
| POST   | `/api/runs/:runId/cancel`  | Cancels a test run                                                                                                                                       |
| POST   | `/api/engines/custom`      | `{ slug, displayName, config: CustomEngineConfig }`                                                                                                      |
| PUT    | `/api/engines/:id/custom`  | `{ displayName, config }`                                                                                                                                |
| DELETE | `/api/engines/:id`         | Removes a custom engine (built-in engines can only be disabled)                                                                                          |

## Terminals

| Method | Path                              | Description                                  |
| ------ | --------------------------------- | -------------------------------------------- |
| GET    | `/api/terminals?projectId=&kind=` | Terminals currently open                     |
| GET    | `/api/terminals/:id`              | `TerminalInfo` plus `scrollback`             |
| POST   | `/api/terminals/:id/input`        | Body `{ data }`. Writes raw input to the PTY |
| POST   | `/api/terminals/:id/resize`       | Body `{ cols, rows }`                        |
| POST   | `/api/terminals/:id/kill`         | Sends SIGHUP to the process                  |
| DELETE | `/api/terminals/:id`              | Kills the terminal and forgets it            |

Live output arrives as transient `terminal.output` events (`{ terminalId, data }`) on topic `terminal:<id>`, followed by `terminal.exit`.

## Requirement chat and Planner

| Method | Path                               | Description                                                                                                                                                                                        |
| ------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/chat`           | `ChatMessageDto[]`: your messages, the Planner's replies, questions, plans and errors, plus system notes                                                                                           |
| POST   | `/api/projects/:id/chat`           | Body `{ content, intent: generate_plan\|add_to_plan\|discuss, attachmentIds?, skipQuestions?, supersedesId? }`. Stores the message and starts the Planner. Returns 409 while it is already running |
| GET    | `/api/projects/:id/planner`        | `PlannerState`: `{ running, runId, messageId, engineId, startedAt }`                                                                                                                               |
| POST   | `/api/projects/:id/planner/cancel` | Cancels the running planner                                                                                                                                                                        |
| GET    | `/api/projects/:id/references?q=`  | Suggestions for `@file` and `#task`                                                                                                                                                                |
| POST   | `/api/projects/:id/attachments`    | Multipart upload (up to 20 MB per file). Returns `AttachmentDto[]`                                                                                                                                 |
| GET    | `/api/runs/:id`                    | The run record plus its persisted events                                                                                                                                                           |

## Plans and tasks

| Method               | Path                                      | Description                                                                                                                                              |
| -------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET                  | `/api/projects/:id/board`                 | `{ plans, tasks }` (superseded plans are omitted)                                                                                                        |
| POST                 | `/api/projects/:id/tasks/reorder`         | Body `{ taskIds }`                                                                                                                                       |
| PATCH                | `/api/plans/:id`                          | `{ goal?, scope?, outOfScope?, architectureNotes?, risks?, assumptions? }`                                                                               |
| POST                 | `/api/plans/:id/approve`                  | `{ taskIds? }`. Approves every draft task, or the given subset                                                                                           |
| POST                 | `/api/plans/:id/regenerate`               | `{ instructions }`. Planner re-drafts the plan (drafts only)                                                                                             |
| POST                 | `/api/plans/:id/tasks`                    | Adds a task manually: `{ title, description?, type?, priority?, complexity?, acceptanceCriteria?, affectedAreas?, roleEngines?, dependsOn?, subtasks? }` |
| GET / PATCH / DELETE | `/api/tasks/:id`                          | Reads, edits or deletes a task. Editing is refused (409) while an agent is working on it                                                                 |
| GET                  | `/api/tasks/:id/history`                  | Status history                                                                                                                                           |
| PUT                  | `/api/tasks/:id/dependencies`             | `{ dependsOn }`. Cycle-checked                                                                                                                           |
| POST                 | `/api/tasks/:id/split`                    | `{ parts: [{ title, description? }] }` (2 to 8 parts)                                                                                                    |
| POST                 | `/api/tasks/merge`                        | `{ taskIds, title? }`. Merges into the first task                                                                                                        |
| POST                 | `/api/tasks/:id/approve` and `/unapprove` | Moves the task Draft → Approved, or Approved → Draft                                                                                                     |
| POST                 | `/api/tasks/:id/regenerate`               | `{ instructions }`. Planner rewrites the task in place                                                                                                   |
| POST                 | `/api/tasks/:id/subtasks`                 | `{ title }`                                                                                                                                              |
| PATCH / DELETE       | `/api/subtasks/:id`                       | `{ title?, done?, orderIndex? }`                                                                                                                         |

## Pipeline

| Method | Path                                                   | Description                                                                                               |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/pipeline`                           | `{ paused, running: [{ taskId, key, role, engineId, runId }], queued, limit }`                            |
| POST   | `/api/projects/:id/pipeline/pause` and `/resume`       | Pauses or resumes starting new tasks in the project                                                       |
| POST   | `/api/tasks/:id/pause`, `/resume`, `/cancel`, `/retry` | Task controls. Each returns the updated `TaskDto`                                                         |
| POST   | `/api/tasks/:id/steer`                                 | `{ message }`. Delivered to the running agent (restarts its step), or to the next run                     |
| POST   | `/api/tasks/:id/approve-merge`                         | Merges a task waiting for your review (also retries a merge that was blocked by uncommitted changes)      |
| POST   | `/api/tasks/:id/request-changes`                       | `{ comments }`. Sends the task back to the Fixer with your comments                                       |
| GET    | `/api/tasks/:id/runs`                                  | Run summaries: role, engine, model, status, tokens, cost, files changed, timing                           |
| GET    | `/api/tasks/:id/reviews`                               | Agent and human reviews, with comments                                                                    |
| GET    | `/api/tasks/:id/tests`                                 | Test results, including AgentForge's own check logs                                                       |
| GET    | `/api/tasks/:id/diff`                                  | `{ files: [{ path, status, additions, deletions }], patch }`. For merged tasks, the merge commit's change |
| GET    | `/api/tasks/:id/report`                                | The task report (markdown)                                                                                |

`TaskDto.pipeline` carries `branch`, `fixLoops`, `activeRole`, `activeEngine`, `activeRunId`, `awaitingMergeReview`, `blockedReason`, `pullRequestUrl`, `resumeAt`, `tokens`, `costUsd` and `lastError`.

## Usage

| Method | Path                                            | Description                                                                                                                                                         |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/usage/summary?days=&projectId=&engineId=` | `UsageSummaryDto`: totals (tokens, cost, estimated share, unpriced runs), `byDay`, `byWeek`, `byProject`, `byEngine`, `byModel`, `byRole`, `topTasks`, `byTaskType` |
| GET    | `/api/usage/windows`                            | Per engine: CLI-reported windows (utilisation and reset time) and your configured limit (tokens used in the last N hours)                                           |
| GET    | `/api/tasks/:id/checkpoints`                    | Checkpoints saved when the task paused                                                                                                                              |

`PATCH /api/engines/:id` also accepts `windowTokenLimit` and `windowHours`. `PATCH /api/projects/:id` accepts a `pipeline` object: `maxConcurrentTasks`, `maxFixLoops`, `requireHumanReview`, `mergeStrategy` (each `null` means use the global setting), plus `fallbackEnabled` and `engineFallback`.

## Run, terminals, errors and files

| Method | Path                                            | Description                                                                                                        |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/projects/:id/run`                         | `ProjectRunDto`: `status` (stopped, starting, running, crashed), `command`, `terminalId`, `previewUrl`, `exitCode` |
| POST   | `/api/projects/:id/run/start`                   | Start the project's run command in a PTY (409 if already running, 400 if no run command)                           |
| POST   | `/api/projects/:id/run/stop`                    | Stop it (waits up to 5 s for the process to exit)                                                                  |
| POST   | `/api/projects/:id/run/restart`                 | Stop, then start                                                                                                   |
| POST   | `/api/projects/:id/run/:kind`                   | One-shot `build`, `test` or `install` in a new terminal; returns the `TerminalInfo`                                |
| POST   | `/api/projects/:id/terminals`                   | New interactive shell in the project folder (`{ title? }`)                                                         |
| GET    | `/api/projects/:id/errors?status=`              | Detected errors, newest first; `status` is a comma list of `open`, `fixing`, `resolved`, `ignored`                 |
| POST   | `/api/errors/:id/fix`                           | Create a fix task for the error (409 while one is already fixing it)                                               |
| POST   | `/api/errors/:id/ignore` · `resolve` · `reopen` | Change the error's status                                                                                          |
| GET    | `/api/projects/:id/activity`                    | The latest 100 task status changes in the project                                                                  |
| GET    | `/api/projects/:id/files`                       | `{ files, truncated }`: tracked and untracked, non-ignored files                                                   |
| GET    | `/api/projects/:id/file?path=`                  | `FileContentDto` (first 1 MB). 403 for secret files, 400 for `.git/` or invalid paths                              |

Live events: `project.run` (run state changes) and `error.updated` (an error was recorded or changed status).

## MCP servers and issue trackers

| Method | Path                          | Description                                                                                                                         |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/mcp/servers`            | `McpServerDto[]`. Secret env vars and headers come back as `{ key, secret: true, value: null }`                                     |
| POST   | `/api/mcp/servers`            | Create: `name`, `transport` (`stdio`, `http`, `sse`), `command` + `args` + `env`, or `url` + `headers`, `enabled`                   |
| PUT    | `/api/mcp/servers/:id`        | Replace the config. A secret sent without a value keeps the stored one                                                              |
| DELETE | `/api/mcp/servers/:id`        | Remove the server, its secrets and its tracker connections                                                                          |
| POST   | `/api/mcp/servers/:id/test`   | Connect, list tools, and store `lastStatus`, `lastError` and `tools`                                                                |
| GET    | `/api/pms/providers`          | Provider presets: suggested server setup, tool map and status map                                                                   |
| GET    | `/api/pms/connections`        | `PmsConnectionDto[]`                                                                                                                |
| POST   | `/api/pms/connections`        | Create: `name`, `provider`, `mcpServerId`, `toolMap` (`list`, `get`, `updateStatus`, `comment`, `fields`)                           |
| PUT    | `/api/pms/connections/:id`    | Replace a connection                                                                                                                |
| DELETE | `/api/pms/connections/:id`    | Remove a connection and its project links                                                                                           |
| POST   | `/api/pms/detect`             | `{ mcpServerId, provider }` → suggested `PmsToolMap` from the server's tools                                                        |
| POST   | `/api/pms/preview`            | `{ mcpServerId, toolMap, externalProject, filters? }` → `{ issues, total }` (first 25), without saving anything                     |
| GET    | `/api/projects/:id/pms`       | The project's tracker links (`PmsMappingDto[]`)                                                                                     |
| POST   | `/api/projects/:id/pms`       | Link: `connectionId`, `externalProject`, `statusMap`, `filters`, `pollingIntervalSec`, `writeBack`, `autoEnrich` (409 if duplicate) |
| PATCH  | `/api/pms/mappings/:id`       | Update a link                                                                                                                       |
| DELETE | `/api/pms/mappings/:id`       | Unlink (imported tasks stay)                                                                                                        |
| POST   | `/api/pms/mappings/:id/sync`  | Sync now → `PmsSyncResultDto` (`total`, `created`, `updated`, `unchanged`, `skipped`, `conflicts`, `errors`)                        |
| POST   | `/api/tasks/:id/pms-conflict` | `{ action: 'apply' \| 'dismiss' }` for a ticket that changed while the task was in progress                                         |

Tool-map argument templates: a string that is exactly `{{var}}` is replaced by the raw value (`{{var|number}}` converts to a number), and `{{var}}` inside a longer string is interpolated. Arguments that render empty are dropped. Variables: `project`, `owner` and `repo` (from `owner/repo`), `limit`, `filters.assignee`, `filters.sprint`, `filters.labels`, `filters.status`, plus `issueId`, `status` and `body` for write-back.

`TaskDto.external` is set for imported tasks: `connectionId`, `provider`, `id`, `url`, `updatedAt` and `conflict`. Live events: `mcp.updated`, `mcp.removed`, `pms.connections_changed`, `pms.mapping` and `pms.mapping_removed`.
