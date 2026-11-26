# Daemon REST API

The daemon listens on `http://127.0.0.1:4317` by default.

**Formats.** Request and response bodies are JSON. Errors always have the shape `{ "error": { "code", "message", "details?" } }`. Input is validated with the Zod schemas in `@ai-harness/shared`.

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

| Method | Path                                    | Description                                                                                                                                                   |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects`                         | Dashboard summaries                                                                                                                                           |
| POST   | `/api/projects`                         | Creates a project; the body is a `CreateProjectInput` (shape below). Returns 201 with `ProjectDetail` and starts the onboarding analysis                      |
| GET    | `/api/projects/:id`                     | `ProjectDetail`, including the onboarding report and the per-role engine overrides                                                                            |
| PATCH  | `/api/projects/:id`                     | `{ name?, description?, stackPreferences?, commands?, roleEngines? }`. `commands.services` lists servers that run together (below). Unknown keys are rejected |
| DELETE | `/api/projects/:id`                     | Removes the project from AI Harness. Files on disk are untouched                                                                                              |
| POST   | `/api/projects/:id/analyze`             | Re-runs the onboarding analysis (202)                                                                                                                         |
| POST   | `/api/projects/:id/commands/suggest`    | A read-only agent run that proposes the project's commands (202, `CommandSuggestionDto` with `status: running`). 409 while one runs                           |
| GET    | `/api/projects/:id/commands/suggestion` | `{ suggestion }`: the latest `CommandSuggestionDto` (`commands`, `services`, `notes`, `status`, `error`) or null. Nothing is saved                            |
| DELETE | `/api/projects/:id/commands/suggestion` | Cancel or dismiss the suggestion                                                                                                                              |
| GET    | `/api/projects/:id/cost`                | `ProjectCostDto`: all-time `summary` (a `UsageSummaryDto`, `byDay` limited to 30 days), task counts, `perDoneTask` and a `forecast` for open tasks            |
| GET    | `/api/projects/:id/requirements`        | Requirement messages for the project                                                                                                                          |

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
| POST   | `/api/tasks/:id/pause`, `/resume`, `/cancel`, `/retry` | Task controls. Each returns the updated `TaskDto`. `/resume` on a cancelled task continues at its step    |
| POST   | `/api/tasks/:id/restart`                               | Rebuilds a cancelled task from scratch (deletes its branch). Returns the updated `TaskDto`                |
| POST   | `/api/tasks/:id/steer`                                 | `{ message }`. Delivered to the running agent (restarts its step), or to the next run                     |
| POST   | `/api/tasks/:id/approve-merge`                         | Merges a task waiting for your review (also retries a merge that was blocked by uncommitted changes)      |
| POST   | `/api/tasks/:id/request-changes`                       | `{ comments }`. Sends the task back to the Fixer with your comments                                       |
| GET    | `/api/tasks/:id/runs`                                  | Run summaries: role, engine, model, status, tokens, cost, files changed, timing                           |
| GET    | `/api/tasks/:id/reviews`                               | Agent and human reviews, with comments                                                                    |
| GET    | `/api/tasks/:id/tests`                                 | Test results, including AI Harness's own check logs                                                       |
| GET    | `/api/tasks/:id/diff`                                  | `{ files: [{ path, status, additions, deletions }], patch }`. For merged tasks, the merge commit's change |
| GET    | `/api/tasks/:id/report`                                | The task report (markdown)                                                                                |

`POST /api/tasks/:id/fix` sends a FAILED or NEEDS_HUMAN task that has a branch to the Fixer, with its failure as the brief, then through review and tests (409 otherwise). `TaskDto.openErrors` counts the open errors recorded against the task.

`TaskDto.pipeline` carries `branch`, `fixLoops`, `activeRole`, `activeEngine`, `activeRunId`, `awaitingMergeReview`, `blockedReason`, `pullRequestUrl`, `resumeAt`, `tokens`, `costUsd` and `lastError`.

## Usage

| Method | Path                                            | Description                                                                                                                                                         |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/usage/summary?days=&projectId=&engineId=` | `UsageSummaryDto`: totals (tokens, cost, estimated share, unpriced runs), `byDay`, `byWeek`, `byProject`, `byEngine`, `byModel`, `byRole`, `topTasks`, `byTaskType` |
| GET    | `/api/usage/windows`                            | Per engine: CLI-reported windows (utilisation and reset time) and your configured limit (tokens used in the last N hours)                                           |
| GET    | `/api/tasks/:id/checkpoints`                    | Checkpoints saved when the task paused                                                                                                                              |

`PATCH /api/engines/:id` also accepts `windowTokenLimit` and `windowHours`. `PATCH /api/projects/:id` accepts a `pipeline` object: `maxConcurrentTasks`, `maxFixLoops`, `requireHumanReview`, `mergeStrategy` (each `null` means use the global setting), plus `fallbackEnabled` and `engineFallback`.

## Run, terminals, errors and files

