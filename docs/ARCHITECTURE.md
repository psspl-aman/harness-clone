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

## Web app

- **Providers:** `next-themes` (light, dark or system), TanStack Query, `TooltipProvider`, `LiveProvider` (owns the WebSocket and maps events to cache updates and toasts), and Sonner toasts.
- **Shell:**
  - A collapsible sidebar (⌘B) with a live connection pill.
  - A top bar with the ⌘K command palette and the theme switch.
  - "g then key" navigation (`g p` for Projects, `g s` for Settings).
  - An animated banner whenever the daemon is unreachable.
- **Pages:**
  - Projects dashboard: cards show source, stack, task progress, run status, an error badge and last activity.
  - Settings: a draft-and-diff form that sends only changed fields, validates client-side with the shared schema, and picks up changes made elsewhere live.
