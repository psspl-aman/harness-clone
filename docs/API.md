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
