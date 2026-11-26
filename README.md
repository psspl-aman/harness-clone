# AI Harness

A local-first harness in which specialised AI coding agents (Planner, Developer, Reviewer, Tester, Fixer, Documenter) work together. They can build a new project from scratch or work on an existing one. Work comes from a requirement chat or from tickets pulled in from a PMS tool over MCP.

AI Harness is single-user and has no login of its own. Everything runs on your machine: a Node daemon holds the state in SQLite, and a Next.js web app talks to it over REST and a WebSocket.

> **Status:** all 10 build phases are complete. See [docs/PHASES.md](docs/PHASES.md) for what each phase delivered and how it was verified.

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

## Setup guide

1. **Install the prerequisites.**
   - Node.js 22 or newer, and pnpm (`corepack enable`).
   - Git.
   - At least one agent CLI:
     - [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) (`claude`; the VS Code extension's bundled binary is found automatically)
     - OpenAI Codex CLI (`codex`)
     - Google Antigravity (`agy`) or Gemini CLI (`gemini`)
2. **Start AI Harness.**
   - Run `pnpm install`, then `pnpm dev`, and open <http://localhost:4318>.
   - For an always-on setup, build once with `pnpm build` and run `pnpm start`. It serves the same ports with the production web build.
   - `NEXT_PUBLIC_AI_HARNESS_DAEMON_URL` is baked in at build time, so set it before `pnpm build` if the daemon runs elsewhere.
3. **Sign in to your agents.**
   - Open **Agents & Accounts**. Each engine shows whether it is installed and whether its session is _Active_ or _Expired_.
   - **Log in** runs the CLI's own login in an embedded terminal. You can also save an API key, which is stored encrypted.
   - **Test** sends a one-line prompt.
4. **Choose who does what.** In **Settings → Default engines**, pick an engine for each role (Planner, Developer, Reviewer, Tester, Fixer, Documenter). Projects can override these.
5. **Optional connections (Integrations):**
   - A GitHub token, to create or clone repositories and open pull requests.
   - Issue trackers through MCP.
   - Spreadsheets (Google Sheets, Excel, CSV) as a task list.
6. **Create a project.**
   - **Projects → New project.** Start from scratch in a local folder or a GitHub repository, or attach an existing project.
   - Describe what you want in the chat, review the plan and tasks, and approve them.
7. **Watch it build.**
   - Each task goes through Develop → Review → Test → Fix → Document in its own git worktree, then merges.
   - The **Plan & Tasks** tab shows live progress. **Run**, **Preview** and the **Terminals** panel let you try the result.

**Your data.**

- Everything lives in `~/.ai-harness` (or `AI_HARNESS_HOME`):
  - `ai-harness.db` (SQLite)
  - `secret.key`, which encrypts tokens and API keys. Keep it private, and back it up together with the database.
  - `worktrees/` for tasks in progress
  - `workspaces/` for cloned repositories
- Projects stay in the folders you chose. Removing a project from AI Harness never deletes its files.

**Troubleshooting.**

| Symptom                                         | What to do                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| "Daemon unreachable" banner                     | Start the daemon (`pnpm dev:daemon`) and check that port 4317 is free (`AI_HARNESS_PORT`).                                              |
| An engine shows _Not installed_                 | Install the CLI, or set its path under Agents & Accounts → Configure, then **Refresh**.                                                 |
| An engine shows _Expired_                       | Log in again from Agents & Accounts. Tasks paused for login resume by themselves afterwards.                                            |
| A task is _Paused · quota_                      | The engine's usage window ran out. The task resumes at the shown time, or set a fallback engine (Project → Overview → Pipeline).        |
| A merge is _Blocked_                            | Your checkout has uncommitted changes, or the branches conflict. Commit or stash your changes, or let the conflict-resolution task run. |
| An agent is waiting for approval                | A card in the bottom-right corner shows the command. Allow or deny it; with no answer it is denied after 10 minutes.                    |
| `better-sqlite3` or `node-pty` fails to install | Install a C/C++ toolchain (`build-essential` / Xcode command-line tools) and run `pnpm install` again.                                  |

## Safety

- **Agents work inside the project.** Each task runs in its own git worktree, and AI Harness commits and merges; agents are told not to.
- **Guarded tool calls (Claude Code).** Before every tool call, a pre-tool-use hook asks AI Harness whether it may run:
  - **Blocked:** catastrophic commands, such as recursive deletes of `/`, `~` or other projects, disk formatting or fork bombs, and file edits outside the project.
  - **Asks you:** risky commands. These include `git push` (and force-push), `sudo`, piping a download into a shell, printing the environment, touching `.env` or key files, and writing outside the project. A card appears in the app. _Allow once_ or _Deny_; with no answer the command is denied after 10 minutes. You can turn the questions off in **Settings → Safety** (blocks still apply).
  - Other engines run with their own permission modes and sandboxes. Codex, for example, uses its workspace-write sandbox.
- **AI Harness tools for agents.** Claude Code agents also get an `ai-harness` MCP server for their run. With it they can search and add to project memory, read their task, related tasks and finished tasks' reports, and see the project's open errors.
- **Secrets.**
  - Tokens and API keys are stored encrypted (AES-256-GCM).
  - Secret files (`.env`, keys) are never committed by AI Harness and never shown in the Code tab.
  - With **Redact secrets from logs** on (the default), stored secrets and common token formats are masked in agent logs and terminals.
- **Local only.** The daemon only answers on loopback and only to the AI Harness web app's origin.

## Projects and GitHub

- **New project from scratch.** Choose a local folder (AI Harness creates it and runs `git init`) or a GitHub repository (create a new one or pick an existing one). Then add stack preferences, per-role agent engines and an initial requirement.
- **Attach an existing project.** Choose a local folder or a GitHub repository to clone.
  - If a local folder isn't a git repository yet, AI Harness can initialise one. Its initial commit never includes `.env*`, `*.pem` or `*.key` files.
  - Attaching never deletes or rewrites your files. Removing a project from AI Harness leaves the folder untouched.
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

  The token is stored encrypted (AES-256-GCM) under `AI_HARNESS_HOME`. When cloning, it is passed to git through environment variables, so it never appears in `.git/config` or in process arguments.

Clones go to `<workspace folder>/<owner>/<repo>`. The workspace folder defaults to `~/.ai-harness/workspaces` and can be changed in Settings.

## Agent engines

Open **Agents & Accounts** to see each supported agent CLI: whether it's installed, its version, and whether you're signed in. That page is also where you log in, test an engine, and configure it.

| Engine       | Detected as                                                                                 | Headless mode used                                                  | Sign-in check                              |
| ------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| Claude Code  | `claude` on PATH, `~/.claude/local/claude`, or the newest VS Code / Cursor extension binary | `claude -p --output-format stream-json --verbose` (prompt on stdin) | `claude auth status --json`                |
| OpenAI Codex | `codex`                                                                                     | `codex exec --json … -` (prompt on stdin)                           | `codex login status`                       |
| Gemini CLI   | `gemini`                                                                                    | `gemini -o stream-json --approval-mode … -p`                        | API key, or a cached Google sign-in        |
| Antigravity  | `agy` (not the `antigravity` IDE launcher)                                                  | `agy -p … --output-format stream-json --mode …`                     | `agy models` (also lists available models) |
| Custom CLI   | any executable                                                                              | argument template + text or JSON-lines parser, configured in the UI | optional auth-check command                |

- **Login** runs the CLI's own login command in an embedded terminal (xterm.js + node-pty). AI Harness never sees your credentials; they stay with the CLI. The button only appears when the CLI isn't signed in (or its session expired). To switch accounts, use **Configure → Log out** first.
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
  - Attachments are stored in `<project>/.ai-harness/attachments/`. That folder is kept out of git through `.git/info/exclude`, so none of your tracked files change.
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

## Building: the agent pipeline

Approved tasks are built automatically. Each one goes through these steps:

**Develop → Review → Test → (Fix ↺) → Document → Merge**

- **Isolation.**
  - Every task gets its own git worktree on a branch (`af/<key>-<title>`), created from your working branch under `~/.ai-harness/worktrees/`. Your checkout isn't touched until the merge.
  - Agents don't commit. AI Harness commits after each step and never commits secret-looking files (`.env*`, `*.pem`, `*.key`, `*.p12`, `.npmrc`).
- **Roles.**
  - The Developer and Fixer can edit files and run commands. The Tester can too, but it is told to change tests only.
  - The Reviewer is read-only and must return a structured verdict with line comments.
  - The Documenter edits docs and writes the task report.
  - Each role uses its engine from the task, the project, or the global defaults.
- **Verification.** After the Tester reports, AI Harness runs the project's own **install**, **build** and **test** commands in the worktree (Overview → Commands). A failure there sends the task to the Fixer even if the Tester said everything passed.
- **Fix loop.** Requested changes go back to review after the fix, and failing tests go back to testing. After _Max fix loops_ attempts (Settings → Pipeline) the task stops in **Needs you** with a summary; **Retry this step** gives it another round.
- **Merge.**
  - **Into your branch:** if the working branch is checked out it must be clean, and the merge is a normal `--no-ff` merge there. If it isn't checked out, the merge is done without touching any checkout. If your checkout has uncommitted changes, AI Harness waits for you.
  - **Conflicts:** a follow-up **conflict-resolution task** is created automatically. It merges the working branch into the task branch and resolves the conflicts.
  - **Pull requests:** with **Open a GitHub PR** (Settings → Pipeline) on a GitHub project, the branch is pushed and a PR is opened instead. Dependent tasks build on top of unmerged dependency branches.
- **Scheduling.**
  - Tasks start once their dependencies are done, in priority order.
  - The number running at once is capped per project (_Parallel tasks per project_) and per engine.
  - **Pause building** stops new tasks from starting in a project.
  - After a daemon restart, every running task resumes at its current step.
- **Your controls** (task drawer):
  - pause, resume, cancel, or retry a failed step
  - switch a role's engine at any time
  - **message the agent** (it restarts its current step with your note, resuming its session where the engine supports that)
  - with _Require my review before merge_ on, **Approve & merge** or **Request changes**
- **Failures.**
  - An engine usage limit pauses the task (_Paused · quota_) with the reset time.
  - An expired login pauses it (_Paused · login_).
  - Other failures are retried once, then the task is marked _Failed_. From a failed task, **Fix with agent** hands the error to the Fixer on the task's branch (then review and tests run again), or **Retry this step** reruns it.
- **Records.** Every task keeps its runs (prompt, streamed events, tokens, cost), diff, reviews, test runs with logs, and a generated **report**. The Documenter also adds facts to project memory.

## Usage and quotas

- **Usage page.** Shows tokens and cost:
  - by day or week, project, engine, model and role
  - the top tasks, and the average per task type
  - the current usage windows: Claude Code's own 5-hour and 7-day windows, plus any limit you set per engine (Agents & Accounts → Configure)

  Filter by time range, project and engine, and switch between tokens and cost. Every chart has a table view.

- **Cost.** A cost reported by the CLI (Claude Code) is used as is. Otherwise AI Harness estimates it from **Settings → Pricing** (USD per 1M tokens, by model id or engine id). Runs with no matching price are counted as _unpriced_.
- **Auto-pause and auto-resume.**
  - When an engine hits its usage limit, the task pauses (_Paused · quota_), a **checkpoint** is saved (step, branch, CLI session, partial output), and you see when it resumes.
  - At that time the scheduler re-checks the engine and continues the **same CLI session** where the engine supports resuming; otherwise it reruns the step with a summary of the earlier progress.
  - If the error didn't say when the window resets, AI Harness retries with exponential backoff (Settings → Usage & sessions).
  - A task paused for login (_Paused · login_) resumes as soon as the engine is active again.
  - New tasks don't start on an engine whose window is exhausted.
- **Engine fallback.** Project → Overview → Pipeline. With fallback enabled and an engine chosen for each primary, a step that hits a usage limit continues immediately on the fallback engine, which is then used for that role on that task.

## Running the project, terminals and errors

- **Run.** The project header has **Run**, which starts the project's run command (Overview → Commands) in a terminal. While it runs you get **Stop** and **Restart**. The menu next to it runs **Build**, **Run tests** and **Install dependencies** once each.
- **Suggested commands.** **Overview → Commands → Suggest with AI** has an agent read the project (read-only) and propose install, run, build, test and lint commands, with notes such as env vars to set first. Nothing changes until you click **Use these**. Projects built from scratch also get their commands re-detected automatically once code lands.
- **Several servers.** Apps that need more than one process (say a frontend, an API and a worker) list each under **Overview → Commands → Several servers?** with a name, command, folder and port. **Run** starts them all, each in its own terminal, with `PORT` set. The header shows **2/3 servers** with each one's status and URL. Ports are checked before starting, so a port that's already taken (by another app, an earlier run, or AI Harness itself on 4317/4318) is reported on that server instead of crashing it. The Preview tab switches between the servers' URLs.
- **Cost.** **Overview → Cost & token usage** shows what agents have spent on the project: total cost, input and output tokens, runs, agent time, cost per day, and breakdowns by role, engine and model and the most expensive tasks. Once a task is finished it also forecasts what the open tasks will likely cost.
- **Preview.** The local URL your dev server prints is picked up and shown in the **Preview** tab. You can type another URL or open it in a new browser tab.
- **Code.** A read-only browser of the project's files (respecting `.gitignore`) with syntax highlighting. Files that may contain secrets, such as `.env`, are never shown.
- **Agents.** The bottom panel's **Agents** tab streams the live output of every agent working on the project.
- **Changes.** **Code → Changes** shows the diff of each task agents have worked on.
- **Terminals.** The bottom panel holds the run and build terminals and any shells you open (**New terminal**) in the project folder.
- **Errors.** AI Harness watches terminal and run output and the pipeline for errors: TypeScript, JavaScript stack traces, Python tracebacks, Go, Rust, Java, failing tests, bundler errors and crashed processes. Repeats are grouped with a count. **Fix with agent** creates a bug task that goes Fix → Review → Test → Document and merges like any other; the error is marked resolved when it's done. You can also ignore, resolve or reopen errors, or jump to the file and line.
- **Activity.** Every task status change in the project, newest first.

## Issue trackers (via MCP)

AI Harness reads and updates Jira, Linear, GitHub Issues, Asana, ClickUp, Azure DevOps, Trello or any tracker that has an MCP server.

1. **Integrations → Issue trackers → Connect tracker.** Pick the tracker and an MCP server. **New server** is pre-filled with a suggested setup for that tracker; check it against the server's docs. Local servers run as a command (stdio); remote ones use HTTP or SSE. Tokens marked secret are encrypted and never shown again.
2. **Tools.** Click **Auto-detect** to choose which of the server's tools list issues, change status and add comments, then adjust the argument templates if needed. **Preview** shows what would be imported.
3. **Project → Overview → Issue tracker → Link.** Choose the tracker project, map its statuses to AI Harness's (for example To Do → Approved, In Progress → Developing, Done → Done), and add filters (assignee, sprint, labels, status) and polling if you like.
4. **Sync now** (or wait for polling). Open tickets become **draft tasks** with a link back to the ticket. With _Planner adds criteria and subtasks_ on, the Planner fills in acceptance criteria, affected areas and subtasks for you to review. Nothing is built until you approve.
5. **Write-back.** As a task moves through the pipeline, its ticket moves to the mapped status. When the task is done, AI Harness comments with a summary, the PR or branch, and the tokens, cost and time used.
6. **Changes during work.** If a ticket is edited or closed after you approved its task, the task shows the change. **Apply** updates the task and tells the agent (or cancels the task if the ticket was closed), or keep the task as it is.

## Spreadsheets (Google Sheets, Excel, CSV)

Keep your task list in a spreadsheet and AI Harness works through it.

1. **Integrations → Spreadsheets → Connect sheet** (or **Project → Overview → Spreadsheets**). Choose the project, then paste a Google Sheets link or the path to an `.xlsx`, `.csv` or `.tsv` file. A Google Sheet must be shared as _Anyone with the link — Viewer_ (or published to the web); AI Harness only reads it.
2. **Columns.** Put each task in a **Title** column and its **Priority** next to it: High / Medium / Low, Urgent, P0–P3, or 1, 2, 3 (1 = most important). Optional columns: Description, ID (keeps a task linked when you rename it), Size (XS–XL or story points), Type (feature, bug, docs…), Status (rows marked Done, Closed, Cancelled or Skip are left out), Acceptance criteria. **Preview** shows which column feeds what and the order agents will pick tasks up; you can override any column. **Download a template** gives you a starter file.
3. **Start working automatically** (on by default) approves new rows straight away, so agents build them highest priority first with no waiting for you. Turn it off to review each task first. **Let the Planner detail each task** adds acceptance criteria and subtasks before building, keeping your title and priority.
4. **New rows are picked up** every few minutes (or press **Sync**). Editing a row updates its task while it's still a draft. If a task is already being built, the change is shown on the task to apply or dismiss.

## Git: branches and the work on each

Open a project's **Git** tab (or click the branch name under the project title).

- **Status:** the branch the project folder is on, uncommitted changes, the remote and how far you are ahead or behind it, with **Fetch**, **Pull** and **Push**. **Agents branch from and merge into** picks the working branch for new tasks.
- **Branches:** every local branch (remote ones with the **Remote** switch) with its last commit, how many commits it is ahead of or behind the working branch, and badges for _current_, _working_, _merged_, _agent_ (an agent is working in it) and the tasks on it. Select a branch to see its commits (linked to their tasks), its tasks and the diff against any other branch. The **⋯** menu switches to it, merges it, makes it the working branch, pushes it, opens a GitHub pull request, starts a new branch from it or deletes it. A merge that would conflict changes nothing and tells you which files conflict.
- **Work by branch:** for each branch, the tasks whose work was merged into it (with the merge commit), is waiting in a pull request, or is still in progress on its own branch.
- **Changes:** uncommitted files with a box to commit them. Secret files (.env, keys) are never committed.

If the folder isn't a git repository (or has no commits yet), the tab offers to initialise it or make the first commit, since agents need a commit to branch from.

## Memory and documentation

- **Project memory (Memory tab).** Facts agents should know about the project: stack, architecture, conventions, commands, decisions, pitfalls, glossary and features. Project analysis and the Documenter add entries automatically, and you can add, edit, pin or delete your own. **Completed tasks** holds a summary of each finished task.
- **What agents see.** Every agent prompt includes pinned entries, your global preferences, conventions, commands and pitfalls, plus the entries most relevant to the task, up to the budget in **Settings → Memory & workspace**.
- **Readable copy.** Memory is mirrored to `.ai-harness/memory.md` in the project folder. It is kept out of git and can be turned off in Settings.
- **Handoff notes for switching agents.** AI Harness also keeps `.ai-harness/PROJECT.md` (overview, plan, every task's status) and `.ai-harness/tasks/<KEY>.md` (one task's spec, status history, what each agent run did, the latest review and tests). They are copied into a task's worktree before every agent run, and every prompt points to them. When a different engine takes over a task (you switched it, or a usage limit triggered a fallback), its prompt also summarises what the earlier agents did. Out of git; turn off in Settings → Memory.
- **Global preferences (Settings).** Coding style and preferred libraries, applied to every project.
- **Docs tab.**
  - Lists the project's Markdown (README, CHANGELOG, architecture and other docs, which the Documenter keeps up to date) and a **report for every finished task**: what changed and why, files, review, tests, token usage and limitations.
  - Download any document as Markdown, export everything as one file, or use **PDF** to print or save it.

## Configuration

Copy `.env.example` to `.env` if you need to change any of these defaults.

| Variable                              | Default                                       | Purpose                                                    |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `AI_HARNESS_HOME`                     | `~/.ai-harness`                               | SQLite DB, attachments, logs, managed workspaces           |
| `AI_HARNESS_HOST` / `AI_HARNESS_PORT` | `127.0.0.1` / `4317`                          | Daemon bind address                                        |
| `AI_HARNESS_WEB_PORT`                 | `4318`                                        | Used to build the default CORS/WebSocket origin allow-list |
| `AI_HARNESS_ALLOWED_ORIGINS`          | `http://localhost:4318,http://127.0.0.1:4318` | Comma-separated origins that may call the daemon           |
| `NEXT_PUBLIC_AI_HARNESS_DAEMON_URL`   | `http://127.0.0.1:4317`                       | Where the browser finds the daemon                         |

**Upgrading from AgentForge.** AI Harness was previously called AgentForge. Existing setups keep working without changes:

- `AGENTFORGE_*` variables (including `NEXT_PUBLIC_AGENTFORGE_DAEMON_URL`) are still read when the `AI_HARNESS_*` one is unset. The daemon logs a deprecation notice for each one.
- If `~/.ai-harness` doesn't exist but `~/.agentforge` does, the daemon keeps using `~/.agentforge` (and its `agentforge.db`), so projects and encrypted secrets are kept. To switch, stop the daemon and rename the folder to `~/.ai-harness`.
- Projects that already have a `.agentforge/` folder keep using it. New projects get `.ai-harness/`.

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