| Method | Path                                            | Description                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/run`                         | `ProjectRunDto`: overall `status` (stopped, starting, running, crashed), `command`, `terminalId`, `previewUrl`, `exitCode`, and `services` (one `ServiceRunDto` per process: `name`, `status`, `port`, `url`, `terminalId`, `error`)                |
| POST   | `/api/projects/:id/run/start`                   | Start the run command, or every entry of `commands.services`, each in its own PTY. Declared ports are checked first; a busy one marks that service crashed with an `error` (409 if already running, 400 if nothing to run or every service clashes) |
| POST   | `/api/projects/:id/run/stop`                    | Stop every service (waits up to 5 s for each to exit)                                                                                                                                                                                               |
| POST   | `/api/projects/:id/run/restart`                 | Stop, then start                                                                                                                                                                                                                                    |
| POST   | `/api/projects/:id/run/:kind`                   | One-shot `build`, `test` or `install` in a new terminal; returns the `TerminalInfo`                                                                                                                                                                 |
| POST   | `/api/projects/:id/terminals`                   | New interactive shell in the project folder (`{ title? }`)                                                                                                                                                                                          |
| GET    | `/api/projects/:id/errors?status=`              | Detected errors, newest first; `status` is a comma list of `open`, `fixing`, `resolved`, `ignored`                                                                                                                                                  |
| POST   | `/api/errors/:id/fix`                           | Create a fix task for the error (409 while one is already fixing it)                                                                                                                                                                                |
| POST   | `/api/errors/:id/ignore` · `resolve` · `reopen` | Change the error's status                                                                                                                                                                                                                           |
| GET    | `/api/projects/:id/activity`                    | The latest 100 task status changes in the project                                                                                                                                                                                                   |
| GET    | `/api/projects/:id/files`                       | `{ files, truncated }`: tracked and untracked, non-ignored files                                                                                                                                                                                    |
| GET    | `/api/projects/:id/file?path=`                  | `FileContentDto` (first 1 MB). 403 for secret files, 400 for `.git/` or invalid paths                                                                                                                                                               |

`commands.services` is a list of up to 8 `{ name, command, cwd?, port? }`. `cwd` is a folder inside the project; `port` must be unique, is checked before starting (and must not be 4317/4318), and is passed to the process as `PORT`. When the list is set, Run starts all of them instead of `commands.run`; the preview is the service named web/frontend/client/app, else the first one with a URL.

Live events: `project.run` (run state changes), `error.updated` (an error was recorded or changed status) and `project.command_suggestion`.

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

## Spreadsheets (Google Sheets, Excel, CSV)

| Method | Path                       | Description                                                                                                                                                                                                                                                                |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/sheets`              | Every linked sheet (`SheetSourceDto[]`)                                                                                                                                                                                                                                    |
| POST   | `/api/sheets/preview`      | `{ kind, location, sheet?, columns? }` → `SheetPreviewDto` (`headers`, detected `columns`, worksheet names, first 50 `rows`, `warnings`)                                                                                                                                   |
| GET    | `/api/projects/:id/sheets` | The project's sheets                                                                                                                                                                                                                                                       |
| POST   | `/api/projects/:id/sheets` | Link: `name`, `kind` (`google` = a sheet link or CSV URL, `file` = an absolute `.xlsx`/`.csv`/`.tsv` path), `sheet?`, `columns?`, `pollingIntervalSec` (null = manual), `autoStart`, `autoEnrich`. 201, then the first sync runs in the background (409 if already linked) |
| PATCH  | `/api/sheets/:id`          | Update `name`, `sheet`, `columns`, `pollingIntervalSec`, `autoStart` or `autoEnrich`                                                                                                                                                                                       |
| DELETE | `/api/sheets/:id`          | Unlink (imported tasks stay)                                                                                                                                                                                                                                               |
| POST   | `/api/sheets/:id/sync`     | Sync now → `SheetSyncResultDto` (`total`, `created`, `updated`, `unchanged`, `skipped`, `conflicts`, `started`, `errors`)                                                                                                                                                  |

Columns are matched by header name (Title/Task/Name, Description/Details, Priority/Prio, ID/Key, Size/Complexity/Points, Type, Status, Acceptance criteria) unless `columns` names them. Priority accepts words (Urgent, High, Medium, Low…), P0–P9 and numbers (1 = most important); rows are imported highest priority first. Rows whose status is done/closed/cancelled/skip are not imported. Google Sheets must be shared as "Anyone with the link" or published to the web. Sheet tasks are resolved with `/api/tasks/:id/pms-conflict` like tracker tickets. Live events: `sheet.source` and `sheet.removed`.

`TaskDto.external` is set for imported tasks: `connectionId`, `provider` (`sheet` for spreadsheet rows), `id`, `url`, `updatedAt` and `conflict`. Live events: `mcp.updated`, `mcp.removed`, `pms.connections_changed`, `pms.mapping` and `pms.mapping_removed`.

## Git (branches and the work on each)

