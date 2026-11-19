import type { TaskStatus } from './enums';

/**
 * Allowed task status transitions. The orchestrator is the only writer of
 * task status and must go through `assertTransition` so history stays valid.
 */
const PIPELINE: Record<TaskStatus, readonly TaskStatus[]> = {
  DRAFT: ['APPROVED', 'CANCELLED'],
  APPROVED: ['QUEUED', 'DRAFT', 'BLOCKED', 'CANCELLED'],
  QUEUED: ['IN_DEVELOPMENT', 'BLOCKED', 'APPROVED'],
  // DONE: work merged through a follow-up conflict-resolution task.
  BLOCKED: ['QUEUED', 'APPROVED', 'DONE', 'CANCELLED'],
  IN_DEVELOPMENT: ['IN_REVIEW'],
  IN_REVIEW: ['IN_TESTING', 'FIXING'],
  IN_TESTING: ['DOCUMENTING', 'FIXING'],
  FIXING: ['IN_REVIEW', 'IN_TESTING'],
  // BLOCKED: merge conflict handed to a conflict-resolution task.
  DOCUMENTING: ['DONE', 'BLOCKED'],
  DONE: [],
  PAUSED_QUOTA: [],
  PAUSED_AUTH: [],
  PAUSED_MANUAL: [],
  // DONE: you approved the merge ("require my review before merge").
  NEEDS_HUMAN: ['QUEUED', 'FIXING', 'CANCELLED', 'DONE', 'BLOCKED'],
  FAILED: ['QUEUED', 'CANCELLED', 'FIXING'],
  CANCELLED: ['DRAFT'],
};

/** States in which an agent is actively working on the task. */
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'IN_DEVELOPMENT',
  'IN_REVIEW',
  'IN_TESTING',
  'FIXING',
  'DOCUMENTING',
];

export const PAUSED_STATUSES: readonly TaskStatus[] = [
  'PAUSED_QUOTA',
  'PAUSED_AUTH',
  'PAUSED_MANUAL',
];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['DONE', 'CANCELLED'];

export const isActive = (s: TaskStatus) => ACTIVE_STATUSES.includes(s);
export const isPaused = (s: TaskStatus) => PAUSED_STATUSES.includes(s);
export const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.includes(s);

/**
 * Whether `from → to` is legal.
 *
 * Cross-cutting rules on top of the pipeline table:
 * - Any active or queued task can be paused (manual / quota / auth), fail,
 *   escalate to NEEDS_HUMAN, or be cancelled.
 * - A paused task can only resume to the status it was paused from
 *   (`resumeTo`), or be cancelled.
 */
export function canTransition(from: TaskStatus, to: TaskStatus, resumeTo?: TaskStatus): boolean {
  if (from === to) return false;
  if (isPaused(from)) {
    if (to === 'CANCELLED') return true;
    if (isPaused(to)) return true; // e.g. quota pause becomes manual pause
    return resumeTo !== undefined && to === resumeTo;
  }
  // Retry: a failed or escalated task may go back to the step it stopped at.
  if (
    (from === 'FAILED' || from === 'NEEDS_HUMAN') &&
    resumeTo !== undefined &&
    to === resumeTo &&
    isActive(to)
  )
    return true;
  if (isActive(from) || from === 'QUEUED') {
    if (isPaused(to) || to === 'FAILED' || to === 'NEEDS_HUMAN' || to === 'CANCELLED') return true;
  }
  return PIPELINE[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: TaskStatus,
    readonly to: TaskStatus,
  ) {
    super(`Invalid task transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus, resumeTo?: TaskStatus): void {
  if (!canTransition(from, to, resumeTo)) throw new InvalidTransitionError(from, to);
}

/** Step index for progress bars: 0..1 across the happy path. */
const PROGRESS_ORDER: readonly TaskStatus[] = [
  'DRAFT',
  'APPROVED',
  'QUEUED',
  'IN_DEVELOPMENT',
  'IN_REVIEW',
  'IN_TESTING',
  'DOCUMENTING',
  'DONE',
];

export function statusProgress(status: TaskStatus, resumeTo?: TaskStatus | null): number {
  let effective = isPaused(status) && resumeTo ? resumeTo : status;
  if (effective === 'FIXING') effective = 'IN_REVIEW';
  const idx = PROGRESS_ORDER.indexOf(effective);
  return idx < 0 ? 0 : idx / (PROGRESS_ORDER.length - 1);
}
