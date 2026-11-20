import { describe, expect, it } from 'vitest';
import { planRemaining, remainingMs, spentNow, type TaskTimingDto } from '../src/estimate';

const MIN = 60_000;
const timing = (estimateMin: number, spentMin = 0, runningSince: number | null = null) =>
  ({
    estimateMs: estimateMin * MIN,
    estimateBasis: 'default',
    spentMs: spentMin * MIN,
    runningSince,
    startedAt: null,
    finishedAt: null,
  }) satisfies TaskTimingDto;
const task = (id: string, status: string, t: TaskTimingDto, dependsOn: string[] = []) => ({
  id,
  status,
  dependsOn,
  timing: t,
});

describe('estimates', () => {
  it('counts a run in progress and never drops below 10% while unfinished', () => {
    expect(spentNow(timing(10, 2, 1000), 1000 + 3 * MIN)).toBe(5 * MIN);
    expect(remainingMs(task('a', 'IN_REVIEW', timing(10, 4)))).toBe(6 * MIN);
    expect(remainingMs(task('a', 'IN_REVIEW', timing(10, 30)))).toBe(1 * MIN);
    expect(remainingMs(task('a', 'DONE', timing(10)))).toBe(0);
  });

  it('takes the longer of the critical path and the work spread over parallel slots', () => {
    // a(10) → b(20) is a 30m chain; c(10) and d(10) can run alongside it.
    const tasks = [
      task('a', 'APPROVED', timing(10)),
      task('b', 'DRAFT', timing(20), ['a']),
      task('c', 'DRAFT', timing(10)),
      task('d', 'DRAFT', timing(10)),
      task('e', 'DONE', timing(50)),
      task('f', 'CANCELLED', timing(50)),
    ];
    expect(planRemaining(tasks, 2)).toEqual({ workMs: 50 * MIN, etaMs: 30 * MIN });
    expect(planRemaining(tasks, 1)).toEqual({ workMs: 50 * MIN, etaMs: 50 * MIN });
    // A done dependency doesn't add to the chain.
    expect(
      planRemaining([task('x', 'DONE', timing(5)), task('y', 'DRAFT', timing(5), ['x'])], 1),
    ).toEqual({ workMs: 5 * MIN, etaMs: 5 * MIN });
  });
});
