import { z } from 'zod';
import { AUTH_STATUSES, TASK_STATUSES } from './enums';
import { AppSettingsSchema } from './settings';
import { ProjectSummarySchema } from './entities';
import type { GithubStatus } from './projects';
import type { AgentEvent, AgentRunResultDto, EngineInfo, TerminalInfo } from './engines';
import type { ChatMessageDto, PlanDto, PlannerState, TaskDto } from './planning';

/**
 * Every event that flows over the EventBus/WebSocket. Add new events here;
 * daemon emitters and web listeners are both typed from this map.
 */
export const EventPayloads = {
  'settings.updated': z.object({ settings: AppSettingsSchema }),
  notification: z.object({
    level: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string(),
    message: z.string().optional(),
    projectId: z.string().optional(),
    taskId: z.string().optional(),
  }),
  'project.created': z.object({ project: ProjectSummarySchema }),
  'project.updated': z.object({ project: ProjectSummarySchema }),
  'project.deleted': z.object({ projectId: z.string() }),
  'project.onboarding': z.object({
    projectId: z.string(),
    status: z.enum(['pending', 'running', 'done', 'failed', 'skipped']),
    error: z.string().nullable(),
  }),
  'github.status_changed': z.object({ status: z.custom<GithubStatus>() }),
  'engine.updated': z.object({ engine: z.custom<EngineInfo>() }),
  'chat.message': z.object({ projectId: z.string(), message: z.custom<ChatMessageDto>() }),
  'planner.state': z.object({ state: z.custom<PlannerState>() }),
  'plan.updated': z.object({ projectId: z.string(), plan: z.custom<PlanDto>() }),
  'task.updated': z.object({ projectId: z.string(), task: z.custom<TaskDto>() }),
  'task.deleted': z.object({ projectId: z.string(), taskId: z.string() }),
  'engine.removed': z.object({ engineId: z.string() }),
  /** High-volume, transient: not kept in the replay buffer. */
  'run.event': z.object({ runId: z.string(), event: z.custom<AgentEvent>() }),
  'run.finished': z.object({ runId: z.string(), result: z.custom<AgentRunResultDto>() }),
  /** High-volume, transient: replay comes from the terminal's scrollback. */
  'terminal.output': z.object({ terminalId: z.string(), data: z.string() }),
  'terminal.exit': z.object({ terminalId: z.string(), exitCode: z.number().int().nullable() }),
  'terminal.created': z.object({ terminal: z.custom<TerminalInfo>() }),
  'task.status_changed': z.object({
    projectId: z.string(),
    taskId: z.string(),
    from: z.enum(TASK_STATUSES),
    to: z.enum(TASK_STATUSES),
    reason: z.string().nullable(),
  }),
  'engine.status_changed': z.object({
    engineId: z.string(),
    status: z.enum(AUTH_STATUSES),
    resetAt: z.number().int().nullable(),
  }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EVENT_TYPES = Object.keys(EventPayloads) as EventType[];
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export interface AppEvent<T extends EventType = EventType> {
  /** Monotonic per-daemon-process sequence number. */
  seq: number;
  /** Daemon boot id — a change means sequence numbers restarted. */
  epoch: string;
  type: T;
  topics: string[];
  ts: number;
  payload: EventPayload<T>;
}

/** Discriminated union of all concrete events (useful for `switch (e.type)`). */
export type AnyAppEvent = { [K in EventType]: AppEvent<K> }[EventType];

export const Topics = {
  global: 'global',
  project: (id: string) => `project:${id}`,
  task: (id: string) => `task:${id}`,
  run: (id: string) => `run:${id}`,
  terminal: (id: string) => `terminal:${id}`,
} as const;

export const TopicSchema = z
  .string()
  .regex(/^(global|(project|task|run|terminal):[A-Za-z0-9_-]{1,64})$/, 'Invalid topic');