| Method | Path                                    | Description                                                                                                                                                                                       |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/git`                 | `GitOverviewDto`: `current` branch, `workingBranch`, `remotes` (credentials removed), `upstream` ahead/behind, uncommitted `changes`, `branches` (local + up to 300 recent remote), `work` groups |
| GET    | `/api/projects/:id/git/branch`          | `?name=&base=` → `GitBranchDetailDto`: commits not in `base` (default: the working branch; `base=` empty = full history), linked tasks, and the diff since the branches split                     |
| POST   | `/api/projects/:id/git/init`            | `git init` + first commit (secrets left out) when the folder has no repository. 409 if it has one                                                                                                 |
| POST   | `/api/projects/:id/git/branches`        | `{ name, from?, checkout? }` create a branch (from the working branch by default). 409 if it exists                                                                                               |
| POST   | `/api/projects/:id/git/branches/delete` | `{ name, force? }`. Refuses the current, working and default branches, and branches a running task uses. `BRANCH_UNMERGED` (409) asks for `force`                                                 |
| POST   | `/api/projects/:id/git/checkout`        | `{ branch }` switch the project folder; `origin/x` creates a local tracking branch. Refuses branches agents have checked out                                                                      |
| POST   | `/api/projects/:id/git/merge`           | `{ source, target? }` merge a local branch into `target` (the working branch by default), serialised with agent merges. `MERGE_CONFLICT` (409) changes nothing                                    |
| POST   | `/api/projects/:id/git/working-branch`  | `{ branch }` the branch agents start from and merge into                                                                                                                                          |
| POST   | `/api/projects/:id/git/commit`          | `{ message }` commit every change on the current branch; secret files are never committed (a first commit also writes a safe `.gitignore`)                                                        |
| POST   | `/api/projects/:id/git/abort`           | Abort a merge, rebase or cherry-pick left in progress                                                                                                                                             |
| POST   | `/api/projects/:id/git/fetch`           | `git fetch --prune` every remote                                                                                                                                                                  |
| POST   | `/api/projects/:id/git/pull`            | Fast-forward the current branch from its upstream (409 if they diverged)                                                                                                                          |
| POST   | `/api/projects/:id/git/push`            | `{ branch? }` push (and track) the current or given branch                                                                                                                                        |
| POST   | `/api/projects/:id/git/pull-request`    | `{ branch, base?, title?, body? }` push and open a GitHub pull request (needs a linked repo and a GitHub connection)                                                                              |

Every action returns `GitActionResultDto` (`message`, the fresh `overview`, and `url` for pull requests) and emits `project.git`. A task's `state` in `work` is `merged` (into `mergedInto`), `pull_request`, `in_progress` (on `branchName`, heading for `baseBranch`), `cancelled` or `done`. GitHub remotes use the connected token; other remotes use your own git credentials (never prompted).

## Memory and docs

| Method | Path                                            | Description                                                                                   |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/api/projects/:id/memory?search=&kind=&scope=` | Project memory (`scope=project` for knowledge, `task` for completed-task notes), pinned first |
| POST   | `/api/projects/:id/memory`                      | Add: `kind`, `title`, `content`, `tags`, `pinned`                                             |
| GET    | `/api/memory?search=&kind=`                     | Global preferences                                                                            |
| POST   | `/api/memory`                                   | Add a global preference                                                                       |
| PATCH  | `/api/memory/:id`                               | Edit or pin/unpin any entry                                                                   |
| DELETE | `/api/memory/:id`                               | Delete an entry                                                                               |
| GET    | `/api/projects/:id/docs`                        | `DocSummaryDto[]`: Markdown files in the repo (`id = file:<path>`) and task reports           |
| GET    | `/api/projects/:id/docs/item?doc=&download=`    | One document; with `download=1`, the raw Markdown as an attachment                            |
| GET    | `/api/projects/:id/docs/export`                 | Every doc in one Markdown file (`<slug>-docs.md`)                                             |

Live event: `memory.updated` (`projectId`, or `null` for global preferences). Settings: `memory.maxPromptChars` and `memory.mirrorFile`.

## Safety

| Method | Path                        | Description                                                                                                                                         |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/safety/check`         | Called by the guard hook (per-run `x-ai-harness-guard` header) with `{ tool, input, cwd }` → `{ decision: allow \| deny \| pending, reason?, id? }` |
| POST   | `/api/safety/wait`          | Called by the hook while a decision is pending: `{ id }` → the same shape (holds about 20 s per call)                                               |
| GET    | `/api/safety/approvals`     | Pending requests and the latest 100 decisions (`SafetyApprovalDto`)                                                                                 |
| POST   | `/api/safety/approvals/:id` | `{ decision: 'approve' \| 'deny' }`. Requires the web app's `Origin` (scripts get 403)                                                              |

Live event: `safety.approval` (a request was created, answered, expired or blocked).

## Agent tools (MCP) and paused tasks

| Method | Path                | Description                                                                                                                              |
| ------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/mcp`              | MCP Streamable HTTP endpoint (stateless) for agents during a run; requires the run's `x-ai-harness-guard` header (401 once the run ends) |
| GET    | `/api/tasks/paused` | Tasks paused for quota or login in every project (`PausedTaskDto[]`), soonest resume first                                               |
