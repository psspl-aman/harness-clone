import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  statusProgress,
  TASK_STATUSES,
} from '../src';

describe('task state machine', () => {
  it('walks the happy path', () => {
    const path = [
      'DRAFT',
      'APPROVED',
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'DOCUMENTING',
      'DONE',
    ] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  it('supports the fix loop from review and testing', () => {
    expect(canTransition('IN_REVIEW', 'FIXING')).toBe(true);
    expect(canTransition('IN_TESTING', 'FIXING')).toBe(true);
    expect(canTransition('FIXING', 'IN_REVIEW')).toBe(true);
    expect(canTransition('FIXING', 'IN_TESTING')).toBe(true);
  });

  it('rejects skipping steps and leaving DONE', () => {
    expect(canTransition('DRAFT', 'IN_DEVELOPMENT')).toBe(false);
    expect(canTransition('IN_DEVELOPMENT', 'DONE')).toBe(false);
    for (const s of TASK_STATUSES) expect(canTransition('DONE', s)).toBe(false);
    expect(() => assertTransition('DRAFT', 'DONE')).toThrow(InvalidTransitionError);
  });

  it('allows pausing, failing and escalating any active task', () => {
    for (const s of [
      'QUEUED',
      'IN_DEVELOPMENT',
      'IN_REVIEW',
      'IN_TESTING',
      'FIXING',
      'DOCUMENTING',
    ] as const) {
      for (const to of [
        'PAUSED_QUOTA',
        'PAUSED_AUTH',
        'PAUSED_MANUAL',
        'FAILED',
        'NEEDS_HUMAN',
        'CANCELLED',
      ] as const) {
        expect(canTransition(s, to), `${s}→${to}`).toBe(true);
      }
    }
    expect(canTransition('DRAFT', 'PAUSED_QUOTA')).toBe(false);
  });

  it('resumes a paused task only to the step it was paused from', () => {
    expect(canTransition('PAUSED_QUOTA', 'IN_TESTING', 'IN_TESTING')).toBe(true);
    expect(canTransition('PAUSED_QUOTA', 'IN_REVIEW', 'IN_TESTING')).toBe(false);
    expect(canTransition('PAUSED_QUOTA', 'IN_TESTING')).toBe(false);
    expect(canTransition('PAUSED_QUOTA', 'PAUSED_MANUAL')).toBe(true);
    expect(canTransition('PAUSED_AUTH', 'CANCELLED')).toBe(true);
  });

  it('lets failed / needs-human tasks be retried', () => {
    expect(canTransition('FAILED', 'QUEUED')).toBe(true);
    expect(canTransition('NEEDS_HUMAN', 'FIXING')).toBe(true);
  });

  it('supports merge conflicts, merge review and retrying a failed step', () => {
    expect(canTransition('DOCUMENTING', 'BLOCKED')).toBe(true);
    expect(canTransition('BLOCKED', 'DONE')).toBe(true);
    expect(canTransition('NEEDS_HUMAN', 'DONE')).toBe(true);
    expect(canTransition('NEEDS_HUMAN', 'BLOCKED')).toBe(true); // approved merge hit conflicts
    expect(canTransition('FAILED', 'IN_REVIEW', 'IN_REVIEW')).toBe(true);
    expect(canTransition('NEEDS_HUMAN', 'IN_TESTING', 'IN_TESTING')).toBe(true);
    expect(canTransition('FAILED', 'IN_REVIEW')).toBe(false);
    expect(canTransition('FAILED', 'DONE', 'DONE')).toBe(false);
    expect(canTransition('IN_REVIEW', 'BLOCKED')).toBe(false);
  });

  it('computes step progress', () => {
    expect(statusProgress('DRAFT')).toBe(0);
    expect(statusProgress('DONE')).toBe(1);
    expect(statusProgress('FIXING')).toBe(statusProgress('IN_REVIEW'));
    expect(statusProgress('PAUSED_QUOTA', 'IN_TESTING')).toBe(statusProgress('IN_TESTING'));
    expect(statusProgress('FAILED')).toBe(0);
  });
});
