import { z } from 'zod';
import { AUTH_STATUSES, TASK_STATUSES } from './enums';
import { AppSettingsSchema } from './settings';
import { ProjectSummarySchema } from './entities';

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
