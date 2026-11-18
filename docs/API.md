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
