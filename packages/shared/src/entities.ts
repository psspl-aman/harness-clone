import { z } from 'zod';
import { PROJECT_ORIGINS, PROJECT_SOURCES } from './enums';

/** Dates travel over the wire as epoch milliseconds. */
export const Timestamp = z.number().int();

export const ProjectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  origin: z.enum(PROJECT_ORIGINS),
  source: z.enum(PROJECT_SOURCES),
  localPath: z.string(),
  githubRepo: z.string().nullable(),
  stack: z.array(z.string()),
  runningStatus: z.enum(['stopped', 'starting', 'running', 'crashed']),
  taskCounts: z.object({
    total: z.number().int(),
    active: z.number().int(),
    done: z.number().int(),
  }),
  openErrorCount: z.number().int(),
  lastActivityAt: Timestamp.nullable(),
  /** Set while the project is archived: hidden from the dashboard, nothing runs, restorable. */
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const SystemInfoSchema = z.object({
  name: z.literal('ai-harness'),
  version: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  homeDir: z.string(),
  dbPath: z.string(),
  workspaceRoot: z.string(),
  startedAt: Timestamp,
  uptimeSec: z.number(),
  wsClients: z.number().int(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
