import { z } from 'zod';
import type { AgentRole, EngineErrorKind, MemoryKind, RunStatus } from './enums';
import { MEMORY_KINDS } from './enums';

// ─── Persisted per-task pipeline state (tasks.pipeline_state) ────────────────

export interface PipelineState {
  /** Commit the task branch started from (diff base). */
  baseCommit?: string;
  /** What the next fix addresses and where it returns to. */
  fixSource?: 'review' | 'tests' | 'human';
  /** Role currently running, if any (also tells the UI what is happening). */
  activeRole?: AgentRole | null;
  activeEngine?: string | null;
  activeRunId?: string | null;
  /** Most recent CLI session per role (used to resume or steer). */
  sessions?: Partial<Record<AgentRole, string>>;
  /** Messages from the user to deliver to the agent on its next run. */
  notes?: string[];
  lastReviewId?: string | null;
  lastTestResultId?: string | null;
  /** Set while waiting for "require my review before merge". */
  awaitingMergeReview?: boolean;
  /** Why the task is blocked when it isn't about dependencies. */
  blockedBy?: { kind: 'conflict'; taskId: string } | null;
  /** For conflict-resolution tasks: the task whose branch they continue. */
  conflictOf?: string | null;
  /** For conflict-resolution tasks: files that conflicted. */
  conflictFiles?: string[];
  mergeCommit?: string | null;
  mergedInto?: string | null;
  lastError?: { kind: EngineErrorKind | 'MERGE' | 'VERIFY'; message: string } | null;
}

export interface TaskPipelineDto {
  branch: string | null;
  fixLoops: number;
  activeRole: AgentRole | null;
  activeEngine: string | null;
  activeRunId: string | null;
  awaitingMergeReview: boolean;
  blockedReason: string | null;
  pullRequestUrl: string | null;
  resumeAt: number | null;
  tokens: number;
  costUsd: number;
  lastError: string | null;
}

// ─── Structured role outputs ─────────────────────────────────────────────────

export const REVIEW_SEVERITIES = ['info', 'minor', 'major', 'blocker'] as const;

export const ReviewOutputSchema = z.object({
  verdict: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? v
            .trim()
            .toUpperCase()
            .replace(/[\s-]+/g, '_')
        : v,
    z.enum(['APPROVE', 'CHANGES_REQUESTED']),
  ),
  summary: z.string().trim().min(1).max(4000),
  comments: z
    .array(
      z.object({
        file: z.string().trim().max(500).nullable().optional(),
        line: z.coerce.number().int().positive().nullable().optional(),
        severity: z.preprocess(
          (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
          z.enum(REVIEW_SEVERITIES),
        ),
        body: z.string().trim().min(1).max(4000),
      }),
    )
    .max(50)
    .default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

export const TestOutputSchema = z.object({
  passed: z.boolean(),
  summary: z.string().trim().min(1).max(4000),
  total: z.number().int().nonnegative().nullable().optional(),
  failed: z.number().int().nonnegative().nullable().optional(),
  skipped: z.number().int().nonnegative().nullable().optional(),
  buildPassed: z.boolean().nullable().optional(),
  commands: z.array(z.string().max(500)).max(20).default([]),
  failures: z.array(z.string().max(2000)).max(30).default([]),
  testsAdded: z.array(z.string().max(500)).max(50).default([]),
});
export type TestOutput = z.infer<typeof TestOutputSchema>;

export const DocOutputSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  report: z.string().trim().min(1).max(20_000),
  docsUpdated: z.array(z.string().max(500)).max(30).default([]),
  limitations: z.array(z.string().max(1000)).max(20).default([]),
  memory: z
    .array(
      z.object({
        kind: z.preprocess(
          (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
          z.enum(MEMORY_KINDS),
        ),
        title: z.string().trim().min(1).max(200),
        content: z.string().trim().min(1).max(4000),
      }),
    )
    .max(5)
    .default([]),
});
export type DocOutput = z.infer<typeof DocOutputSchema>;

// ─── Read models for the task drawer ─────────────────────────────────────────

export interface RunSummaryDto {
  id: string;
  role: AgentRole;
  engineId: string;
  model: string | null;
  attempt: number;
  status: RunStatus;
  resultSummary: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  filesChanged: string[];
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

export interface ReviewDto {
  id: string;
  reviewer: 'agent' | 'human';
  verdict: 'APPROVE' | 'CHANGES_REQUESTED';
  summary: string;
  comments: {
    id: string;
    filePath: string | null;
    line: number | null;
    severity: (typeof REVIEW_SEVERITIES)[number];
    body: string;
    resolved: boolean;
  }[];
  createdAt: number;
}

export interface TestResultDto {
  id: string;
  passed: boolean;
  total: number | null;
  failed: number | null;
  skipped: number | null;
  buildPassed: boolean | null;
  commands: string[];
  summary: string;
  log: string;
  createdAt: number;
}

export interface DiffFileDto {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface TaskDiffDto {
  base: string | null;
  head: string | null;
  files: DiffFileDto[];
  patch: string;
  truncated: boolean;
}

export interface TaskReportDto {
  id: string;
  title: string;
  content: string;
  updatedAt: number;
}

export interface PipelineStatusDto {
  projectId: string;
  paused: boolean;
  running: {
    taskId: string;
    key: string;
    role: AgentRole | null;
    engineId: string | null;
    runId: string | null;
  }[];
  queued: number;
  limit: number;
}

export const SteerInputSchema = z.object({ message: z.string().trim().min(1).max(8000) });
export const RequestChangesInputSchema = z.object({ comments: z.string().trim().min(1).max(8000) });

export type { MemoryKind };
